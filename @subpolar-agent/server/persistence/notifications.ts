import type PocketBase from 'pocketbase'
import { createCipheriv, createHmac, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { escapeFilter } from './pocketbase.ts'
import { sanitizeDeepLink, type InboxItem } from './inbox.ts'
import { redactSensitive, redactSensitiveText } from '../core/security-redaction.ts'
import { fetchWithNetworkPolicy, NetworkPolicyError, readBoundedResponse } from '../core/network-policy.ts'

export type NotificationSubscriptionProjection = { id: string; owner_id: string; channel: 'push' | 'email'; endpoint: string; deviceName?: string; enabled: boolean; created_at: number }
type PushKeys = { p256dh: string; auth: string }
type StoredPushSubscription = { endpoint: string; keys?: PushKeys; deviceName?: string }
export type NotificationDeliverySubscription = NotificationSubscriptionProjection & { keys?: PushKeys }
export type NotificationInboxProjection = { id: string; kind: InboxItem['kind']; reference_id: string; title: string; body?: string; deep_link?: Record<string, string>; resolved: boolean; underlying_state?: string; metadata?: unknown; created_at: number }
export type NotificationFailureClass = 'retryable' | 'permanent'
export type NotificationAdapter = (subscription: NotificationDeliverySubscription, item: NotificationInboxProjection) => Promise<void>
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
const base64url = (value: Uint8Array | Buffer) => Buffer.from(value).toString('base64url')

function decodeBase64url(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid push subscription key')
  return Buffer.from(value, 'base64url')
}

function storedSubscription(value: unknown, channel: string): StoredPushSubscription {
  if (channel !== 'push' || typeof value !== 'string') return { endpoint: typeof value === 'string' ? value : '' }
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>
    const endpoint = typeof parsed.endpoint === 'string' ? parsed.endpoint : ''
    const rawKeys = parsed.keys && typeof parsed.keys === 'object' ? parsed.keys as Record<string, unknown> : undefined
    const keys = typeof rawKeys?.p256dh === 'string' && typeof rawKeys.auth === 'string'
      ? { p256dh: rawKeys.p256dh, auth: rawKeys.auth }
      : undefined
    return { endpoint, ...(keys ? { keys } : {}), ...(typeof parsed.deviceName === 'string' ? { deviceName: parsed.deviceName } : {}) }
  } catch {
    // Older installations stored just the push endpoint. Keep those rows visible
    // so a device can be re-registered, but they cannot receive encrypted pushes.
    return { endpoint: value }
  }
}

function hkdfExtract(salt: Uint8Array, input: Uint8Array): Buffer {
  return createHmac('sha256', salt).update(input).digest()
}

function hkdfExpand(prk: Uint8Array, info: Uint8Array, length: number): Buffer {
  const chunks: Buffer[] = []
  let previous = Buffer.alloc(0)
  for (let counter = 1; Buffer.concat(chunks).length < length; counter += 1) {
    previous = createHmac('sha256', prk).update(previous).update(info).update(Buffer.from([counter])).digest()
    chunks.push(previous)
  }
  return Buffer.concat(chunks).subarray(0, length)
}

function vapidKeys(): { publicKey: Buffer; privateKey: ReturnType<typeof createPrivateKey> } {
  const publicValue = process.env.VAPID_PUBLIC_KEY?.trim()
  const privateValue = process.env.VAPID_PRIVATE_KEY?.trim()
  if (!publicValue || !privateValue) throw Object.assign(new Error('Web Push is not configured'), { code: 'PUSH_NOT_CONFIGURED' })
  const publicKey = decodeBase64url(publicValue)
  if (publicKey.length !== 65 || publicKey[0] !== 4) throw Object.assign(new Error('VAPID public key is invalid'), { code: 'VAPID_KEY_INVALID' })
  let privateKey: ReturnType<typeof createPrivateKey>
  if (privateValue.includes('BEGIN')) {
    privateKey = createPrivateKey(privateValue)
  } else {
    const raw = decodeBase64url(privateValue)
    if (raw.length !== 32) throw Object.assign(new Error('VAPID private key is invalid'), { code: 'VAPID_KEY_INVALID' })
    const sec1Prefix = Buffer.from('30310201010420', 'hex')
    const curveOid = Buffer.from('a00a06082a8648ce3d030107', 'hex')
    privateKey = createPrivateKey({ key: Buffer.concat([sec1Prefix, raw, curveOid]), format: 'der', type: 'sec1' })
  }
  return { publicKey, privateKey }
}

function vapidAuthorization(endpoint: URL): { authorization: string; publicKey: Buffer } {
  const keys = vapidKeys()
  const publicText = base64url(keys.publicKey)
  const header = base64url(Buffer.from(JSON.stringify({ alg: 'ES256', typ: 'JWT' })))
  const claims = base64url(Buffer.from(JSON.stringify({
    aud: endpoint.origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
    sub: process.env.VAPID_SUBJECT?.trim() || 'mailto:admin@subpolar.local',
  })))
  const input = `${header}.${claims}`
  const signature = sign('sha256', Buffer.from(input), { key: keys.privateKey, dsaEncoding: 'ieee-p1363' })
  return { authorization: `vapid t=${input}.${base64url(signature)}, k=${publicText}`, publicKey: keys.publicKey }
}

function encryptPushPayload(payload: unknown, receiverPublicKey: Buffer, authSecret: Buffer): Buffer {
  const receiverDer = Buffer.concat([Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex'), receiverPublicKey])
  const receiverKey = createPublicKey({ key: receiverDer, format: 'der', type: 'spki' })
  const ephemeral = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const senderDer = ephemeral.publicKey.export({ format: 'der', type: 'spki' }) as Buffer
  const senderPublicKey = senderDer.subarray(senderDer.length - 65)
  const sharedSecret = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: receiverKey })
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), receiverPublicKey, senderPublicKey])
  const inputKeyMaterial = hkdfExpand(hkdfExtract(authSecret, sharedSecret), keyInfo, 32)
  const salt = randomBytes(16)
  const contentKey = hkdfExpand(hkdfExtract(salt, inputKeyMaterial), Buffer.from('Content-Encoding: aes128gcm\0'), 16)
  const nonce = hkdfExpand(hkdfExtract(salt, inputKeyMaterial), Buffer.from('Content-Encoding: nonce\0'), 12)
  const plaintext = Buffer.concat([Buffer.from(JSON.stringify(payload)), Buffer.from([2])])
  const cipher = createCipheriv('aes-128-gcm', contentKey, nonce)
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()])
  const recordSize = Buffer.alloc(4)
  recordSize.writeUInt32BE(4096)
  return Buffer.concat([salt, recordSize, Buffer.from([senderPublicKey.length]), senderPublicKey, ciphertext])
}

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
  const stored = storedSubscription(value.target, String(value.channel))
  return {
    id: String(value.id),
    owner_id: ownerId,
    channel: value.channel === 'push' ? 'push' : 'email',
    endpoint: bounded(stored.endpoint, 2048) ?? '',
    ...(stored.deviceName ? { deviceName: bounded(stored.deviceName, 100) } : {}),
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

function notificationUrl(deepLink: Record<string, string> | undefined): string {
  const path = deepLink?.path ?? '/'
  const params = new URLSearchParams()
  if (path.endsWith('/automations') && deepLink?.automationId) {
    params.set('jobId', deepLink.automationId)
    params.set('automationTab', 'runs')
  }
  if (path.endsWith('/automations') && deepLink?.runId) params.set('runId', deepLink.runId)
  const query = params.toString()
  return query ? `${path}?${query}` : path
}

export function createPushNotificationAdapter(options: { timeoutMs?: number; resolver?: (hostname: string) => Promise<readonly string[]> } = {}): NotificationAdapter {
  return async (subscription, item) => {
    if (subscription.channel !== 'push' || !subscription.keys) throw Object.assign(new Error('Push subscription keys are missing'), { code: 'PUSH_SUBSCRIPTION_INVALID' })
    let endpoint: URL
    try { endpoint = new URL(subscription.endpoint) } catch { throw Object.assign(new Error('Push endpoint is invalid'), { code: 'PUSH_ENDPOINT_INVALID' }) }
    if (endpoint.protocol !== 'https:') throw Object.assign(new Error('Push endpoint must use HTTPS'), { code: 'PUSH_ENDPOINT_INVALID' })
    const receiverPublicKey = decodeBase64url(subscription.keys.p256dh)
    const authSecret = decodeBase64url(subscription.keys.auth)
    if (receiverPublicKey.length !== 65 || receiverPublicKey[0] !== 4 || authSecret.length !== 16) throw Object.assign(new Error('Push subscription keys are invalid'), { code: 'PUSH_SUBSCRIPTION_INVALID' })
    const vapid = vapidAuthorization(endpoint)
    const payload = {
      title: item.title,
      body: item.body ?? '',
      tag: `subpolar-${item.kind}-${item.reference_id}`,
      data: { url: notificationUrl(item.deep_link) },
    }
    const body = encryptPushPayload(payload, receiverPublicKey, authSecret)
    const response = await fetchWithNetworkPolicy(endpoint, {
      method: 'POST',
      headers: {
        authorization: vapid.authorization,
        'content-encoding': 'aes128gcm',
        'content-type': 'application/octet-stream',
        ttl: '86400',
      },
      body: new Uint8Array(body),
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
    throw Object.assign(new Error(`Push endpoint returned HTTP ${response.status}`), { code: 'PUSH_DELIVERY_FAILED', status: response.status, failureClass: retryable ? 'retryable' : 'permanent' })
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
  const leaseExpiresAt = timestamp(delivery.lease_expires_at)
  if (leaseExpiresAt !== undefined && leaseExpiresAt > now) return false
  const nextAttemptAt = timestamp(delivery.next_attempt_at)
  if (nextAttemptAt !== undefined) {
    if (nextAttemptAt > now) return false
  } else {
    const lastActivity = timestamp(delivery.updated_at) ?? timestamp(delivery.created_at)
    if (lastActivity === undefined || now - lastActivity < PENDING_RECOVERY_AFTER) return false
  }
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
    if (this.options.scope === 'process') return await work()
    if (this.options.scope !== 'durable') throw new Error('Durable notification serialization capability unavailable')
    if (this.options.transaction) return await this.options.transaction(work as () => Promise<unknown>) as Record<string, unknown> | null
    if (this.options.serialize) return await this.options.serialize(`notification-delivery:${id}`, work as () => Promise<unknown>) as Record<string, unknown> | null
    throw new Error('Durable notification serialization capability unavailable')
  }

  async subscribe(ownerId: string, input: { channel: 'push' | 'email'; target: string }): Promise<NotificationSubscriptionProjection> {
    const owner = assertOwner(ownerId)
    const rawInput = input as typeof input & { keys?: PushKeys; deviceName?: string }
    if (typeof input.target !== 'string' || input.target.trim().length > 2048 || CONTROL_CHARACTERS.test(input.target) || !['push', 'email'].includes(input.channel)) throw new Error('Invalid notification subscription')
    const endpoint = bounded(input.target, 2048)
    if (!endpoint) throw new Error('Invalid notification subscription')
    if (input.channel === 'push') {
      let endpoint: URL
      try { endpoint = new URL(input.target.trim()) } catch { throw new Error('Push notification endpoint must be a valid HTTPS URL') }
      if (endpoint.protocol !== 'https:') throw new Error('Push notification endpoint must be a valid HTTPS URL')
    }
    const deviceName = typeof rawInput.deviceName === 'string' ? bounded(rawInput.deviceName, 100) : undefined
    const keys = rawInput.keys
    if (keys) {
      if (typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string' || keys.p256dh.length > 200 || keys.auth.length > 100) throw new Error('Invalid push subscription keys')
      const publicKey = decodeBase64url(keys.p256dh)
      const authSecret = decodeBase64url(keys.auth)
      if (publicKey.length !== 65 || publicKey[0] !== 4 || authSecret.length !== 16) throw new Error('Invalid push subscription keys')
    }
    const target = input.channel === 'push'
      ? JSON.stringify({ endpoint, ...(keys ? { keys } : {}), ...(deviceName ? { deviceName } : {}) })
      : endpoint
    const rows = await this.client.collection('notification_subscriptions').getFullList({ filter: `owner_id = "${escapeFilter(owner)}"` }) as Record<string, unknown>[]
    const existing = rows.find((row) => row.owner_id === owner && row.channel === input.channel && storedSubscription(row.target, String(row.channel)).endpoint === endpoint)
    const saved = existing
      ? await this.client.collection('notification_subscriptions').update(String(existing.id), { target, enabled: true })
      : await this.client.collection('notification_subscriptions').create({ owner_id: owner, channel: input.channel, target, enabled: true, created_at: Date.now() })
    return subscriptionProjection(saved, owner)
  }

  async list(ownerId: string): Promise<NotificationSubscriptionProjection[]> {
    const owner = assertOwner(ownerId)
    const rows = await this.client.collection('notification_subscriptions').getFullList({ filter: `owner_id = "${escapeFilter(owner)}"`, sort: '-created_at' }) as Record<string, unknown>[]
    return rows.filter((row) => row.owner_id === owner).map((row) => subscriptionProjection(row, owner))
  }

  async remove(ownerId: string, id: string): Promise<boolean> {
    const owner = assertOwner(ownerId)
    const row = await this.client.collection('notification_subscriptions').getOne(id).catch(() => null) as Record<string, unknown> | null
    if (!row || row.owner_id !== owner) return false
    await this.client.collection('notification_subscriptions').delete(id)
    return true
  }

  async removeByEndpoint(ownerId: string, endpoint: string): Promise<boolean> {
    const owner = assertOwner(ownerId)
    const rows = await this.client.collection('notification_subscriptions').getFullList({ filter: `owner_id = "${escapeFilter(owner)}"` }) as Record<string, unknown>[]
    const row = rows.find((item) => item.owner_id === owner && storedSubscription(item.target, String(item.channel)).endpoint === endpoint)
    if (!row) return false
    await this.client.collection('notification_subscriptions').delete(String(row.id))
    return true
  }

  async deliver(ownerId: string, item: InboxItem, adapter: NotificationAdapter = createPushNotificationAdapter(), options: { force?: boolean } = {}): Promise<number> {
    const owner = assertOwner(ownerId)
    if (!item || item.owner_id !== owner) throw new Error('Inbox item is not owned by the notification owner')
    const preferencesRecord = await this.client.collection('user_preferences').getFirstListItem(`user_id = "${escapeFilter(owner)}"`).catch(() => null) as Record<string, unknown> | null
    const preferences = preferencesRecord?.preferences && typeof preferencesRecord.preferences === 'object' ? preferencesRecord.preferences as Record<string, unknown> : {}
    const notificationPreferences = preferences.notifications && typeof preferences.notifications === 'object' ? preferences.notifications as Record<string, unknown> : {}
    const eventPreferences = notificationPreferences.events && typeof notificationPreferences.events === 'object' ? notificationPreferences.events as Record<string, unknown> : {}
    const eventKey = item.kind === 'approval_required' || item.kind === 'browser_approval' || item.kind === 'review_required' || item.underlying_state === 'review_required' ? 'permissionAsked'
      : item.kind === 'agent_question' ? 'questionAsked'
        : item.kind === 'task_failed' || item.underlying_state === 'failed' || item.underlying_state === 'interrupted' ? 'sessionError'
          : 'sessionIdle'
    const eventEnabled = eventPreferences[eventKey] === undefined ? eventKey !== 'sessionIdle' : eventPreferences[eventKey] === true
    if (!options.force && (notificationPreferences.enabled !== true || !eventEnabled)) return 0
    const deliveredCount = await withDeliveryLock(this.client as unknown as object, `${owner}:${item.id}`, async () => {
      const stored = await this.client.collection('inbox_items').getOne(item.id).catch(() => null) as Record<string, unknown> | null
      if (!stored || stored.owner_id !== owner) throw new Error('Inbox item is not owned by the notification owner')
      const subscriptions = await this.client.collection('notification_subscriptions').getFullList({ filter: `owner_id = "${escapeFilter(owner)}" && enabled = true` }) as Record<string, unknown>[]
      const deliveries = await this.client.collection('notification_deliveries').getFullList({ filter: `owner_id = "${escapeFilter(owner)}" && inbox_id = "${escapeFilter(String(stored.id))}"` }) as Record<string, unknown>[]
      let delivered = 0
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
        const subscriptionData = storedSubscription(subscription.target, String(subscription.channel))
        const projectedSubscription = { ...subscriptionProjection(subscription, owner), ...(subscriptionData.keys ? { keys: subscriptionData.keys } : {}) }
        const projectedItem = inboxProjection(stored as unknown as InboxItem)
        try {
          await adapter(projectedSubscription, projectedItem)
            await this.client.collection('notification_deliveries').update(String(reserved.id), { state: 'delivered', lease_id: null, lease_expires_at: null, updated_at: Date.now() })
            delivered += 1
         } catch (error) {
             const now = Date.now()
             const status = error && typeof error === 'object' ? (error as Record<string, unknown>).status : undefined
             if (status === 404 || status === 410) await this.client.collection('notification_subscriptions').update(String(subscription.id), { enabled: false })
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
       return delivered
     })
    return deliveredCount
  }

  async sweepDue(adapter: NotificationAdapter, now = Date.now()): Promise<number> {
    const rows = await this.client.collection('notification_deliveries').getFullList({ filter: 'state = "pending"' }) as Record<string, unknown>[]
    let processed = 0
    for (const row of rows) {
      if (!pendingIsRecoverable(row, now)) continue
      const owner = typeof row.owner_id === 'string' ? row.owner_id : ''
      const inbox = typeof row.inbox_id === 'string' ? await this.client.collection('inbox_items').getOne(row.inbox_id).catch(() => null) as InboxItem | null : null
      if (!owner || !inbox || inbox.owner_id !== owner) continue
      await this.deliver(owner, inbox, adapter)
      processed += 1
    }
    return processed
  }
}
