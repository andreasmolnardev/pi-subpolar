export type QueueEntryKind = 'steering' | 'follow_up'
export type QueueEntryState = 'steering' | 'enqueued' | 'delivered' | 'failed' | 'cancelled'

export type QueueEntry = {
  ownerId: string
  sessionId: string
  clientId: string
  content: string
  kind: QueueEntryKind
  state: QueueEntryState
  position: number
  createdAt: number
  updatedAt: number
  error?: string
}

type QueueDatabase = {
  query: (sql: string) => {
    run: (...parameters: any[]) => unknown
    get: (...parameters: any[]) => unknown
    all: (...parameters: any[]) => unknown
  }
  transaction: <T>(callback: () => T) => () => T
}

const selectEntry = `SELECT owner_id, session_id, client_id, content, kind, state, position, created_at, updated_at, error
  FROM message_queue WHERE owner_id = ? AND session_id = ? AND client_id = ?`

const stateOf = (value: unknown): QueueEntryState =>
  value === 'steering' || value === 'enqueued' || value === 'delivered' || value === 'failed' || value === 'cancelled'
    ? value : 'failed'

const kindOf = (value: unknown): QueueEntryKind => value === 'steering' ? 'steering' : 'follow_up'

export function queueEntryFromRow(row: Record<string, unknown>): QueueEntry {
  return {
    ownerId: String(row.owner_id), sessionId: String(row.session_id), clientId: String(row.client_id),
    content: String(row.content), kind: kindOf(row.kind), state: stateOf(row.state), position: Number(row.position),
    createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
    ...(typeof row.error === 'string' ? { error: row.error } : {}),
  }
}

export class QueueEntryConflictError extends Error {
  readonly code = 'QUEUE_ID_REUSED'
  constructor() { super('clientId is already associated with different queue content'); this.name = 'QueueEntryConflictError' }
}

export class QueueEntryTransitionError extends Error {
  readonly code = 'QUEUE_INVALID_TRANSITION'
  constructor(readonly kind: QueueEntryKind, readonly from: QueueEntryState, readonly to: QueueEntryState) {
    super(`Cannot transition ${kind} queue entry from ${from} to ${to}`)
    this.name = 'QueueEntryTransitionError'
  }
}

function transitionAllowed(kind: QueueEntryKind, from: QueueEntryState, to: QueueEntryState): boolean {
  if (kind === 'steering') {
    return (from === 'steering' && (to === 'delivered' || to === 'failed' || to === 'cancelled'))
      || (from === 'enqueued' && to === 'steering')
      || ((from === 'failed' || from === 'cancelled') && to === 'enqueued')
  }
  if (from === 'enqueued' && to === 'steering') return true
  if (from === 'steering' && (to === 'delivered' || to === 'failed' || to === 'cancelled')) return true
  return (from === 'failed' || from === 'cancelled') && to === 'enqueued'
}

export function reserveQueueEntry(database: QueueDatabase, ownerId: string, sessionId: string, clientId: string, content: string, kind: QueueEntryKind): { entry: QueueEntry; created: boolean } {
  const transaction = database.transaction(() => {
    const now = Date.now()
    const result = database.query(
      'INSERT OR IGNORE INTO message_queue (owner_id, session_id, client_id, content, kind, state, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, COALESCE((SELECT MAX(position) + 1 FROM message_queue WHERE owner_id = ? AND session_id = ?), 0), ?, ?)',
    ).run(ownerId, sessionId, clientId, content, kind, kind === 'steering' ? 'steering' : 'enqueued', ownerId, sessionId, now, now) as { changes?: number }
    const row = database.query(selectEntry).get(ownerId, sessionId, clientId) as Record<string, unknown> | null
    if (!row) throw new Error('Queue entry could not be stored')
    const entry = queueEntryFromRow(row)
    if (entry.content !== content || entry.kind !== kind) throw new QueueEntryConflictError()
    return { entry, created: result.changes === 1 }
  })
  return transaction()
}

export function listQueueEntries(database: QueueDatabase, ownerId: string, sessionId: string): QueueEntry[] {
  return (database.query('SELECT owner_id, session_id, client_id, content, kind, state, position, created_at, updated_at, error FROM message_queue WHERE owner_id = ? AND session_id = ? AND state IN (?, ?, ?) ORDER BY position, created_at').all(ownerId, sessionId, 'steering', 'enqueued', 'failed') as Array<Record<string, unknown>>).map(queueEntryFromRow)
}

export function updateQueueEntry(database: QueueDatabase, ownerId: string, sessionId: string, clientId: string, state: QueueEntryState, error?: string): QueueEntry | null {
  const transaction = database.transaction(() => {
    const currentRow = database.query(selectEntry).get(ownerId, sessionId, clientId) as Record<string, unknown> | null
    if (!currentRow) return null
    const current = queueEntryFromRow(currentRow)
    if (!transitionAllowed(current.kind, current.state, state)) throw new QueueEntryTransitionError(current.kind, current.state, state)
    database.query('UPDATE message_queue SET state = ?, error = ?, updated_at = ? WHERE owner_id = ? AND session_id = ? AND client_id = ? AND state = ?').run(state, error ?? null, Date.now(), ownerId, sessionId, clientId, current.state)
    const row = database.query(selectEntry).get(ownerId, sessionId, clientId) as Record<string, unknown> | null
    return row ? queueEntryFromRow(row) : null
  })
  return transaction()
}

export function claimQueueEntry(database: QueueDatabase, ownerId: string, sessionId: string, clientId: string): QueueEntry | null {
  const result = database.query(
    'UPDATE message_queue SET state = ?, error = NULL, updated_at = ? WHERE owner_id = ? AND session_id = ? AND client_id = ? AND kind = ? AND state = ?',
  ).run('steering', Date.now(), ownerId, sessionId, clientId, 'follow_up', 'enqueued') as { changes?: number }
  if (result.changes !== 1) return null
  const row = database.query(selectEntry).get(ownerId, sessionId, clientId) as Record<string, unknown> | null
  return row ? queueEntryFromRow(row) : null
}

export function reorderQueueEntry(database: QueueDatabase, ownerId: string, sessionId: string, clientId: string, position: number): QueueEntry | null {
  database.query('UPDATE message_queue SET position = ?, updated_at = ? WHERE owner_id = ? AND session_id = ? AND client_id = ? AND state = ?').run(Math.max(0, Math.floor(position)), Date.now(), ownerId, sessionId, clientId, 'enqueued')
  const row = database.query(selectEntry).get(ownerId, sessionId, clientId) as Record<string, unknown> | null
  return row ? queueEntryFromRow(row) : null
}

export function clearQueue(database: QueueDatabase, ownerId: string, sessionId: string): void {
  database.query('UPDATE message_queue SET state = ?, updated_at = ? WHERE owner_id = ? AND session_id = ? AND state IN (?, ?)').run('cancelled', Date.now(), ownerId, sessionId, 'enqueued', 'failed')
}
