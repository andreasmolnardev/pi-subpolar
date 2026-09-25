import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import type PocketBase from 'pocketbase'
import type { RecordModel } from 'pocketbase'

export const CUSTOM_PROVIDERS_COLLECTION = 'custom_providers'
export const CUSTOM_PROVIDER_SECRET_KEY_ENV = 'SUBPOLAR_PROVIDER_SECRET_KEY'

export type CustomProviderModel = Record<string, unknown>

export type CustomProvider = {
  id: string
  name: string
  baseUrl: string
  api: string
  headers?: Record<string, string>
  authHeader: boolean
  models: CustomProviderModel[]
  modelOverrides?: Record<string, unknown>
}

export class CustomProviderValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CustomProviderValidationError'
  }
}

type CustomProviderRecord = RecordModel & Record<string, unknown>
type CustomProviderCollection = {
  getFirstListItem: (filter: string) => Promise<CustomProviderRecord>
  getFullList: (options?: { filter?: string; sort?: string }) => Promise<CustomProviderRecord[]>
  create: (data: Record<string, unknown>) => Promise<CustomProviderRecord>
  update: (id: string, data: Record<string, unknown>) => Promise<CustomProviderRecord>
  delete: (id: string) => Promise<boolean>
}
type CollectionManager = {
  getOne: (name: string) => Promise<CustomProviderRecord>
  create: (data: Record<string, unknown>) => Promise<CustomProviderRecord>
  update: (id: string, data: Record<string, unknown>) => Promise<CustomProviderRecord>
}

type SecretPayload = {
  apiKey?: string
  headers?: Record<string, string>
}

const SECRET_HEADER = /authorization|api[-_]?key|token|secret|password|credential|cookie/i
const SENSITIVE_QUERY = /(?:api[-_]?key|access[-_]?token|refresh[-_]?token|authorization|authentication|token|password|secret|credential|private[-_]?key|cookie)/i

function collection(client: PocketBase): CustomProviderCollection {
  return client.collection(CUSTOM_PROVIDERS_COLLECTION) as unknown as CustomProviderCollection
}

function manager(client: PocketBase): CollectionManager {
  return client.collections as unknown as CollectionManager
}

function escapeFilter(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
}

function ownedFilter(userId: string, providerId?: string): string {
  const owner = `user_id = "${escapeFilter(userId)}"`
  return providerId === undefined ? owner : `${owner} && provider_id = "${escapeFilter(providerId)}"`
}

function assertUserId(userId: string): void {
  if (typeof userId !== 'string' || !userId.trim() || userId !== userId.trim()) throw new CustomProviderValidationError('A PocketBase user id is required')
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'status' in error && (error as { status?: unknown }).status === 404
}

async function firstOrNull(operation: () => Promise<CustomProviderRecord>): Promise<CustomProviderRecord | null> {
  try { return await operation() } catch (error) { if (isNotFound(error)) return null; throw error }
}

function keyFromEnvironment(): Buffer {
  const value = process.env[CUSTOM_PROVIDER_SECRET_KEY_ENV]?.trim() ?? ''
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
  throw new Error(`${CUSTOM_PROVIDER_SECRET_KEY_ENV} must decode to exactly 32 bytes`)
}

function aad(userId: string, providerId: string): Buffer {
  return Buffer.from(`subpolar/custom-provider/v1\0${userId}\0${providerId}`, 'utf8')
}

function encrypt(payload: SecretPayload, key: Buffer, userId: string, providerId: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(aad(userId, providerId))
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()])
  return JSON.stringify({
    v: 1,
    alg: 'aes-256-gcm',
    iv: iv.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
    ciphertext: ciphertext.toString('base64url'),
  })
}

function decrypt(value: string, key: Buffer, userId: string, providerId: string): SecretPayload {
  try {
    const envelope = JSON.parse(value) as { v?: number; alg?: string; iv?: string; tag?: string; ciphertext?: string }
    if (envelope.v !== 1 || envelope.alg !== 'aes-256-gcm' || !envelope.iv || !envelope.tag || !envelope.ciphertext) throw new Error('invalid envelope')
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64url'))
    decipher.setAAD(aad(userId, providerId))
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64url'))
    const plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64url')), decipher.final()]).toString('utf8')
    const payload = JSON.parse(plaintext) as SecretPayload
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('invalid payload')
    return payload
  } catch {
    throw new Error('stored custom provider credentials could not be decrypted')
  }
}

function text(value: unknown, field: string, required = true): string {
  if (typeof value !== 'string') {
    if (!required) return ''
    throw new CustomProviderValidationError(`${field} is required`)
  }
  const result = value.trim()
  if (required && !result) throw new CustomProviderValidationError(`${field} is required`)
  if (result.length > 500 || /[\u0000-\u001f\u007f]/.test(result)) throw new CustomProviderValidationError(`${field} is invalid`)
  return result
}

export function validateCustomProviderBaseUrl(value: string): string {
  let url: URL
  try { url = new URL(value) } catch { throw new CustomProviderValidationError('baseUrl is invalid') }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new CustomProviderValidationError('baseUrl must use http or https')
  if (url.username || url.password) throw new CustomProviderValidationError('baseUrl must not contain embedded credentials')
  for (const key of url.searchParams.keys()) {
    if (SENSITIVE_QUERY.test(key)) throw new CustomProviderValidationError('baseUrl must not contain sensitive query parameters')
  }
  return url.href.replace(/\/$/, '')
}

export function customProviderDiscoveryUrl(value: string): string {
  const url = new URL(validateCustomProviderBaseUrl(value))
  const pathname = url.pathname.replace(/\/+$/, '')
  url.pathname = `${pathname}/v1/models`
  return url.href
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function publicHeaders(value: unknown): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, item] of Object.entries(object(value))) {
    if (!SECRET_HEADER.test(key) && typeof item === 'string') result[key] = item
  }
  return result
}

function splitHeaders(value: unknown): { public: Record<string, string>; secret: Record<string, string> } {
  const safe: Record<string, string> = {}
  const secret: Record<string, string> = {}
  for (const [key, item] of Object.entries(object(value))) {
    if (typeof item !== 'string') continue
    if (SECRET_HEADER.test(key)) secret[key] = item
    else safe[key] = item
  }
  return { public: safe, secret }
}

function modelList(value: unknown): CustomProviderModel[] {
  return Array.isArray(value) ? value.map(object) : []
}

function publicValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(publicValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).flatMap(([key, item]) => SECRET_HEADER.test(key) ? [] : [[key, publicValue(item)]]))
}

function publicProvider(record: Record<string, unknown>): CustomProvider {
  const headers = publicHeaders(record.headers)
  const modelOverrides = object(publicValue(record.model_overrides))
  return {
    id: String(record.provider_id ?? ''),
    name: String(record.name ?? ''),
    baseUrl: String(record.base_url ?? ''),
    api: String(record.api ?? 'openai-completions'),
    ...(Object.keys(headers).length ? { headers } : {}),
    authHeader: record.auth_header === true,
    models: modelList(publicValue(record.models)),
    ...(Object.keys(modelOverrides).length ? { modelOverrides } : {}),
  }
}

function providerData(userId: string, input: Record<string, unknown>, now: number, secretPayload: SecretPayload | undefined, existing?: CustomProviderRecord): Record<string, unknown> {
  const id = text(input.id, 'id')
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new CustomProviderValidationError('id is invalid')
  const name = text(input.name, 'name')
  const baseUrl = validateCustomProviderBaseUrl(text(input.baseUrl, 'baseUrl'))
  const headers = splitHeaders(input.headers)
  return {
    user_id: userId,
    provider_id: id,
    name,
    base_url: baseUrl,
    api: text(input.api, 'api', false) || 'openai-completions',
    headers: headers.public,
    auth_header: input.authHeader === true,
    models: modelList(publicValue(input.models)),
    model_overrides: object(publicValue(input.modelOverrides)),
    ...(secretPayload === undefined
      ? (existing?.credential_payload ? { credential_payload: existing.credential_payload } : {})
      : { credential_payload: encrypt(secretPayload, keyFromEnvironment(), userId, id) }),
    ...(existing?.created_at === undefined ? { created_at: now } : {}),
    updated_at: now,
  }
}

async function extendCollection(collectionManager: CollectionManager, existing: CustomProviderRecord, fields: readonly Record<string, unknown>[], indexes: readonly string[], rules: Record<string, unknown>): Promise<void> {
  const currentFields = Array.isArray(existing.fields) ? existing.fields.filter((field): field is Record<string, unknown> => typeof field === 'object' && field !== null) : []
  const currentIndexes = Array.isArray(existing.indexes) ? existing.indexes.filter((index): index is string => typeof index === 'string') : []
  const knownFields = new Set(currentFields.map((field) => String(field.name)))
  const missingFields = fields.filter((field) => !knownFields.has(String(field.name)))
  const missingIndexes = indexes.filter((index) => !currentIndexes.includes(index))
  if (missingFields.length || missingIndexes.length || Object.keys(rules).length > 0) {
    await collectionManager.update(String(existing.id), {
      ...(missingFields.length ? { fields: [...currentFields, ...missingFields] } : {}),
      ...(missingIndexes.length ? { indexes: [...currentIndexes, ...missingIndexes] } : {}),
      ...rules,
    })
  }
}

export async function ensureCustomProviderCollection(client: PocketBase): Promise<void> {
  const fields = [
    { name: 'user_id', type: 'text', required: true },
    { name: 'provider_id', type: 'text', required: true },
    { name: 'name', type: 'text', required: true },
    { name: 'base_url', type: 'text', required: true },
    { name: 'api', type: 'text', required: true },
    { name: 'headers', type: 'json' },
    { name: 'auth_header', type: 'bool' },
    { name: 'models', type: 'json' },
    { name: 'model_overrides', type: 'json' },
    { name: 'credential_payload', type: 'text' },
    { name: 'created_at', type: 'number', required: true },
    { name: 'updated_at', type: 'number', required: true },
  ]
  const indexes = ['CREATE UNIQUE INDEX idx_custom_providers_user_provider ON custom_providers (user_id, provider_id)']
  const rules = { listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null }
  const collectionManager = manager(client)
  const existing = await firstOrNull(() => collectionManager.getOne(CUSTOM_PROVIDERS_COLLECTION))
  if (!existing) {
    try {
      await collectionManager.create({ name: CUSTOM_PROVIDERS_COLLECTION, type: 'base', fields, indexes, ...rules })
    } catch (error) {
      const raced = await firstOrNull(() => collectionManager.getOne(CUSTOM_PROVIDERS_COLLECTION))
      if (!raced) throw error
      await extendCollection(collectionManager, raced, fields, indexes, rules)
    }
    return
  }
  await extendCollection(collectionManager, existing, fields, indexes, rules)
}

export class CustomProviderService {
  constructor(private readonly client: PocketBase) {}

  async list(userId: string): Promise<CustomProvider[]> {
    assertUserId(userId)
    return (await collection(this.client).getFullList({ filter: ownedFilter(userId), sort: 'name,provider_id' })).map(publicProvider)
  }

  async save(userId: string, input: Record<string, unknown>): Promise<{ provider: CustomProvider; created: boolean }> {
    assertUserId(userId)
    const id = text(input.id, 'id')
    const existing = await firstOrNull(() => collection(this.client).getFirstListItem(ownedFilter(userId, id)))
    const suppliedHeaders = splitHeaders(input.headers)
    const suppliedApiKey = typeof input.apiKey === 'string' && input.apiKey ? input.apiKey : undefined
    let secretPayload: SecretPayload | undefined
    if (suppliedApiKey || Object.keys(suppliedHeaders.secret).length > 0) {
      let previous: SecretPayload = {}
      if (existing?.credential_payload) previous = decrypt(String(existing.credential_payload), keyFromEnvironment(), userId, id)
      secretPayload = {
        ...(suppliedApiKey ? { apiKey: suppliedApiKey } : previous.apiKey ? { apiKey: previous.apiKey } : {}),
        ...(Object.keys(suppliedHeaders.secret).length ? { headers: { ...(previous.headers ?? {}), ...suppliedHeaders.secret } } : previous.headers ? { headers: previous.headers } : {}),
      }
    }
    const record = existing
      ? await collection(this.client).update(String(existing.id), providerData(userId, input, Date.now(), secretPayload, existing))
      : await collection(this.client).create(providerData(userId, input, Date.now(), secretPayload))
    return { provider: publicProvider(record), created: !existing }
  }

  async delete(userId: string, providerId: string): Promise<void> {
    assertUserId(userId)
    const existing = await firstOrNull(() => collection(this.client).getFirstListItem(ownedFilter(userId, providerId)))
    if (existing) await collection(this.client).delete(String(existing.id))
  }
}

export function createCustomProviderService(client: PocketBase): CustomProviderService {
  return new CustomProviderService(client)
}
