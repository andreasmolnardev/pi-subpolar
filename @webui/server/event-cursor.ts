import type { Database } from 'bun:sqlite'
import { redactSensitive } from './security-redaction.ts'

export const EVENT_LOG_MAX_ROWS = 5000
export const EVENT_LOG_MAX_BYTES = 8 * 1024 * 1024
const MAX_PAYLOAD_BYTES = 64 * 1024

export type DurableEvent = {
  id: number
  ownerId: string
  sessionId: string | null
  type: string
  payload: unknown
  occurredAt: number
}

export type ReplayResult = { events: DurableEvent[]; reset: boolean; resetCursor: number | null }

type EventRow = { id: number; owner_id: string; session_id: string | null; type: string; payload: string; occurred_at: number }

function parseCursor(value: string | null | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) return null
  const cursor = Number(value)
  return Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : null
}

function eventFromRow(row: EventRow): DurableEvent {
  return { id: row.id, ownerId: row.owner_id, sessionId: row.session_id, type: row.type, payload: JSON.parse(row.payload), occurredAt: row.occurred_at }
}

export function ensureEventCursorSchema(database: Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS durable_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_id TEXT NOT NULL,
      session_id TEXT,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      occurred_at INTEGER NOT NULL,
      payload_bytes INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_durable_events_owner_id ON durable_events (owner_id, id);
    CREATE INDEX IF NOT EXISTS idx_durable_events_retention ON durable_events (id);
  `)
}

export function createEventCursor(database: Database, limits = { maxRows: EVENT_LOG_MAX_ROWS, maxBytes: EVENT_LOG_MAX_BYTES }) {
  ensureEventCursorSchema(database)

  function prune(): void {
    database.query('DELETE FROM durable_events WHERE id NOT IN (SELECT id FROM durable_events ORDER BY id DESC LIMIT ?)').run(limits.maxRows)
    const row = database.query('SELECT COALESCE(SUM(payload_bytes), 0) AS bytes FROM durable_events').get() as { bytes: number }
    if (row.bytes > limits.maxBytes) {
      database.query(`DELETE FROM durable_events WHERE id <= COALESCE((SELECT MAX(id) FROM durable_events WHERE (SELECT SUM(payload_bytes) FROM durable_events AS newer WHERE newer.id >= durable_events.id) > ?), -1)`).run(limits.maxBytes)
    }
  }

  function append(ownerId: string, sessionId: string | null, value: unknown): DurableEvent {
    const safe = redactSensitive(value)
    let payload = JSON.stringify(safe)
    if (payload.length > MAX_PAYLOAD_BYTES) payload = JSON.stringify({ type: 'event.redacted', properties: { reason: 'payload_too_large' } })
    database.query('INSERT INTO durable_events (owner_id, session_id, type, payload, occurred_at, payload_bytes) VALUES (?, ?, ?, ?, ?, ?)').run(
      ownerId, sessionId, typeof safe === 'object' && safe !== null && typeof (safe as { type?: unknown }).type === 'string' ? (safe as { type: string }).type : 'event', payload, Date.now(), payload.length,
    )
    prune()
    const row = database.query('SELECT id, owner_id, session_id, type, payload, occurred_at FROM durable_events WHERE rowid = last_insert_rowid()').get() as EventRow
    return eventFromRow(row)
  }

  function replay(ownerId: string, afterValue: string | null | undefined): ReplayResult {
    const after = parseCursor(afterValue)
    const oldest = database.query('SELECT MIN(id) AS id FROM durable_events WHERE owner_id = ?').get(ownerId) as { id: number | null }
    const reset = after !== null && oldest.id !== null && after < oldest.id - 1
    const from = reset && oldest.id !== null ? oldest.id - 1 : (after ?? 0)
    const rows = database.query('SELECT id, owner_id, session_id, type, payload, occurred_at FROM durable_events WHERE owner_id = ? AND id > ? ORDER BY id').all(ownerId, from) as EventRow[]
    return { events: rows.map(eventFromRow), reset, resetCursor: reset ? from : null }
  }

  return { append, replay, prune }
}

export type EventCursor = ReturnType<typeof createEventCursor>
