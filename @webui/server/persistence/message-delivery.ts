export type MessageDeliveryState = 'pending' | 'running' | 'completed' | 'interrupted' | 'unknown'

export type MessageDeliveryResponse = {
  ok: boolean
  messageID: string
  state: MessageDeliveryState
  error?: {
    code: 'DELIVERY_INTERRUPTED' | 'DELIVERY_UNKNOWN'
    message: string
    recoverable: true
  }
}

export type MessageDelivery = {
  ownerId: string
  sessionId: string
  messageId: string
  content: string
  metadata: string
  state: MessageDeliveryState
  createdAt: number
  updatedAt: number
  replayResponse?: unknown
}

type DeliveryDatabase = {
  query: (sql: string) => {
    run: (...parameters: any[]) => unknown
    get: (...parameters: any[]) => unknown
  }
  transaction: <T>(callback: () => T) => () => T
}

const deliverySelect = 'SELECT owner_id, session_id, message_id, content, metadata, state, created_at, updated_at, response FROM message_deliveries WHERE owner_id = ? AND session_id = ? AND message_id = ?'

export class MessageDeliveryConflictError extends Error {
  readonly code = 'MESSAGE_ID_REUSED'

  constructor() {
    super('messageID is already associated with a different prompt')
    this.name = 'MessageDeliveryConflictError'
  }
}

export function messageDeliveryState(value: unknown): MessageDeliveryState {
  if (value === 'pending' || value === 'running' || value === 'completed' || value === 'interrupted' || value === 'unknown') {
    return value
  }
  return 'pending'
}

/** A bridge restart makes the outcome of a running prompt unknowable. */
export function reconcileRunningDeliveries(database: DeliveryDatabase, now = Date.now()): void {
  database.query(
    'UPDATE message_deliveries SET state = ?, updated_at = ? WHERE state = ?',
  ).run('interrupted', now, 'running')
}

export function messageDeliveryFromRow(row: Record<string, unknown>): MessageDelivery {
  const state = messageDeliveryState(row.state)
  const delivery: MessageDelivery = {
    ownerId: String(row.owner_id),
    sessionId: String(row.session_id),
    messageId: String(row.message_id),
    content: String(row.content),
    metadata: String(row.metadata),
    state,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
  if (typeof row.response === 'string') {
    try {
      delivery.replayResponse = JSON.parse(row.response)
    } catch {
      // An invalid persisted response falls back to the legacy delivery shape.
    }
  }
  return delivery
}

export function messageDeliveryMatches(delivery: Pick<MessageDelivery, 'content' | 'metadata'>, content: string, metadata: Record<string, unknown>): boolean {
  return delivery.content === content && delivery.metadata === JSON.stringify(metadata)
}

/** Reserve a message ID and validate a concurrent reuse in one SQLite transaction. */
export function reserveMessageDelivery(
  database: DeliveryDatabase,
  ownerId: string,
  sessionId: string,
  messageId: string,
  content: string,
  metadata: Record<string, unknown>,
): { delivery: MessageDelivery; created: boolean } {
  const serializedMetadata = JSON.stringify(metadata)
  const transaction = database.transaction(() => {
    const result = database.query(
      'INSERT OR IGNORE INTO message_deliveries (owner_id, session_id, message_id, content, metadata, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(ownerId, sessionId, messageId, content, serializedMetadata, 'pending', Date.now(), Date.now()) as { changes?: number }
    const row = database.query(deliverySelect).get(ownerId, sessionId, messageId) as Record<string, unknown> | null
    if (!row) throw new Error('Message delivery could not be stored')
    const delivery = messageDeliveryFromRow(row)
    if (!messageDeliveryMatches(delivery, content, metadata)) throw new MessageDeliveryConflictError()
    return { delivery, created: result.changes === 1 }
  })
  return transaction()
}

export function messageDeliveryResponse(delivery: { messageId: string; state: MessageDeliveryState }): MessageDeliveryResponse {
  if (delivery.state === 'interrupted' || delivery.state === 'unknown') {
    return {
      ok: false,
      messageID: delivery.messageId,
      state: delivery.state,
      error: {
        code: delivery.state === 'interrupted' ? 'DELIVERY_INTERRUPTED' : 'DELIVERY_UNKNOWN',
        message: 'This delivery was interrupted before its outcome was known. It was not retried automatically. Resend the prompt to try again.',
        recoverable: true,
      },
    }
  }
  return { ok: true, messageID: delivery.messageId, state: delivery.state }
}

export function replayMessageDeliveryResponse(delivery: MessageDelivery): Record<string, unknown> | MessageDeliveryResponse {
  if (Object.prototype.hasOwnProperty.call(delivery, 'replayResponse')) {
    return withDeliveryMetadata(delivery.replayResponse, messageDeliveryResponse(delivery))
  }
  return messageDeliveryResponse(delivery)
}

/** Preserve every native RPC field while appending delivery status. */
export function withDeliveryMetadata(response: unknown, delivery: MessageDeliveryResponse): Record<string, unknown> {
  if (response && typeof response === 'object' && !Array.isArray(response)) {
    return { ...(response as Record<string, unknown>), delivery }
  }
  return { response, delivery }
}
