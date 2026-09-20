import type PocketBase from 'pocketbase'
import { escapeFilter } from './pocketbase.ts'
import { sanitizeDeepLink, type InboxItem } from './inbox.ts'
import { redactSensitive, redactSensitiveText } from './security-redaction.ts'
import { fetchWithNetworkPolicy, NetworkPolicyError, readBoundedResponse } from './network-policy.ts'

export type NotificationSubscriptionProjection = { id: string; owner_id: string; channel: 'push' | 'email'; target: string; enabled: boolean; created_at: number }
export type NotificationInboxProjection = { id: string; kind: InboxItem['kind']; reference_id: string; title: string; body?: string; deep_link?: Record<string, string>; resolved: boolean; underlying_state?: string; metadata?: unknown; created_at: number }
export type NotificationFailureClass = 'retryable' | 'permanent'
export type NotificationAdapter = (subscription: NotificationSubscriptionProjection, item: NotificationInboxProjection) => Promise<void>
export type NotificationPersistenceCapability = {
  scope?: 'process' | 'durable'
  serialize?: (key: string, work: () => Promise<unknown>) => Promise<unknown>
  transaction?: (work: () => Promise<unknown>) => Promise<unknown>
}
export type NotificationRepositoryOptions = NotificationPersistenceCapability

const MAX_FAILURE = 500
const MAX_NOTIFICATION_BODY = 4000
const MAX_NOTIFICATION_METADATA = 4000
const PENDING_RECOVERY_AFTER = 5 * 60 * 1000
const DELIVERY_LEASE_MS = 15 * 60 * 1000
const MAX_DELIVERY_ATTEMPTS = 3
const RETRY_BASE_MS = 1_000
const MAX_PUSH_RESPONSE_BYTES = 64 * 1024
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/
const deliveryLocks = new WeakMap<object, Map<string, Promise<void>>>()

async function withDeliveryLock<T>(client: object, key: string, work: () => Promise<T>): Promise<T> {
  let locks = deliveryLocks.get(client)
  if (!locks) { locks = new Map(); deliveryLocks.set(client, locks) }
  const previous = locks.get(key) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => { release = resolve })
  locks.set(key, current)
  await previous
  try { return await work() } finally { release(); if (locks.get(key) === current) locks.delete(key) }
}

function assertOwner(ownerId: string): string {
  if (typeof ownerId !== 'string' || !ownerId.trim() || ownerId.length > 200 || CONTROL_CHARACTERS.test(ownerId)) throw new Error('Notification owner is required')
  return ownerId.trim()
}

function bounded(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const safe = redactSensitiveText(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim()
  return safe ? safe.slice(0, max) : undefined
}

function subscriptionProjection(value: Record<string, unknown>, ownerId: string): NotificationSubscriptionProjection {
  return {
    id: String(value.id),
    owner_id: ownerId,
    channel: value.channel === 'push' ? 'push' : 'email',
    target: bounded(value.target, 320) ?? '',
    enabled: value.enabled === true,
    created_at: typeof value.created_at === 'number' ? value.created_at : 0,
  }
}

function metadataProjection(value: unknown): unknown {
  if (value === undefined) return undefined
  try {
    const safe = redactSensitive(value)
    return JSON.stringify(safe).length <= MAX_NOTIFICATION_METADATA ? safe : undefined
  } catch {
    return undefined
  }
}

function inboxProjection(item: InboxItem): NotificationInboxProjection {
  let deepLink: Record<string, string> | undefined
  try { deepLink = sanitizeDeepLink(item.deep_link) } catch { deepLink = undefined }
  const body = bounded(item.body, MAX_NOTIFICATION_BODY)
  const underlyingState = bounded(item.underlying_state, 200)
  const metadata = metadataProjection(item.metadata)
  return {
    id: String(item.id),
    kind: item.kind,
    reference_id: bounded(item.reference_id, 200) ?? '',
    title: bounded(item.title, 200) ?? '',
    ...(body === undefined ? {} : { body }),
    ...(deepLink === undefined ? {} : { deep_link: deepLink }),
    resolved: item.resolved === true,
    ...(underlyingState === undefined ? {} : { underlying_state: underlyingState }),
    ...(metadata === undefined ? {} : { metadata }),
    created_at: typeof item.created_at === 'number' ? item.created_at : 0,
  }
}

function failureProjection(error: unknown): string {
  const source = error && typeof error === 'object' ? error as Record<string, unknown> : {}
  const code = typeof source.code === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(source.code)
    ? source.code.toUpperCase()
    : 'NOTIFICATION_ADAPTER_FAILED'
  const message = error instanceof NetworkPolicyError
    ? 'Network request rejected by policy'
    : bounded(error instanceof Error ? error.message : typeof error === 'string' ? error : undefined, MAX_FAILURE - code.length - 2) ?? 'Notification adapter failed'
  return `${code}: ${message}`.slice(0, MAX_FAILURE)
}

function failureClass(error: unknown): NotificationFailureClass {
  if (error instanceof NetworkPolicyError) return ['TIMEOUT', 'DNS_RESOLUTION_FAILED'].includes(error.code) ? 'retryable' : 'permanent'
  const source = error && typeof error === 'object' ? error as Record<string, unknown> : {}
  return source.failureClass === 'retryable' ? 'retryable' : 'permanent'
}

function retryDelay(attempt: number): number {
  return Math.min(RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1), 60_000)
}

export function createPushNotificationAdapter(options: { timeoutMs?: number; resolver?: (hostname: string) => Promise<readonly string[]> } = {}): NotificationAdapter {
  return async (subscription, item) => {
    let endpoint: URL
    try { endpoint = new URL(subscription.target) } catch { throw Object.assign(new Error('Push endpoint is invalid'), { code: 'PUSH_ENDPOINT_INVALID' }) }
    if (endpoint.protocol !== 'https:') throw Object.assign(new Error('Push endpoint must use HTTPS'), { code: 'PUSH_ENDPOINT_INVALID' })
    const response = await fetchWithNetworkPolicy(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: item.title, body: item.body, deep_link: item.deep_link, kind: item.kind, reference_id: item.reference_id }),
    }, {
      allowedHosts: [endpoint.hostname],
      timeoutMs: options.timeoutMs ?? 5_000,
      maxResponseBytes: MAX_PUSH_RESPONSE_BYTES,
      maxRedirects: 0,
    }, undefined, options.resolver)
    if (response.ok) {
      await readBoundedResponse(response, MAX_PUSH_RESPONSE_BYTES)
      return
    }
    await readBoundedResponse(response, MAX_PUSH_RESPONSE_BYTES).catch(() => '')
    const retryable = response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500
    throw Object.assign(new Error(`Push endpoint returned HTTP ${response.status}`), { code: 'PUSH_DELIVERY_FAILED', failureClass: retryable ? 'retryable' : 'permanent' })
  }
}

function deliveryKey(ownerId: string, inboxId: string, subscriptionId: string): string {
  return JSON.stringify([ownerId, inboxId, subscriptionId])
}

function duplicateCreate(error: unknown): boolean {
  const source = error && typeof error === 'object' ? error as Record<string, unknown> : {}
  return source.status === 400 || source.code === 'validation_failed' || (typeof source.message === 'string' && /unique|duplicate/i.test(source.message))
}

function timestamp(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

function pendingIsRecoverable(delivery: Record<string, unknown>, now: number): boolean {
  if (delivery.state !== 'pending') return false
  if (typeof delivery.next_attempt_at === 'number' && delivery.next_attempt_at > now) return false
  const lastActivity = timestamp(delivery.updated_at) ?? timestamp(delivery.created_at)
  if (lastActivity === undefined || now - lastActivity < PENDING_RECOVERY_AFTER) return false
  const leaseExpiresAt = timestamp(delivery.lease_expires_at)
  if (leaseExpiresAt !== undefined && leaseExpiresAt > now) return false
  const attempt = typeof delivery.attempt === 'number' && Number.isInteger(delivery.attempt) ? delivery.attempt : 0
  return attempt < MAX_DELIVERY_ATTEMPTS
}

function capabilityFromClient(client: PocketBase): NotificationPersistenceCapability | undefined {
  return (client as unknown as { automationPersistence?: NotificationPersistenceCapability }).automationPersistence
}

export class NotificationRepository {
  private readonly options: NotificationRepositoryOptions

  constructor(private readonly client: PocketBase, options: NotificationRepositoryOptions = {}) {
    const capability = capabilityFromClient(client)
    this.options = { scope: capability?.scope ?? options.scope, serialize: options.serialize ?? capability?.serialize, transaction: options.transaction ?? capability?.transaction }
  }

  private async acquireStaleLease(id: string, now: number): Promise<Record<string, unknown> | null> {
    const work = async (): Promise<Record<string, unknown> | null> => {
      const current = await this.client.collection('notification_deliveries').getOne(id).catch(() => null) as Record<string, unknown> | null
      if (!current || !pendingIsRecoverable(current, now)) return null
      const leaseId = crypto.randomUUID()
       const attempt = typeof current.attempt === 'number' && Number.isInteger(current.attempt) ? current.attempt : 0
       await this.client.collection('notification_deliveries').update(id, { lease_id: leaseId, lease_expires_at: now + DELIVERY_LEASE_MS, attempt: attempt + 1, last_attempt_at: now, updated_at: now })
      const reserved = await this.client.collection('notification_deliveries').getOne(id).catch(() => null) as Record<string, unknown> | null
      return reserved && reserved.state === 'pending' && reserved.lease_id === leaseId ? reserved : null
    }
    if (this.options.scope !== 'durable') throw new Error('Durable notification serialization capability unavailable')
    if (this.options.transaction) return await this.options.transaction(work as () => Promise<unknown>) as Record<string, unknown> | null
    if (this.options.serialize) return await this.options.serialize(`notification-delivery:${id}`, work as () => Promise<unknown>) as Record<string, unknown> | null
    throw new Error('Durable notification serialization capability unavailable')
  }

  async subscribe(ownerId: string, input: { channel: 'push' | 'email'; target: string }): Promise<NotificationSubscriptionProjection> {
    const owner = assertOwner(ownerId)
    if (typeof input.target !== 'string' || input.target.trim().length > 320 || CONTROL_CHARACTERS.test(input.target) || !['push', 'email'].includes(input.channel)) throw new Error('Invalid notification subscription')
    const target = bounded(input.target, 320)
    if (!target) throw new Error('Invalid notification subscription')
    if (input.channel === 'push') {
      let endpoint: URL
      try { endpoint = new URL(target) } catch { throw new Error('Push notification endpoint must be a valid HTTPS URL') }
      if (endpoint.protocol !== 'https:') throw new Error('Push notification endpoint must be a valid HTTPS URL')
    }
    return subscriptionProjection(await this.client.collection('notification_subscriptions').create({ owner_id: owner, channel: input.channel, target, enabled: true, created_at: Date.now() }), owner)
  }

  async list(ownerId: string): Promise<NotificationSubscriptionProjection[]> {
    const owner = assertOwner(ownerId)
    const rows = await this.client.collection('notification_subscriptions').getFullList({ filter: `owner_id = "${escapeFilter(owner)}"`, sort: '-created_at' }) as Record<string, unknown>[]
    return rows.filter((row) => row.owner_id === owner).map((row) => subscriptionProjection(row, owner))
  }

  async deliver(ownerId: string, item: InboxItem, adapter: NotificationAdapter): Promise<void> {
    const owner = assertOwner(ownerId)
    if (!item || item.owner_id !== owner) throw new Error('Inbox item is not owned by the notification owner')
    await withDeliveryLock(this.client as unknown as object, `${owner}:${item.id}`, async () => {
      const stored = await this.client.collection('inbox_items').getOne(item.id).catch(() => null) as Record<string, unknown> | null
      if (!stored || stored.owner_id !== owner) throw new Error('Inbox item is not owned by the notification owner')
      const subscriptions = await this.client.collection('notification_subscriptions').getFullList({ filter: `owner_id = "${escapeFilter(owner)}" && enabled = true` }) as Record<string, unknown>[]
      const deliveries = await this.client.collection('notification_deliveries').getFullList({ filter: `owner_id = "${escapeFilter(owner)}" && inbox_id = "${escapeFilter(String(stored.id))}"` }) as Record<string, unknown>[]
      for (const subscription of subscriptions.filter((value) => value.owner_id === owner && value.enabled === true)) {
        const subscriptionId = String(subscription.id)
        const key = deliveryKey(owner, String(stored.id), subscriptionId)
        let existing = deliveries.find((delivery) => delivery.owner_id === owner && String(delivery.inbox_id) === String(stored.id) && String(delivery.subscription_id) === subscriptionId)
        if (existing) {
          const now = Date.now()
          const current = await this.client.collection('notification_deliveries').getOne(String(existing.id)).catch(() => null) as Record<string, unknown> | null
          if (!current || !pendingIsRecoverable(current, now)) continue
           try { existing = (await this.acquireStaleLease(String(current.id), now)) ?? undefined } catch { continue }
           if (!existing) continue
        }
        let reserved: Record<string, unknown>
        if (existing) {
          reserved = existing
        } else {
          const now = Date.now()
          try {
             reserved = await this.client.collection('notification_deliveries').create({ owner_id: owner, inbox_id: String(stored.id), subscription_id: subscriptionId, delivery_key: key, state: 'pending', attempt: 1, lease_id: crypto.randomUUID(), lease_expires_at: now + DELIVERY_LEASE_MS, last_attempt_at: now, created_at: now, updated_at: now }) as Record<string, unknown>
          } catch (error) {
            if (duplicateCreate(error)) continue
            throw error
          }
        }
        const projectedSubscription = subscriptionProjection(subscription, owner)
        const projectedItem = inboxProjection(stored as unknown as InboxItem)
        try {
          await adapter(projectedSubscription, projectedItem)
            await this.client.collection('notification_deliveries').update(String(reserved.id), { state: 'delivered', lease_id: null, lease_expires_at: null, updated_at: Date.now() })
         } catch (error) {
             const now = Date.now()
             const attempt = typeof reserved.attempt === 'number' ? reserved.attempt : 1
             const retry = failureClass(error) === 'retryable' && attempt < MAX_DELIVERY_ATTEMPTS
             await this.client.collection('notification_deliveries').update(String(reserved.id), {
               state: retry ? 'pending' : 'failed',
               error_message: failureProjection(error),
               failure_class: failureClass(error),
               next_attempt_at: retry ? now + retryDelay(attempt) : null,
               last_attempt_at: now,
               lease_id: null,
               lease_expires_at: null,
               updated_at: now,
             })
         }
       }
     })
   }

  async sweepDue(adapter: NotificationAdapter, now = Date.now()): Promise<number> {
    const rows = await this.client.collection('notification_deliveries').getFullList({ filter: `state = "pending" && next_attempt_at <= ${now}` }) as Record<string, unknown>[]
    let processed = 0
    for (const row of rows) {
      const owner = typeof row.owner_id === 'string' ? row.owner_id : ''
      const inbox = typeof row.inbox_id === 'string' ? await this.client.collection('inbox_items').getOne(row.inbox_id).catch(() => null) as InboxItem | null : null
      if (!owner || !inbox || inbox.owner_id !== owner) continue
      await this.deliver(owner, inbox, adapter)
      processed += 1
    }
    return processed
  }
}
