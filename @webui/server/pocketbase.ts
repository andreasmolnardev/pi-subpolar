import PocketBase, { type RecordModel } from 'pocketbase'

export type PocketBaseUser = RecordModel & {
  email?: string
  name?: string
  avatar?: string
}

export type UserPreferencesRecord = RecordModel & {
  user_id: string
  preferences?: Record<string, unknown>
  updated_at?: number
}

const defaultUrl = 'http://127.0.0.1:8090'
const pocketBaseUrl = (process.env.POCKETBASE_URL ?? defaultUrl).replace(/\/$/, '')
const adminEmail = process.env.POCKETBASE_EMAIL ?? ''
const adminPassword = process.env.POCKETBASE_PASSWORD ?? ''

let adminPromise: Promise<PocketBase> | undefined

function configure(client: PocketBase): PocketBase {
  client.autoCancellation(false)
  return client
}

async function authenticateAdmin(client: PocketBase): Promise<void> {
  if (!adminEmail || !adminPassword) {
    throw new Error('POCKETBASE_EMAIL and POCKETBASE_PASSWORD are required')
  }

  try {
    await client.collection('_superusers').authWithPassword(adminEmail, adminPassword)
    return
  } catch (error) {
    const response = await fetch(`${pocketBaseUrl}/api/admins/auth-with-password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identity: adminEmail, password: adminPassword }),
    }).catch(() => null)

    if (!response?.ok) throw error
    const data = await response.json() as { token?: string; admin?: RecordModel }
    if (!data.token) throw error
    client.authStore.save(data.token, data.admin)
  }
}

export async function getPocketBaseAdmin(): Promise<PocketBase> {
  if (!adminPromise) {
    const client = configure(new PocketBase(pocketBaseUrl))
    adminPromise = authenticateAdmin(client).then(() => client).catch((error) => {
      adminPromise = undefined
      throw error
    })
  }
  return adminPromise
}

export function getPocketBaseUrl(): string {
  return pocketBaseUrl
}

export function newPocketBaseClient(): PocketBase {
  return configure(new PocketBase(pocketBaseUrl))
}

export async function authenticateRequest(request: Request): Promise<PocketBaseUser | null> {
  const client = newPocketBaseClient()
  const authorization = request.headers.get('authorization') ?? ''
  const cookie = request.headers.get('cookie') ?? ''

  if (authorization.startsWith('Bearer ')) {
    client.authStore.save(authorization.slice('Bearer '.length).trim(), null)
  } else if (cookie) {
    client.authStore.loadFromCookie(cookie)
  }

  if (!client.authStore.isValid) return null

  try {
    await client.collection('users').authRefresh()
    return client.authStore.model as PocketBaseUser | null
  } catch {
    client.authStore.clear()
    return null
  }
}

export function authCookie(client: PocketBase): string {
  const secure = process.env.AUTH_SECURE_COOKIES === 'true'
  return client.authStore.exportToCookie({
    httpOnly: true,
    sameSite: 'Lax',
    secure,
    path: '/',
  })
}

export function clearAuthCookie(): string {
  return 'pb_auth=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax'
}

function field(name: string, type: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { name, type, ...extra }
}

async function ensureCollection(
  client: PocketBase,
  name: string,
  fields: Record<string, unknown>[],
  indexes: string[] = [],
  verifyUniqueIndexes = false,
): Promise<void> {
  const collections = client.collections as unknown as {
    getOne: (name: string) => Promise<RecordModel>
    create: (data: Record<string, unknown>) => Promise<RecordModel>
    update: (id: string, data: Record<string, unknown>) => Promise<RecordModel>
  }
  const existing = await collections.getOne(name).catch(() => null)
  if (!existing) {
    await collections.create({ name, type: 'base', fields, indexes })
    if (verifyUniqueIndexes) await verifyUniqueIndexesPresent(collections, name, indexes)
    return
  }

  const currentFields = Array.isArray(existing.fields) ? existing.fields as Record<string, unknown>[] : []
  const currentIndexes = Array.isArray(existing.indexes) ? existing.indexes.filter((item): item is string => typeof item === 'string') : []
  const known = new Set(currentFields.map((item) => String(item.name)))
  const missing = fields.filter((item) => !known.has(String(item.name)))
  const missingIndexes = indexes.filter((index) => !currentIndexes.includes(index))
  if (missing.length > 0 || missingIndexes.length > 0) {
    await collections.update(String(existing.id), {
      ...(missing.length > 0 ? { fields: [...currentFields, ...missing] } : {}),
      ...(missingIndexes.length > 0 ? { indexes: [...currentIndexes, ...missingIndexes] } : {}),
    })
  }
  if (verifyUniqueIndexes) await verifyUniqueIndexesPresent(collections, name, indexes)
}

function indexCoversUniqueColumns(index: string, collection: string, columns: readonly string[]): boolean {
  const normalized = index.toLowerCase().replaceAll('`', '').replaceAll('"', '').replace(/\s+/g, ' ')
  const table = new RegExp(`\\bon\\s+${collection.toLowerCase()}\\s*\\(([^)]*)\\)`).exec(normalized)?.[1]
  if (!/create\s+unique\s+index/.test(normalized) || !table) return false
  return table.split(',').map((column) => column.trim()).join(',') === columns.join(',')
}

async function verifyUniqueIndexesPresent(
  collections: { getOne: (name: string) => Promise<RecordModel> },
  name: string,
  indexes: readonly string[],
): Promise<void> {
  const collection = await collections.getOne(name)
  const value = collection as RecordModel & Record<string, unknown>
  const currentIndexes = Array.isArray(value.indexes) ? value.indexes.filter((item): item is string => typeof item === 'string') : []
  for (const index of indexes) {
    const match = /on\s+([\w-]+)\s*\(([^)]*)\)/i.exec(index)
    const columns = match ? match[2].split(',').map((column) => column.trim()) : []
    const verified = Boolean(match && columns.length > 0 && currentIndexes.some((candidate) => indexCoversUniqueColumns(candidate, match[1], columns)))
    if (!verified) {
      throw new Error(`PocketBase unique index could not be verified for ${name}`)
    }
  }
}

export async function ensureApplicationCollections(client: PocketBase): Promise<void> {
  await ensureCollection(client, 'user_preferences', [
    field('user_id', 'text', { required: true }),
    field('preferences', 'json'),
    field('updated_at', 'number', { required: true }),
  ], ['CREATE UNIQUE INDEX idx_user_preferences_user ON user_preferences (user_id)'])

  await ensureCollection(client, 'agents', [
    field('user_id', 'text', { required: true }),
    field('name', 'text', { required: true }),
    field('description', 'text'),
    field('mode', 'select', { required: true, values: ['primary', 'subagent'], maxSelect: 1 }),
    field('prompt', 'text'),
    field('systemPrompt', 'text'),
    field('enabled', 'bool'),
    field('template', 'select', { values: ['general', 'coding', 'plan', 'reviewer'], maxSelect: 1 }),
    field('model', 'text'),
    field('thinking', 'select', { values: ['off', 'minimal', 'low', 'medium', 'high'], maxSelect: 1 }),
    field('approval_mode', 'select', { values: ['auto', 'ask', 'deny'], maxSelect: 1 }),
    field('policies', 'json'),
    field('project_overrides', 'json'),
    field('tool_context_modes', 'json'),
    field('skill_context_modes', 'json'),
    field('effective_source', 'json'),
    field('created_at', 'number', { required: true }),
    field('updated_at', 'number', { required: true }),
  ], ['CREATE UNIQUE INDEX idx_agents_user_name ON agents (user_id, name)'])

  await ensureCollection(client, 'tool_registry', [
    field('tool_id', 'text', { required: true }),
    field('namespace', 'text', { required: true }),
    field('description', 'text'),
    field('adapter', 'select', { required: true, values: ['internal', 'http', 'openapi', 'mcp'], maxSelect: 1 }),
    field('target', 'text'),
    field('operation', 'text'),
    field('input_schema', 'json'),
    field('output_schema', 'json'),
    field('risk', 'select', { required: true, values: ['read', 'write', 'delete', 'external'], maxSelect: 1 }),
    field('requires_approval', 'bool'),
    field('enabled', 'bool'),
    field('metadata', 'json'),
    field('created_at', 'number', { required: true }),
    field('updated_at', 'number', { required: true }),
  ], ['CREATE UNIQUE INDEX idx_tool_registry_tool_id ON tool_registry (tool_id)'])

  await ensureCollection(client, 'agent_tool_policies', [
    field('user_id', 'text', { required: true }),
    field('agent_id', 'text', { required: true }),
    field('tool_id', 'text', { required: true }),
    field('effect', 'select', { required: true, values: ['allow', 'deny', 'approval'], maxSelect: 1 }),
    field('created_at', 'number', { required: true }),
    field('updated_at', 'number', { required: true }),
  ], ['CREATE UNIQUE INDEX idx_agent_tool_policies_agent_tool ON agent_tool_policies (user_id, agent_id, tool_id)'])

  await ensureCollection(client, 'tool_approvals', [
    field('user_id', 'text', { required: true }),
    field('agent_id', 'text', { required: true }),
    field('session_id', 'text'),
    field('tool_id', 'text', { required: true }),
    field('input', 'json'),
    field('status', 'select', { required: true, values: ['pending', 'approved', 'rejected', 'expired'], maxSelect: 1 }),
    field('reason', 'text'),
    field('created_at', 'number', { required: true }),
    field('resolved_at', 'number'),
  ], ['CREATE INDEX idx_tool_approvals_pending ON tool_approvals (user_id, status, created_at)'])

  await ensureCollection(client, 'tool_approval_continuations', [
    field('approval_id', 'text', { required: true }),
    field('user_id', 'text', { required: true }),
    field('claimed_at', 'number', { required: true }),
    field('claim_expires_at', 'number'),
    field('claim_state', 'select', { values: ['active', 'interrupted'], maxSelect: 1 }),
    field('interrupted_at', 'number'),
  ], ['CREATE UNIQUE INDEX idx_tool_approval_continuation_approval ON tool_approval_continuations (approval_id)'], true)

  await ensureCollection(client, 'tool_approval_resolutions', [
    field('approval_id', 'text', { required: true }),
    field('user_id', 'text', { required: true }),
    field('state', 'select', { required: true, values: ['approved', 'rejected', 'expired'], maxSelect: 1 }),
    field('claimed_at', 'number', { required: true }),
    field('claim_expires_at', 'number'),
    field('claim_state', 'select', { values: ['active', 'interrupted'], maxSelect: 1 }),
    field('interrupted_at', 'number'),
  ], ['CREATE UNIQUE INDEX idx_tool_approval_resolution_approval ON tool_approval_resolutions (approval_id)'], true)

  await ensureCollection(client, 'tool_call_audit', [
    field('user_id', 'text', { required: true }),
    field('agent_id', 'text'),
    field('session_id', 'text'),
    field('tool_id', 'text', { required: true }),
    field('input', 'json'),
    field('status', 'select', { required: true, values: ['success', 'error', 'approval_required', 'denied'], maxSelect: 1 }),
    field('result_summary', 'text'),
    field('error_code', 'text'),
    field('error_message', 'text'),
    field('approval_id', 'text'),
    field('created_at', 'number', { required: true }),
  ], ['CREATE INDEX idx_tool_call_audit_user_created ON tool_call_audit (user_id, created_at)'])

  await ensureCollection(client, 'gateway_credentials', [
    field('owner_id', 'text', { required: true }),
    field('principal', 'text', { required: true }),
    field('prefix', 'text', { required: true }),
    field('secret_hash', 'text', { required: true }),
    field('permissions', 'json', { required: true }),
    field('project_ids', 'json'),
    field('agent_names', 'json'),
    field('session_ids', 'json'),
    field('created_at', 'number', { required: true }),
    field('expires_at', 'number'),
    field('revoked_at', 'number'),
    field('last_used_at', 'number'),
  ], ['CREATE UNIQUE INDEX idx_gateway_credentials_prefix ON gateway_credentials (prefix)'])
}

function escapeFilter(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
}

export async function getUserPreferences(client: PocketBase, userId: string): Promise<UserPreferencesRecord | null> {
  const safe = escapeFilter(userId)
  return await client.collection('user_preferences').getFirstListItem(`user_id = "${safe}"`).catch(() => null) as UserPreferencesRecord | null
}

export async function saveUserPreferences(client: PocketBase, userId: string, preferences: Record<string, unknown>): Promise<UserPreferencesRecord> {
  const existing = await getUserPreferences(client, userId)
  const data = { user_id: userId, preferences, updated_at: Date.now() }
  return (existing
    ? await client.collection('user_preferences').update(existing.id, data)
    : await client.collection('user_preferences').create(data)) as UserPreferencesRecord
}

export { escapeFilter }
