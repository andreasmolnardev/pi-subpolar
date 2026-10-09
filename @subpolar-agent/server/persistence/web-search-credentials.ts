import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import type PocketBase from 'pocketbase'
import type { RecordModel } from 'pocketbase'

export const WEB_SEARCH_CREDENTIALS_COLLECTION = 'web_search_credentials'
export const WEB_SEARCH_SECRET_KEY_ENV = 'SUBPOLAR_PROVIDER_SECRET_KEY'
export const WEB_SEARCH_KEY_PROVIDERS = ['exa', 'firecrawl', 'parallel'] as const
export type WebSearchKeyProvider = typeof WEB_SEARCH_KEY_PROVIDERS[number]
const ensuredCollections = new WeakSet<object>()

type CredentialRecord = RecordModel & Record<string, unknown>
type SecretPayload = Partial<Record<WebSearchKeyProvider, string>>
type CredentialCollection = {
  getFirstListItem(filter: string): Promise<CredentialRecord>
  create(data: Record<string, unknown>): Promise<CredentialRecord>
  update(id: string, data: Record<string, unknown>): Promise<CredentialRecord>
  delete(id: string): Promise<boolean>
}
type CollectionManager = {
  getOne(name: string): Promise<CredentialRecord>
  create(data: Record<string, unknown>): Promise<CredentialRecord>
  update(id: string, data: Record<string, unknown>): Promise<CredentialRecord>
}

function collection(client: PocketBase): CredentialCollection {
  return client.collection(WEB_SEARCH_CREDENTIALS_COLLECTION) as unknown as CredentialCollection
}

function keyFromEnvironment(): Buffer {
  const value = process.env[WEB_SEARCH_SECRET_KEY_ENV]?.trim() ?? ''
  const hex = value.startsWith('hex:') ? value.slice(4) : value
  if (/^[0-9a-f]{64}$/i.test(hex)) return Buffer.from(hex, 'hex')
  const base64 = value.startsWith('base64:') ? value.slice(7) : value
  if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(base64)) {
    const normalized = base64.replaceAll('-', '+').replaceAll('_', '/')
    const decoded = Buffer.from(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='), 'base64')
    if (decoded.byteLength === 32) return decoded
  }
  const utf8 = Buffer.from(value, 'utf8')
  if (utf8.byteLength === 32) return utf8
  throw new Error(`${WEB_SEARCH_SECRET_KEY_ENV} must decode to exactly 32 bytes`)
}

function aad(userId: string): Buffer {
  return Buffer.from(`subpolar/web-search-credentials/v1\0${userId}`, 'utf8')
}

function encrypt(payload: SecretPayload, userId: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', keyFromEnvironment(), iv)
  cipher.setAAD(aad(userId))
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()])
  return JSON.stringify({ v: 1, alg: 'aes-256-gcm', iv: iv.toString('base64url'), tag: cipher.getAuthTag().toString('base64url'), ciphertext: ciphertext.toString('base64url') })
}

function decrypt(value: string, userId: string): SecretPayload {
  const envelope = JSON.parse(value) as Record<string, unknown>
  if (envelope.v !== 1 || envelope.alg !== 'aes-256-gcm' || typeof envelope.iv !== 'string' || typeof envelope.tag !== 'string' || typeof envelope.ciphertext !== 'string') throw new Error('Invalid web search credential payload')
  const decipher = createDecipheriv('aes-256-gcm', keyFromEnvironment(), Buffer.from(envelope.iv, 'base64url'))
  decipher.setAAD(aad(userId))
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64url'))
  const plain = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64url')), decipher.final()]).toString('utf8')
  const payload = JSON.parse(plain) as Record<string, unknown>
  return Object.fromEntries(WEB_SEARCH_KEY_PROVIDERS.flatMap((provider) => typeof payload[provider] === 'string' ? [[provider, payload[provider]]] : []))
}

function escapeFilter(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'status' in error && (error as { status?: unknown }).status === 404
}

async function firstOrNull(operation: () => Promise<CredentialRecord>): Promise<CredentialRecord | null> {
  try { return await operation() } catch (error) { if (isNotFound(error)) return null; throw error }
}

export async function ensureWebSearchCredentialsCollection(client: PocketBase): Promise<void> {
  if (ensuredCollections.has(client)) return
  const manager = client.collections as unknown as CollectionManager
  const fields = [
    { name: 'user_id', type: 'text', required: true },
    { name: 'credential_payload', type: 'text', required: true },
    { name: 'updated_at', type: 'number', required: true },
  ]
  const index = 'CREATE UNIQUE INDEX idx_web_search_credentials_user ON web_search_credentials (user_id)'
  const rules = { listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null }
  const existing = await firstOrNull(() => manager.getOne(WEB_SEARCH_CREDENTIALS_COLLECTION))
  if (!existing) {
    try {
      await manager.create({ name: WEB_SEARCH_CREDENTIALS_COLLECTION, type: 'base', fields, indexes: [index], ...rules })
    } catch (error) {
      const raced = await firstOrNull(() => manager.getOne(WEB_SEARCH_CREDENTIALS_COLLECTION))
      if (!raced) throw error
    }
    ensuredCollections.add(client)
    return
  }
  const currentFields = Array.isArray(existing.fields) ? existing.fields.filter((field): field is Record<string, unknown> => typeof field === 'object' && field !== null) : []
  const currentIndexes = Array.isArray(existing.indexes) ? existing.indexes.filter((item): item is string => typeof item === 'string') : []
  const missingFields = fields.filter((field) => !currentFields.some((current) => current.name === field.name))
  if (missingFields.length || !currentIndexes.includes(index)) await manager.update(String(existing.id), { ...(missingFields.length ? { fields: [...currentFields, ...missingFields] } : {}), ...(!currentIndexes.includes(index) ? { indexes: [...currentIndexes, index] } : {}), ...rules })
  ensuredCollections.add(client)
}

export class WebSearchCredentialService {
  constructor(private readonly client: PocketBase) {}

  private async getRecord(userId: string): Promise<CredentialRecord | null> {
    if (!userId.trim()) throw new Error('An authenticated user id is required')
    await ensureWebSearchCredentialsCollection(this.client)
    const filter = `user_id = "${escapeFilter(userId)}"`
    const record = await firstOrNull(() => collection(this.client).getFirstListItem(filter))
    return record?.user_id === userId ? record : null
  }

  async getAll(userId: string): Promise<SecretPayload> {
    const record = await this.getRecord(userId)
    return record ? decrypt(String(record.credential_payload), userId) : {}
  }

  async statuses(userId: string): Promise<Record<WebSearchKeyProvider, boolean>> {
    const values = await this.getAll(userId)
    return Object.fromEntries(WEB_SEARCH_KEY_PROVIDERS.map((provider) => [provider, Boolean(values[provider])])) as Record<WebSearchKeyProvider, boolean>
  }

  async save(userId: string, input: Record<string, unknown>): Promise<Record<WebSearchKeyProvider, boolean>> {
    const existing = await this.getRecord(userId)
    const values = existing ? decrypt(String(existing.credential_payload), userId) : {}
    for (const provider of WEB_SEARCH_KEY_PROVIDERS) {
      const value = input[provider]
      if (value === undefined) continue
      if (typeof value !== 'string' || value.length > 4096) throw new Error(`Invalid ${provider} API key`)
      if (value.trim()) values[provider] = value.trim()
    }
    if (Object.keys(values).length === 0) return this.statuses(userId)
    const data = { user_id: userId, credential_payload: encrypt(values, userId), updated_at: Date.now() }
    if (existing) await collection(this.client).update(String(existing.id), data)
    else await collection(this.client).create(data)
    return Object.fromEntries(WEB_SEARCH_KEY_PROVIDERS.map((provider) => [provider, Boolean(values[provider])])) as Record<WebSearchKeyProvider, boolean>
  }

  async remove(userId: string, provider: WebSearchKeyProvider): Promise<Record<WebSearchKeyProvider, boolean>> {
    const record = await this.getRecord(userId)
    if (!record) return this.statuses(userId)
    const values = decrypt(String(record.credential_payload), userId)
    delete values[provider]
    if (Object.keys(values).length) await collection(this.client).update(String(record.id), { credential_payload: encrypt(values, userId), updated_at: Date.now() })
    else await collection(this.client).delete(String(record.id))
    return Object.fromEntries(WEB_SEARCH_KEY_PROVIDERS.map((item) => [item, Boolean(values[item])])) as Record<WebSearchKeyProvider, boolean>
  }
}
