import type PocketBase from 'pocketbase'
import type { RecordModel } from 'pocketbase'
import { escapeFilter } from './pocketbase.ts'
import { MessageDeliveryConflictError, type MessageDelivery, type MessageDeliveryState } from './message-delivery.ts'
import { QueueEntryTransitionError, type QueueEntry, type QueueEntryKind, type QueueEntryState } from './message-queue.ts'
import type { RuntimeRun, RuntimeRunState } from './runtime-recovery.ts'
import { redactSensitive } from '../core/security-redaction.ts'

function collection(client: PocketBase, name: string) {
  return client.collection(name) as unknown as {
    create: (data: Record<string, unknown>) => Promise<RecordModel & Record<string, unknown>>
    getOne: (id: string) => Promise<RecordModel & Record<string, unknown>>
    getFirstListItem: (filter: string, options?: Record<string, unknown>) => Promise<RecordModel & Record<string, unknown>>
    getFullList: (options?: Record<string, unknown>) => Promise<Array<RecordModel & Record<string, unknown>>>
    update: (id: string, data: Record<string, unknown>) => Promise<RecordModel & Record<string, unknown>>
    delete: (id: string) => Promise<boolean>
  }
}

function filter(value: string): string {
  return escapeFilter(value)
}

function firstOrNull<T>(operation: () => Promise<T>): Promise<T | null> {
  return operation().catch(() => null)
}

function deliveryFromRecord(record: Record<string, unknown>): MessageDelivery {
  return {
    ownerId: String(record.owner_id), sessionId: String(record.session_id), messageId: String(record.message_id), content: String(record.content),
    metadata: typeof record.metadata === 'string' ? record.metadata : JSON.stringify(record.metadata ?? {}),
    state: record.state as MessageDeliveryState, createdAt: Number(record.created_at), updatedAt: Number(record.updated_at),
    ...(record.response !== undefined && record.response !== null ? { replayResponse: record.response } : {}),
  }
}

function queueFromRecord(record: Record<string, unknown>): QueueEntry {
  return {
    ownerId: String(record.owner_id), sessionId: String(record.session_id), clientId: String(record.client_id), content: String(record.content),
    kind: record.kind as QueueEntryKind, state: record.state as QueueEntryState, position: Number(record.position),
    createdAt: Number(record.created_at), updatedAt: Number(record.updated_at), ...(typeof record.error === 'string' ? { error: record.error } : {}),
  }
}

function queueTransitionAllowed(kind: QueueEntryKind, from: QueueEntryState, to: QueueEntryState): boolean {
  if (kind === 'steering') {
    return (from === 'steering' && (to === 'delivered' || to === 'failed' || to === 'cancelled'))
      || (from === 'enqueued' && to === 'steering')
      || ((from === 'failed' || from === 'cancelled') && to === 'enqueued')
  }
  if (from === 'enqueued' && to === 'steering') return true
  if (from === 'steering' && (to === 'delivered' || to === 'failed' || to === 'cancelled')) return true
  return (from === 'failed' || from === 'cancelled') && to === 'enqueued'
}

function runtimeFromRecord(record: Record<string, unknown>): RuntimeRun {
  return {
    ownerId: String(record.owner_id), sessionId: String(record.session_id), runId: String(record.run_id),
    ...(typeof record.request_id === 'string' ? { requestId: record.request_id } : {}), state: record.state as RuntimeRunState,
    createdAt: Number(record.created_at), updatedAt: Number(record.updated_at), ...(typeof record.error === 'string' ? { error: record.error } : {}),
  }
}

export type DurableEventRecord = {
  id: number
  ownerId: string
  sessionId: string | null
  type: string
  payload: unknown
  occurredAt: number
}

export class PocketBaseRuntimeStore {
  constructor(private readonly client: PocketBase) {}

  private deliveryFilter(ownerId: string, sessionId: string, messageId: string): string {
    return `owner_id = "${filter(ownerId)}" && session_id = "${filter(sessionId)}" && message_id = "${filter(messageId)}"`
  }

  async getMessageDelivery(ownerId: string, sessionId: string, messageId: string): Promise<MessageDelivery | null> {
    const record = await firstOrNull(() => collection(this.client, 'message_deliveries').getFirstListItem(this.deliveryFilter(ownerId, sessionId, messageId)))
    return record ? deliveryFromRecord(record) : null
  }

  async getLatestPendingMessageDelivery(ownerId: string, sessionId: string): Promise<MessageDelivery | null> {
    const records = await collection(this.client, 'message_deliveries').getFullList({ filter: `owner_id = "${filter(ownerId)}" && session_id = "${filter(sessionId)}" && state = "pending"`, sort: '-updated_at', batch: 1 })
    return records[0] ? deliveryFromRecord(records[0]) : null
  }

  async reserveMessageDelivery(ownerId: string, sessionId: string, messageId: string, content: string, metadata: Record<string, unknown>): Promise<{ delivery: MessageDelivery; created: boolean }> {
    const serializedMetadata = JSON.stringify(metadata)
    const existing = await this.getMessageDelivery(ownerId, sessionId, messageId)
    if (existing) {
      if (existing.content !== content || existing.metadata !== serializedMetadata) throw new MessageDeliveryConflictError()
      return { delivery: existing, created: false }
    }
    try {
      const record = await collection(this.client, 'message_deliveries').create({ owner_id: ownerId, session_id: sessionId, message_id: messageId, content, metadata, state: 'pending', created_at: Date.now(), updated_at: Date.now() })
      return { delivery: deliveryFromRecord(record), created: true }
    } catch {
      const raced = await this.getMessageDelivery(ownerId, sessionId, messageId)
      if (!raced) throw new Error('Message delivery could not be stored')
      if (raced.content !== content || raced.metadata !== serializedMetadata) throw new MessageDeliveryConflictError()
      return { delivery: raced, created: false }
    }
  }

  async claimMessageDelivery(delivery: MessageDelivery): Promise<MessageDelivery | null> {
    const current = await this.getMessageDelivery(delivery.ownerId, delivery.sessionId, delivery.messageId)
    if (!current || current.state !== 'pending') return null
    const record = await collection(this.client, 'message_deliveries').getFirstListItem(this.deliveryFilter(delivery.ownerId, delivery.sessionId, delivery.messageId))
    const updated = await collection(this.client, 'message_deliveries').update(record.id, { state: 'running', updated_at: Date.now() })
    return deliveryFromRecord(updated)
  }

  async completeMessageDelivery(delivery: MessageDelivery, response: unknown): Promise<void> {
    const record = await firstOrNull(() => collection(this.client, 'message_deliveries').getFirstListItem(this.deliveryFilter(delivery.ownerId, delivery.sessionId, delivery.messageId)))
    if (!record) return
    await collection(this.client, 'message_deliveries').update(record.id, { state: 'completed', response: redactSensitive(response), updated_at: Date.now() })
  }

  async interruptMessageDelivery(delivery: MessageDelivery): Promise<void> {
    const record = await firstOrNull(() => collection(this.client, 'message_deliveries').getFirstListItem(this.deliveryFilter(delivery.ownerId, delivery.sessionId, delivery.messageId)))
    if (!record) return
    await collection(this.client, 'message_deliveries').update(record.id, { state: 'interrupted', updated_at: Date.now() })
  }

  private queueFilter(ownerId: string, sessionId: string, clientId: string): string {
    return `owner_id = "${filter(ownerId)}" && session_id = "${filter(sessionId)}" && client_id = "${filter(clientId)}"`
  }

  async reserveQueueEntry(ownerId: string, sessionId: string, clientId: string, content: string, kind: QueueEntryKind): Promise<{ entry: QueueEntry; created: boolean }> {
    const existing = await firstOrNull(() => collection(this.client, 'message_queue').getFirstListItem(this.queueFilter(ownerId, sessionId, clientId)))
    if (existing) {
      const entry = queueFromRecord(existing)
      if (entry.content !== content || entry.kind !== kind) throw new Error('QUEUE_ID_REUSED')
      return { entry, created: false }
    }
    const current = await collection(this.client, 'message_queue').getFullList({ filter: `owner_id = "${filter(ownerId)}" && session_id = "${filter(sessionId)}"`, sort: '-position', batch: 1 })
    const position = current[0] ? Number(current[0].position) + 1 : 0
    try {
      const record = await collection(this.client, 'message_queue').create({ owner_id: ownerId, session_id: sessionId, client_id: clientId, content, kind, state: kind === 'steering' ? 'steering' : 'enqueued', position, created_at: Date.now(), updated_at: Date.now() })
      return { entry: queueFromRecord(record), created: true }
    } catch {
      const raced = await collection(this.client, 'message_queue').getFirstListItem(this.queueFilter(ownerId, sessionId, clientId))
      const entry = queueFromRecord(raced)
      if (entry.content !== content || entry.kind !== kind) throw new Error('QUEUE_ID_REUSED')
      return { entry, created: false }
    }
  }

  async listQueueEntries(ownerId: string, sessionId: string): Promise<QueueEntry[]> {
    const records = await collection(this.client, 'message_queue').getFullList({ filter: `owner_id = "${filter(ownerId)}" && session_id = "${filter(sessionId)}" && (state = "steering" || state = "enqueued" || state = "failed")`, sort: 'position,created_at' })
    return records.map(queueFromRecord)
  }

  async updateQueueEntry(ownerId: string, sessionId: string, clientId: string, state: QueueEntryState, error?: string): Promise<QueueEntry | null> {
    const record = await firstOrNull(() => collection(this.client, 'message_queue').getFirstListItem(this.queueFilter(ownerId, sessionId, clientId)))
    if (!record) return null
    const current = queueFromRecord(record)
    if (!queueTransitionAllowed(current.kind, current.state, state)) throw new QueueEntryTransitionError(current.kind, current.state, state)
    const updated = await collection(this.client, 'message_queue').update(record.id, { state, error: error ?? '', updated_at: Date.now() })
    return queueFromRecord(updated)
  }

  async claimQueueEntry(ownerId: string, sessionId: string, clientId: string): Promise<QueueEntry | null> {
    const record = await firstOrNull(() => collection(this.client, 'message_queue').getFirstListItem(`${this.queueFilter(ownerId, sessionId, clientId)} && kind = "follow_up" && state = "enqueued"`))
    if (!record) return null
    return queueFromRecord(await collection(this.client, 'message_queue').update(record.id, { state: 'steering', error: '', updated_at: Date.now() }))
  }

  async reorderQueueEntry(ownerId: string, sessionId: string, clientId: string, position: number): Promise<QueueEntry | null> {
    const record = await firstOrNull(() => collection(this.client, 'message_queue').getFirstListItem(`${this.queueFilter(ownerId, sessionId, clientId)} && state = "enqueued"`))
    if (!record) return null
    return queueFromRecord(await collection(this.client, 'message_queue').update(record.id, { position: Math.max(0, Math.floor(position)), updated_at: Date.now() }))
  }

  async clearQueue(ownerId: string, sessionId: string): Promise<void> {
    const records = await collection(this.client, 'message_queue').getFullList({ filter: `owner_id = "${filter(ownerId)}" && session_id = "${filter(sessionId)}" && (state = "enqueued" || state = "failed")` })
    await Promise.all(records.map((record) => collection(this.client, 'message_queue').update(record.id, { state: 'cancelled', updated_at: Date.now() })))
  }

  async reserveRuntimeRun(ownerId: string, sessionId: string, runId: string, requestId?: string): Promise<{ run: RuntimeRun; created: boolean }> {
    const runFilter = `owner_id = "${filter(ownerId)}" && session_id = "${filter(sessionId)}" && run_id = "${filter(runId)}"`
    const existing = await firstOrNull(() => collection(this.client, 'runtime_runs').getFirstListItem(runFilter))
    if (existing) return { run: runtimeFromRecord(existing), created: false }
    try {
      const created = await collection(this.client, 'runtime_runs').create({ owner_id: ownerId, session_id: sessionId, run_id: runId, request_id: requestId ?? '', state: 'starting', created_at: Date.now(), updated_at: Date.now() })
      return { run: runtimeFromRecord(created), created: true }
    } catch {
      const raced = await collection(this.client, 'runtime_runs').getFirstListItem(runFilter)
      return { run: runtimeFromRecord(raced), created: false }
    }
  }

  async updateRuntimeRun(ownerId: string, sessionId: string, runId: string, state: RuntimeRunState, error?: unknown): Promise<RuntimeRun | null> {
    const record = await firstOrNull(() => collection(this.client, 'runtime_runs').getFirstListItem(`owner_id = "${filter(ownerId)}" && session_id = "${filter(sessionId)}" && run_id = "${filter(runId)}"`))
    if (!record) return null
    return runtimeFromRecord(await collection(this.client, 'runtime_runs').update(record.id, { state, error: error instanceof Error ? error.message.slice(0, 1000) : '', updated_at: Date.now() }))
  }

  async reconcileStartup(): Promise<void> {
    const now = Date.now()
    const [deliveries, steering, runs] = await Promise.all([
      collection(this.client, 'message_deliveries').getFullList({ filter: 'state = "running"' }),
      collection(this.client, 'message_queue').getFullList({ filter: 'kind = "steering" && state = "steering"' }),
      collection(this.client, 'runtime_runs').getFullList({ filter: 'state = "starting" || state = "running" || state = "waiting_for_approval"' }),
    ])
    await Promise.all([
      ...deliveries.map((record) => collection(this.client, 'message_deliveries').update(record.id, { state: 'interrupted', updated_at: now })),
      ...steering.map((record) => collection(this.client, 'message_queue').update(record.id, { state: 'failed', error: 'QUEUE_INTERRUPTED', updated_at: now })),
      ...runs.map((record) => collection(this.client, 'runtime_runs').update(record.id, { state: 'unknown', updated_at: now })),
    ])
  }

  async appendEvent(ownerId: string, sessionId: string | null, value: unknown): Promise<DurableEventRecord> {
    const safe = redactSensitive(value)
    let payload = JSON.stringify(safe)
    if (payload.length > 64 * 1024) payload = JSON.stringify({ type: 'event.redacted', properties: { reason: 'payload_too_large' } })
    const latest = await collection(this.client, 'durable_events').getFullList({ filter: `owner_id = "${filter(ownerId)}"`, sort: '-cursor', batch: 1 })
    const cursor = latest[0] ? Number(latest[0].cursor) + 1 : 1
    const record = await collection(this.client, 'durable_events').create({ owner_id: ownerId, cursor, session_id: sessionId ?? '', type: typeof (safe as { type?: unknown })?.type === 'string' ? (safe as { type: string }).type : 'event', payload: JSON.parse(payload), occurred_at: Date.now(), payload_bytes: payload.length })
    await this.pruneEvents(ownerId)
    return { id: cursor, ownerId, sessionId, type: String(record.type), payload: record.payload, occurredAt: Number(record.occurred_at) }
  }

  async replayEvents(ownerId: string, afterValue: string | null | undefined): Promise<{ events: DurableEventRecord[]; reset: boolean; resetCursor: number | null }> {
    const after = afterValue && /^\d+$/.test(afterValue) ? Number(afterValue) : 0
    const records = await collection(this.client, 'durable_events').getFullList({ filter: `owner_id = "${filter(ownerId)}" && cursor > ${after}`, sort: 'cursor' })
    const oldest = await collection(this.client, 'durable_events').getFullList({ filter: `owner_id = "${filter(ownerId)}"`, sort: 'cursor', batch: 1 })
    const oldestCursor = oldest[0] ? Number(oldest[0].cursor) : null
    const reset = Boolean(afterValue && oldestCursor !== null && after < oldestCursor - 1)
    const from = reset && oldestCursor !== null ? oldestCursor - 1 : after
    const selected = reset ? records.filter((record) => Number(record.cursor) > from) : records
    return { events: selected.map((record) => ({ id: Number(record.cursor), ownerId, sessionId: typeof record.session_id === 'string' && record.session_id ? record.session_id : null, type: String(record.type), payload: record.payload, occurredAt: Number(record.occurred_at) })), reset, resetCursor: reset ? from : null }
  }

  private async pruneEvents(ownerId: string): Promise<void> {
    const records = await collection(this.client, 'durable_events').getFullList({ filter: `owner_id = "${filter(ownerId)}"`, sort: '-cursor' })
    for (const record of records.slice(5000)) await collection(this.client, 'durable_events').delete(record.id)
  }
}
