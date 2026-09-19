import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import type { Credential } from '@earendil-works/pi-ai'
import type PocketBase from 'pocketbase'
import type { RecordModel } from 'pocketbase'

/** The metadata collection. It deliberately contains no credential material. */
export const PROVIDER_ACCOUNTS_COLLECTION = 'provider_accounts'
/** The locked, server-only collection containing encrypted credential envelopes. */
export const PROVIDER_ACCOUNT_CREDENTIALS_COLLECTION = 'provider_account_credentials'
export const PROVIDER_SECRET_KEY_ENV = 'SUBPOLAR_PROVIDER_SECRET_KEY'

export type ProviderAccountAuthType = Credential['type']
export type ProviderAccountStatus = 'active' | 'disabled'
export type ProviderAccountMetadataValue = string | number | boolean | null
export type ProviderAccountMetadata = Record<string, ProviderAccountMetadataValue>

export type ProviderAccount = {
  /** Stable opaque application id; this is not a provider id or credential id. */
  instanceId: string
  providerType: string
  displayName: string
  authType: ProviderAccountAuthType
  status: ProviderAccountStatus
  metadata: ProviderAccountMetadata
  hasCredential: boolean
  /** OAuth expiry copied as non-secret status metadata, when applicable. */
  credentialExpiresAt?: number
  createdAt: number
  updatedAt: number
  lastUsedAt?: number
}

export type ProviderAccountStatusView = Pick<
  ProviderAccount,
  'instanceId' | 'providerType' | 'authType' | 'status' | 'hasCredential' | 'credentialExpiresAt' | 'lastUsedAt'
> & {
  configured: boolean
  expired: boolean
}

export type CreateProviderAccountInput = {
  providerType: string
  displayName: string
  authType: ProviderAccountAuthType
  credential: Credential
  status?: ProviderAccountStatus
  metadata?: ProviderAccountMetadata
}

export type UpdateProviderAccountInput = {
  displayName?: string
  authType?: ProviderAccountAuthType
  status?: ProviderAccountStatus
  metadata?: ProviderAccountMetadata
  /** Replacing a credential requires the server encryption key. */
  credential?: Credential
}

export type ProviderAccountServiceOptions = {
  client: PocketBase
  /** Defaults to SUBPOLAR_PROVIDER_SECRET_KEY. A raw value must be exactly 32 bytes. */
  encryptionKey?: string | Uint8Array
  now?: () => number
  /** Injectable for tests; production values must be unique and opaque. */
  instanceId?: () => string
}

export type ProviderAccountSchema = {
  accounts: {
    name: typeof PROVIDER_ACCOUNTS_COLLECTION
    fields: readonly Record<string, unknown>[]
    indexes: readonly string[]
  }
  credentials: {
    name: typeof PROVIDER_ACCOUNT_CREDENTIALS_COLLECTION
    fields: readonly Record<string, unknown>[]
    indexes: readonly string[]
  }
}

/**
 * Collection declarations are exported so deployment tooling can inspect them.
 * Credential records are locked to superusers: application code should use an
 * admin PocketBase client through this module, never expose this collection to
 * a browser client, and never return its payload field.
 */
export const PROVIDER_ACCOUNT_SCHEMA: ProviderAccountSchema = {
  accounts: {
    name: PROVIDER_ACCOUNTS_COLLECTION,
    fields: [
      { name: 'user_id', type: 'text', required: true },
      { name: 'instance_id', type: 'text', required: true },
      { name: 'provider_type', type: 'text', required: true },
      { name: 'display_name', type: 'text', required: true },
      { name: 'auth_type', type: 'select', required: true, values: ['api_key', 'oauth'], maxSelect: 1 },
      { name: 'status', type: 'select', required: true, values: ['active', 'disabled'], maxSelect: 1 },
      { name: 'metadata', type: 'json' },
      { name: 'has_credential', type: 'bool', required: true },
      { name: 'credential_expires_at', type: 'number' },
      { name: 'created_at', type: 'number', required: true },
      { name: 'updated_at', type: 'number', required: true },
      { name: 'last_used_at', type: 'number' },
    ],
    indexes: [
      'CREATE UNIQUE INDEX idx_provider_accounts_user_instance ON provider_accounts (user_id, instance_id)',
      'CREATE INDEX idx_provider_accounts_user_provider ON provider_accounts (user_id, provider_type)',
    ],
  },
  credentials: {
    name: PROVIDER_ACCOUNT_CREDENTIALS_COLLECTION,
    fields: [
      { name: 'user_id', type: 'text', required: true },
      { name: 'instance_id', type: 'text', required: true },
      { name: 'payload', type: 'text', required: true },
      { name: 'updated_at', type: 'number', required: true },
    ],
    indexes: [
      'CREATE UNIQUE INDEX idx_provider_account_credentials_user_instance ON provider_account_credentials (user_id, instance_id)',
    ],
  },
}

type AccountRecord = RecordModel & Record<string, unknown>
type Collection = {
  getFirstListItem: (filter: string) => Promise<AccountRecord>
  getFullList: (options?: { filter?: string; sort?: string }) => Promise<AccountRecord[]>
  create: (data: Record<string, unknown>) => Promise<AccountRecord>
  update: (id: string, data: Record<string, unknown>) => Promise<AccountRecord>
  delete: (id: string) => Promise<boolean>
}
type CollectionManager = {
  getOne: (idOrName: string) => Promise<AccountRecord>
  create: (data: Record<string, unknown>) => Promise<AccountRecord>
  update: (id: string, data: Record<string, unknown>) => Promise<AccountRecord>
}

type EncryptedCredentialEnvelope = {
  v: 1
  alg: 'aes-256-gcm'
  iv: string
  tag: string
  ciphertext: string
}

const OPAQUE_ID_BYTES = 24
const AES_GCM_IV_BYTES = 12
const ACCOUNT_AAD_VERSION = 'subpolar/provider-account/v1'
const SENSITIVE_METADATA_KEY = /(api[-_ ]?key|authorization|credential|password|refresh|secret|token)/i

function collection(client: PocketBase, name: string): Collection {
  return client.collection(name) as unknown as Collection
}

function collectionManager(client: PocketBase): CollectionManager {
  return client.collections as unknown as CollectionManager
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'status' in error && (error as { status?: unknown }).status === 404
}

async function firstOrNull(operation: () => Promise<AccountRecord>): Promise<AccountRecord | null> {
  try {
    return await operation()
  } catch (error) {
    if (isNotFound(error)) return null
    throw error
  }
}

function escapeFilterValue(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
}

/** Escape a value for a PocketBase equality filter; field names are fixed by this module. */
export function providerAccountEquals(field: string, value: string): string {
  return `${field} = "${escapeFilterValue(value)}"`
}

function ownerFilter(userId: string): string {
  return providerAccountEquals('user_id', userId)
}

function ownedInstanceFilter(userId: string, instanceId: string): string {
  return `${ownerFilter(userId)} && ${providerAccountEquals('instance_id', instanceId)}`
}

function assertUserId(userId: string): void {
  if (typeof userId !== 'string' || userId.trim() === '' || userId !== userId.trim()) {
    throw new Error('A PocketBase user id is required')
  }
}

function requiredText(value: unknown, field: string, maxLength = 200): string {
  if (typeof value !== 'string') throw new Error(`${field} is required`)
  const normalized = value.trim()
  if (!normalized || normalized.length > maxLength || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`${field} is invalid`)
  }
  return normalized
}

function providerType(value: unknown): string {
  const normalized = requiredText(value, 'providerType')
  if (/\s/.test(normalized)) throw new Error('providerType must not contain whitespace')
  return normalized
}

function authType(value: unknown): ProviderAccountAuthType {
  if (value !== 'api_key' && value !== 'oauth') throw new Error('authType must be api_key or oauth')
  return value
}

function accountStatus(value: unknown): ProviderAccountStatus {
  if (value !== 'active' && value !== 'disabled') throw new Error('status must be active or disabled')
  return value
}

function copyMetadata(value: ProviderAccountMetadata | undefined): ProviderAccountMetadata {
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('metadata must be an object')

  const result: ProviderAccountMetadata = {}
  for (const [key, item] of Object.entries(value)) {
    const normalizedKey = requiredText(key, 'metadata key', 100)
    if (SENSITIVE_METADATA_KEY.test(normalizedKey)) throw new Error(`metadata key ${normalizedKey} is not allowed`)
    if (item !== null && typeof item !== 'string' && typeof item !== 'number' && typeof item !== 'boolean') {
      throw new Error(`metadata value ${normalizedKey} is invalid`)
    }
    if (typeof item === 'number' && !Number.isFinite(item)) throw new Error(`metadata value ${normalizedKey} is invalid`)
    result[normalizedKey] = item
  }
  return result
}

function credentialRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('credential is invalid')
  return value as Record<string, unknown>
}

/**
 * Serialize the canonical Pi Credential shape. This is a server-side helper;
 * its return value contains secret material and must not be sent to clients.
 */
export function serializeProviderCredential(value: Credential, expectedAuthType?: ProviderAccountAuthType): string {
  const record = credentialRecord(value)
  const type = authType(record.type)
  if (expectedAuthType !== undefined && type !== expectedAuthType) throw new Error('credential authType does not match account authType')

  if (type === 'api_key') {
    if (record.key !== undefined && (typeof record.key !== 'string' || record.key.length === 0)) throw new Error('api_key credential key is invalid')
    if (record.env !== undefined) validateCredentialEnv(record.env)
  } else {
    if (typeof record.refresh !== 'string' || record.refresh.length === 0) throw new Error('oauth credential refresh is required')
    if (typeof record.access !== 'string' || record.access.length === 0) throw new Error('oauth credential access is required')
    if (typeof record.expires !== 'number' || !Number.isFinite(record.expires)) throw new Error('oauth credential expires is invalid')
  }

  let serialized: string
  try {
    serialized = JSON.stringify(value)
  } catch {
    throw new Error('credential is not JSON serializable')
  }
  if (!serialized) throw new Error('credential is invalid')
  // JSON.parse also strips class/prototype state before persistence.
  const parsed = JSON.parse(serialized) as unknown
  credentialRecord(parsed)
  return serialized
}

/** Parse and validate the canonical Pi Credential shape without changing its tags. */
export function deserializeProviderCredential(serialized: string, expectedAuthType?: ProviderAccountAuthType): Credential {
  let parsed: unknown
  try {
    parsed = JSON.parse(serialized)
  } catch {
    throw new Error('stored provider credential is invalid')
  }
  serializeProviderCredential(parsed as Credential, expectedAuthType)
  return parsed as Credential
}

function validateCredentialEnv(value: unknown): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('api_key credential env is invalid')
  for (const [key, item] of Object.entries(value)) {
    if (!key || typeof item !== 'string') throw new Error('api_key credential env is invalid')
  }
}

function credentialExpiry(value: Credential): number | undefined {
  return value.type === 'oauth' ? value.expires : undefined
}

function decodeSecretKey(value: string | Uint8Array | undefined): Buffer {
  if (value === undefined) throw new Error(`${PROVIDER_SECRET_KEY_ENV} is required for provider credential writes`)
  if (value instanceof Uint8Array) {
    if (value.byteLength !== 32) throw new Error(`${PROVIDER_SECRET_KEY_ENV} must be exactly 32 bytes`)
    return Buffer.from(value)
  }

  const input = value.trim()
  if (!input) throw new Error(`${PROVIDER_SECRET_KEY_ENV} is required for provider credential writes`)

  const explicitHex = input.startsWith('hex:') ? input.slice(4) : input
  if (/^[0-9a-f]{64}$/i.test(explicitHex)) return Buffer.from(explicitHex, 'hex')

  const explicitBase64 = input.startsWith('base64:') ? input.slice(7) : input
  if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(explicitBase64)) {
    const normalized = explicitBase64.replaceAll('-', '+').replaceAll('_', '/')
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
    const decoded = Buffer.from(padded, 'base64')
    if (decoded.byteLength === 32) return decoded
  }

  const utf8 = Buffer.from(input, 'utf8')
  if (utf8.byteLength === 32) return utf8
  throw new Error(`${PROVIDER_SECRET_KEY_ENV} must decode to exactly 32 bytes`)
}

function aad(userId: string, instanceId: string, providerTypeValue: string, authTypeValue: ProviderAccountAuthType): Buffer {
  return Buffer.from(`${ACCOUNT_AAD_VERSION}\0${userId}\0${instanceId}\0${providerTypeValue}\0${authTypeValue}`, 'utf8')
}

function encryptCredential(
  credential: Credential,
  key: Buffer,
  userId: string,
  instanceId: string,
  providerTypeValue: string,
  authTypeValue: ProviderAccountAuthType,
): string {
  const plaintext = Buffer.from(serializeProviderCredential(credential, authTypeValue), 'utf8')
  const iv = randomBytes(AES_GCM_IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(aad(userId, instanceId, providerTypeValue, authTypeValue))
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const envelope: EncryptedCredentialEnvelope = {
    v: 1,
    alg: 'aes-256-gcm',
    iv: iv.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
    ciphertext: ciphertext.toString('base64url'),
  }
  return JSON.stringify(envelope)
}

function decryptCredential(
  payload: string,
  key: Buffer,
  userId: string,
  instanceId: string,
  providerTypeValue: string,
  authTypeValue: ProviderAccountAuthType,
): Credential {
  let envelope: Partial<EncryptedCredentialEnvelope>
  try {
    envelope = JSON.parse(payload) as Partial<EncryptedCredentialEnvelope>
    if (envelope.v !== 1 || envelope.alg !== 'aes-256-gcm' || !envelope.iv || !envelope.tag || !envelope.ciphertext) throw new Error('invalid envelope')
    const iv = Buffer.from(envelope.iv, 'base64url')
    const tag = Buffer.from(envelope.tag, 'base64url')
    const ciphertext = Buffer.from(envelope.ciphertext, 'base64url')
    if (iv.byteLength !== AES_GCM_IV_BYTES || tag.byteLength !== 16 || ciphertext.byteLength === 0) throw new Error('invalid envelope')

    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAAD(aad(userId, instanceId, providerTypeValue, authTypeValue))
    decipher.setAuthTag(tag)
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
    return deserializeProviderCredential(plaintext, authTypeValue)
  } catch {
    throw new Error('stored provider credential could not be decrypted')
  }
}

function accountFromRecord(record: AccountRecord): ProviderAccount {
  const metadata = copyMetadata((record.metadata ?? {}) as ProviderAccountMetadata)
  const result: ProviderAccount = {
    instanceId: requiredText(record.instance_id, 'instanceId', 300),
    providerType: providerType(record.provider_type),
    displayName: requiredText(record.display_name, 'displayName'),
    authType: authType(record.auth_type),
    status: accountStatus(record.status),
    metadata,
    hasCredential: record.has_credential === true,
    createdAt: finiteNumber(record.created_at, 'created_at'),
    updatedAt: finiteNumber(record.updated_at, 'updated_at'),
  }
  const expires = record.credential_expires_at
  if (expires !== undefined && expires !== null) result.credentialExpiresAt = finiteNumber(expires, 'credential_expires_at')
  const lastUsed = record.last_used_at
  if (lastUsed !== undefined && lastUsed !== null) result.lastUsedAt = finiteNumber(lastUsed, 'last_used_at')
  return result
}

function finiteNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`PocketBase ${field} is invalid`)
  return value
}

async function ensureCollection(
  client: PocketBase,
  name: string,
  fields: readonly Record<string, unknown>[],
  indexes: readonly string[],
  rules?: Record<string, unknown>,
): Promise<void> {
  const manager = collectionManager(client)
  const existing = await firstOrNull(() => manager.getOne(name))
  if (!existing) {
    try {
      await manager.create({ name, type: 'base', fields: [...fields], indexes: [...indexes], ...rules })
    } catch (error) {
      const raced = await firstOrNull(() => manager.getOne(name))
      if (!raced) throw error
      await extendCollection(manager, raced, fields, indexes)
    }
    return
  }
  await extendCollection(manager, existing, fields, indexes)
}

async function extendCollection(
  manager: CollectionManager,
  existing: AccountRecord,
  fields: readonly Record<string, unknown>[],
  indexes: readonly string[],
): Promise<void> {
  const currentFields = Array.isArray(existing.fields)
    ? existing.fields.filter((field): field is Record<string, unknown> => typeof field === 'object' && field !== null)
    : []
  const currentIndexes = Array.isArray(existing.indexes)
    ? existing.indexes.filter((index): index is string => typeof index === 'string')
    : []
  const knownFields = new Set(currentFields.map((field) => String(field.name)))
  const missingFields = fields.filter((field) => !knownFields.has(String(field.name)))
  const missingIndexes = indexes.filter((index) => !currentIndexes.includes(index))
  if (missingFields.length || missingIndexes.length) {
    await manager.update(existing.id, {
      ...(missingFields.length ? { fields: [...currentFields, ...missingFields] } : {}),
      ...(missingIndexes.length ? { indexes: [...currentIndexes, ...missingIndexes] } : {}),
    })
  }
}

/** Ensure only the two provider-account collections, preserving existing fields. */
export async function ensureProviderAccountCollections(client: PocketBase): Promise<void> {
  await ensureCollection(client, PROVIDER_ACCOUNT_SCHEMA.accounts.name, PROVIDER_ACCOUNT_SCHEMA.accounts.fields, PROVIDER_ACCOUNT_SCHEMA.accounts.indexes, {
    listRule: '@request.auth.id = user_id',
    viewRule: '@request.auth.id = user_id',
    createRule: '@request.auth.id = user_id',
    updateRule: '@request.auth.id = user_id',
    deleteRule: '@request.auth.id = user_id',
  })
  await ensureCollection(client, PROVIDER_ACCOUNT_SCHEMA.credentials.name, PROVIDER_ACCOUNT_SCHEMA.credentials.fields, PROVIDER_ACCOUNT_SCHEMA.credentials.indexes, {
    listRule: null,
    viewRule: null,
    createRule: null,
    updateRule: null,
    deleteRule: null,
  })
}

export class ProviderAccountService {
  private readonly now: () => number
  private readonly makeInstanceId: () => string
  private readonly encryptionKey: string | Uint8Array | undefined

  constructor(private readonly client: PocketBase, options: Omit<ProviderAccountServiceOptions, 'client'> = {}) {
    this.now = options.now ?? Date.now
    this.makeInstanceId = options.instanceId ?? (() => randomBytes(OPAQUE_ID_BYTES).toString('base64url'))
    this.encryptionKey = options.encryptionKey
  }

  async ensureCollections(): Promise<void> {
    await ensureProviderAccountCollections(this.client)
  }

  async createAccount(userId: string, input: CreateProviderAccountInput): Promise<ProviderAccount> {
    assertUserId(userId)
    const normalized = normalizeCreateInput(input)
    const key = decodeSecretKey(this.encryptionKey ?? process.env[PROVIDER_SECRET_KEY_ENV])
    const instanceId = requiredText(this.makeInstanceId(), 'instanceId', 300)
    const now = this.now()
    const metadata = accountData(userId, instanceId, normalized, now)
    const account = await collection(this.client, PROVIDER_ACCOUNTS_COLLECTION).create(metadata)
    try {
      await collection(this.client, PROVIDER_ACCOUNT_CREDENTIALS_COLLECTION).create({
        user_id: userId,
        instance_id: instanceId,
        payload: encryptCredential(normalized.credential, key, userId, instanceId, normalized.providerType, normalized.authType),
        updated_at: now,
      })
    } catch (error) {
      await collection(this.client, PROVIDER_ACCOUNTS_COLLECTION).delete(account.id).catch(() => false)
      throw error
    }
    return accountFromRecord(account)
  }

  async getAccount(userId: string, instanceId: string): Promise<ProviderAccount | null> {
    const record = await this.findOwnedAccount(userId, instanceId)
    return record ? accountFromRecord(record) : null
  }

  async listAccounts(userId: string): Promise<ProviderAccount[]> {
    assertUserId(userId)
    const records = await collection(this.client, PROVIDER_ACCOUNTS_COLLECTION).getFullList({
      filter: ownerFilter(userId),
      sort: 'provider_type,display_name,instance_id',
    })
    return records.map(accountFromRecord)
  }

  async updateAccount(userId: string, instanceId: string, input: UpdateProviderAccountInput): Promise<ProviderAccount | null> {
    assertUserId(userId)
    const existing = await this.findOwnedAccount(userId, instanceId)
    if (!existing) return null
    const current = accountFromRecord(existing)
    const normalized = normalizeUpdateInput(input, current.authType)
    const now = this.now()
    let key: Buffer | undefined
    if (normalized.credential !== undefined) key = decodeSecretKey(this.encryptionKey ?? process.env[PROVIDER_SECRET_KEY_ENV])

    const metadata: Record<string, unknown> = {
      ...(normalized.displayName === undefined ? {} : { display_name: normalized.displayName }),
      ...(normalized.authType === undefined ? {} : { auth_type: normalized.authType }),
      ...(normalized.status === undefined ? {} : { status: normalized.status }),
      ...(normalized.metadata === undefined ? {} : { metadata: normalized.metadata }),
      ...(normalized.credential === undefined ? {} : {
        has_credential: true,
        credential_expires_at: credentialExpiry(normalized.credential) ?? null,
      }),
      updated_at: now,
    }
    const updated = await collection(this.client, PROVIDER_ACCOUNTS_COLLECTION).update(existing.id, metadata)
    if (normalized.credential !== undefined && key) {
      const credentialCollection = collection(this.client, PROVIDER_ACCOUNT_CREDENTIALS_COLLECTION)
      const stored = await firstOrNull(() => credentialCollection.getFirstListItem(ownedInstanceFilter(userId, instanceId)))
      const payload = encryptCredential(normalized.credential, key, userId, instanceId, current.providerType, normalized.authType ?? current.authType)
      if (stored) await credentialCollection.update(stored.id, { payload, updated_at: now })
      else await credentialCollection.create({ user_id: userId, instance_id: instanceId, payload, updated_at: now })
    }
    return accountFromRecord(updated)
  }

  async deleteAccount(userId: string, instanceId: string): Promise<boolean> {
    assertUserId(userId)
    const existing = await this.findOwnedAccount(userId, instanceId)
    if (!existing) return false
    const credential = await firstOrNull(() => collection(this.client, PROVIDER_ACCOUNT_CREDENTIALS_COLLECTION).getFirstListItem(ownedInstanceFilter(userId, instanceId)))
    if (credential) await collection(this.client, PROVIDER_ACCOUNT_CREDENTIALS_COLLECTION).delete(credential.id)
    await collection(this.client, PROVIDER_ACCOUNTS_COLLECTION).delete(existing.id)
    return true
  }

  /** Return status only; this method never decrypts or returns credential material. */
  async getAccountStatus(userId: string, instanceId: string): Promise<ProviderAccountStatusView | null> {
    const account = await this.getAccount(userId, instanceId)
    if (!account) return null
    const expired = account.credentialExpiresAt !== undefined && account.credentialExpiresAt <= this.now()
    return {
      instanceId: account.instanceId,
      providerType: account.providerType,
      authType: account.authType,
      status: account.status,
      hasCredential: account.hasCredential,
      ...(account.credentialExpiresAt === undefined ? {} : { credentialExpiresAt: account.credentialExpiresAt }),
      ...(account.lastUsedAt === undefined ? {} : { lastUsedAt: account.lastUsedAt }),
      configured: account.status === 'active' && account.hasCredential && !expired,
      expired,
    }
  }

  async setAccountStatus(userId: string, instanceId: string, status: ProviderAccountStatus): Promise<ProviderAccount | null> {
    return this.updateAccount(userId, instanceId, { status })
  }

  /**
   * Server-only credential access for provider request code. The returned value
   * is the Pi Credential shape and must never be included in an HTTP response,
   * logs, status objects, or PocketBase metadata.
   */
  async loadCredential(userId: string, instanceId: string): Promise<Credential | null> {
    assertUserId(userId)
    const account = await this.findOwnedAccount(userId, instanceId)
    if (!account) return null
    const metadata = accountFromRecord(account)
    const key = decodeSecretKey(this.encryptionKey ?? process.env[PROVIDER_SECRET_KEY_ENV])
    const credential = await firstOrNull(() => collection(this.client, PROVIDER_ACCOUNT_CREDENTIALS_COLLECTION).getFirstListItem(ownedInstanceFilter(userId, instanceId)))
    if (!credential) return null
    const loaded = decryptCredential(String(credential.payload), key, userId, metadata.instanceId, metadata.providerType, metadata.authType)
    await collection(this.client, PROVIDER_ACCOUNTS_COLLECTION).update(account.id, { last_used_at: this.now() }).catch(() => undefined)
    return loaded
  }

  private async findOwnedAccount(userId: string, instanceId: string): Promise<AccountRecord | null> {
    assertUserId(userId)
    const normalizedInstanceId = requiredText(instanceId, 'instanceId', 300)
    return firstOrNull(() => collection(this.client, PROVIDER_ACCOUNTS_COLLECTION).getFirstListItem(ownedInstanceFilter(userId, normalizedInstanceId)))
  }
}

export function createProviderAccountService(options: ProviderAccountServiceOptions): ProviderAccountService {
  return new ProviderAccountService(options.client, options)
}

function normalizeCreateInput(input: CreateProviderAccountInput): CreateProviderAccountInput & { providerType: string; displayName: string; authType: ProviderAccountAuthType; status: ProviderAccountStatus; metadata: ProviderAccountMetadata } {
  if (!input || typeof input !== 'object') throw new Error('provider account input is required')
  const providerTypeValue = providerType(input.providerType)
  const displayName = requiredText(input.displayName, 'displayName')
  const authTypeValue = authType(input.authType)
  const status = input.status === undefined ? 'active' : accountStatus(input.status)
  const metadata = copyMetadata(input.metadata)
  serializeProviderCredential(input.credential, authTypeValue)
  return { ...input, providerType: providerTypeValue, displayName, authType: authTypeValue, status, metadata }
}

function normalizeUpdateInput(input: UpdateProviderAccountInput, existingAuthType: ProviderAccountAuthType): UpdateProviderAccountInput & { displayName?: string; authType?: ProviderAccountAuthType; status?: ProviderAccountStatus; metadata?: ProviderAccountMetadata } {
  if (!input || typeof input !== 'object') throw new Error('provider account update is required')
  const normalized: UpdateProviderAccountInput & { displayName?: string; authType?: ProviderAccountAuthType; status?: ProviderAccountStatus; metadata?: ProviderAccountMetadata } = { ...input }
  if (input.displayName !== undefined) normalized.displayName = requiredText(input.displayName, 'displayName')
  if (input.authType !== undefined) normalized.authType = authType(input.authType)
  if (input.status !== undefined) normalized.status = accountStatus(input.status)
  if (input.metadata !== undefined) normalized.metadata = copyMetadata(input.metadata)
  const nextAuthType = normalized.authType ?? existingAuthType
  if (normalized.authType !== undefined && normalized.authType !== existingAuthType && input.credential === undefined) {
    throw new Error('Changing authType requires a replacement credential')
  }
  if (input.credential !== undefined) serializeProviderCredential(input.credential, nextAuthType)
  return normalized
}

function accountData(
  userId: string,
  instanceId: string,
  input: CreateProviderAccountInput & { providerType: string; displayName: string; authType: ProviderAccountAuthType; status: ProviderAccountStatus; metadata: ProviderAccountMetadata },
  now: number,
): Record<string, unknown> {
  return {
    user_id: userId,
    instance_id: instanceId,
    provider_type: input.providerType,
    display_name: input.displayName,
    auth_type: input.authType,
    status: input.status,
    metadata: input.metadata,
    has_credential: true,
    credential_expires_at: credentialExpiry(input.credential) ?? null,
    created_at: now,
    updated_at: now,
    last_used_at: null,
  }
}
