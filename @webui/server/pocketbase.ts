import PocketBase, { type RecordModel } from 'pocketbase'
import { ensureBrowserSessionCollections } from './browser/schema.ts'

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

function indexName(index: string): string | undefined {
  return /\bcreate\s+(?:unique\s+)?index\s+([\w-]+)/i.exec(index)?.[1]?.toLowerCase()
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
  const desiredNames = new Set(indexes.map(indexName).filter((name): name is string => name !== undefined))
  const reconciledIndexes = [
    ...currentIndexes.filter((index) => {
      const name = indexName(index)
      return name === undefined || !desiredNames.has(name)
    }),
    ...indexes,
  ]
  const indexesChanged = reconciledIndexes.length !== currentIndexes.length || reconciledIndexes.some((index, position) => index !== currentIndexes[position])
  if (missing.length > 0 || indexesChanged) {
    await collections.update(String(existing.id), {
      ...(missing.length > 0 ? { fields: [...currentFields, ...missing] } : {}),
      ...(indexesChanged ? { indexes: reconciledIndexes } : {}),
    })
  }
  if (verifyUniqueIndexes) await verifyUniqueIndexesPresent(collections, name, indexes)
}

function indexCoversUniqueColumns(index: string, collection: string, columns: readonly string[]): boolean {
  const normalized = index.toLowerCase().replaceAll('`', '').replaceAll('"', '').replace(/\s+/g, ' ')
  const prefix = new RegExp(`\\bon\\s+${collection.toLowerCase()}\\s*\\(`).exec(normalized)
  if (!/create\s+unique\s+index/.test(normalized) || !prefix) return false
  const table = normalized.slice(prefix.index + prefix[0].length, normalized.lastIndexOf(')'))
  const expected = columns.join(',').toLowerCase().replace(/\s+/g, ' ').trim()
  return table.split(',').map((column) => column.trim()).join(',') === expected
}

async function verifyUniqueIndexesPresent(
  collections: { getOne: (name: string) => Promise<RecordModel> },
  name: string,
  indexes: readonly string[],
): Promise<void> {
  const collection = await collections.getOne(name)
  const value = collection as RecordModel & Record<string, unknown>
  const currentIndexes = Array.isArray(value.indexes) ? value.indexes.filter((item): item is string => typeof item === 'string') : []
  for (const index of indexes.filter((value) => /create\s+unique\s+index/i.test(value))) {
    const match = /on\s+([\w-]+)\s*\(/i.exec(index)
    const columns = match ? index.slice(index.indexOf('(', match.index) + 1, index.lastIndexOf(')')).split(',').map((column) => column.trim()) : []
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

  await ensureBrowserSessionCollections(client)

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
    field('owner_id', 'text'),
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

  await ensureCollection(client, 'memory_records', [
    field('owner_id', 'text', { required: true }),
    field('scope', 'select', { required: true, values: ['user', 'agent', 'project'], maxSelect: 1 }),
    field('agent_id', 'text'),
    field('project_id', 'text'),
    field('content', 'text', { required: true }),
    field('metadata', 'json'),
    field('created_at', 'number', { required: true }),
    field('updated_at', 'number', { required: true }),
    field('version', 'number', { required: true }),
    field('tombstone', 'bool', { required: true }),
    field('idempotency_key', 'text'),
  ], ['CREATE UNIQUE INDEX idx_memory_owner_idempotency ON memory_records (owner_id, idempotency_key)', 'CREATE INDEX idx_memory_owner_updated ON memory_records (owner_id, updated_at)', 'CREATE INDEX idx_memory_owner_scope ON memory_records (owner_id, scope)'], true)

  await ensureCollection(client, 'skills', [
    field('ownerId', 'text', { required: true }),
    field('skillId', 'text', { required: true }),
    field('identityKey', 'text', { required: true }),
    field('name', 'text', { required: true }),
    field('scope', 'select', { required: true, values: ['global', 'agent', 'project'], maxSelect: 1 }),
    field('agentId', 'text'),
    field('projectId', 'text'),
    field('mode', 'select', { required: true, values: ['always-loaded', 'discoverable', 'explicit-only', 'disabled'], maxSelect: 1 }),
    field('version', 'number', { required: true }),
    field('metadata', 'json', { required: true }),
    field('body', 'text', { required: true }),
    field('reference', 'text'),
  ], ['CREATE UNIQUE INDEX idx_skills_owner_identity ON skills (ownerId, identityKey)', 'CREATE INDEX idx_skills_owner_scope ON skills (ownerId, scope)'], true)

  await ensureCollection(client, 'skill_versions', [
    field('ownerId', 'text', { required: true }),
    field('skillHeadId', 'text', { required: true }),
    field('skillId', 'text', { required: true }),
    field('name', 'text', { required: true }),
    field('scope', 'select', { required: true, values: ['global', 'agent', 'project'], maxSelect: 1 }),
    field('agentId', 'text'),
    field('projectId', 'text'),
    field('mode', 'select', { required: true, values: ['always-loaded', 'discoverable', 'explicit-only', 'disabled'], maxSelect: 1 }),
    field('version', 'number', { required: true }),
    field('metadata', 'json', { required: true }),
    field('body', 'text', { required: true }),
    field('reference', 'text'),
  ], ['CREATE UNIQUE INDEX idx_skill_versions_owner_identity_version ON skill_versions (ownerId, skillHeadId, version)', 'CREATE INDEX idx_skill_versions_owner_skill ON skill_versions (ownerId, skillId)'], true)

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

  await ensureCollection(client, 'automations', [
    field('owner_id', 'text', { required: true }), field('name', 'text', { required: true }), field('prompt', 'text', { required: true }),
    field('agent_id', 'text', { required: true }), field('project_id', 'text'), field('timezone', 'text', { required: true }), field('schedule', 'json', { required: true }),
    field('retry_policy', 'json'), field('concurrency_policy', 'select', { values: ['allow', 'skip', 'queue'], maxSelect: 1 }), field('state', 'select', { required: true, values: ['active', 'paused', 'disabled', 'deleted'], maxSelect: 1 }),
    field('next_run_at', 'number'), field('last_run_at', 'number'), field('created_at', 'number', { required: true }), field('updated_at', 'number', { required: true }),
  ], ['CREATE INDEX idx_automations_owner_next ON automations (owner_id, state, next_run_at)'])
  await ensureCollection(client, 'automation_runs', [
    field('automation_id', 'text', { required: true }), field('owner_id', 'text', { required: true }), field('trigger_key', 'text', { required: true }),
    field('state', 'select', { required: true, values: ['pending', 'leased', 'running', 'succeeded', 'failed', 'retrying', 'cancelled', 'unknown', 'interrupted'], maxSelect: 1 }),
    field('attempt', 'number', { required: true }), field('lease_id', 'text'), field('lease_expires_at', 'number'), field('started_at', 'number'), field('finished_at', 'number'), field('result', 'json'), field('error_message', 'text'), field('created_at', 'number', { required: true }),
  ], ['CREATE UNIQUE INDEX idx_automation_runs_trigger ON automation_runs (owner_id, automation_id, trigger_key)', 'CREATE INDEX idx_automation_runs_owner ON automation_runs (owner_id, created_at)'], true)
  await ensureCollection(client, 'inbox_items', [
    field('owner_id', 'text', { required: true }), field('project_id', 'text'), field('kind', 'select', { required: true, values: ['approval_required', 'agent_question', 'task_completed', 'task_failed', 'review_required', 'automation_result', 'browser_approval'], maxSelect: 1 }),
    field('reference_id', 'text', { required: true }), field('identity_key', 'text'), field('title', 'text', { required: true }), field('body', 'text'), field('deep_link', 'json'), field('resolved', 'bool', { required: true }), field('underlying_state', 'text'), field('metadata', 'json'), field('created_at', 'number', { required: true }), field('resolved_at', 'number'),
  ], ["CREATE UNIQUE INDEX idx_inbox_dedupe ON inbox_items (owner_id, COALESCE(project_id, ''), kind, reference_id)", 'CREATE INDEX idx_inbox_owner ON inbox_items (owner_id, resolved, created_at)'], true)
  await ensureCollection(client, 'notification_subscriptions', [field('owner_id', 'text', { required: true }), field('channel', 'select', { required: true, values: ['push', 'email'], maxSelect: 1 }), field('target', 'text', { required: true }), field('enabled', 'bool', { required: true }), field('created_at', 'number', { required: true })], ['CREATE INDEX idx_notification_subscriptions_owner ON notification_subscriptions (owner_id)'])
  await ensureCollection(client, 'notification_deliveries', [field('owner_id', 'text', { required: true }), field('inbox_id', 'text', { required: true }), field('subscription_id', 'text', { required: true }), field('delivery_key', 'text', { required: true }), field('state', 'select', { required: true, values: ['pending', 'delivered', 'failed'], maxSelect: 1 }), field('attempt', 'number', { required: true }), field('lease_id', 'text'), field('lease_expires_at', 'number'), field('next_attempt_at', 'number'), field('last_attempt_at', 'number'), field('failure_class', 'select', { values: ['retryable', 'permanent'], maxSelect: 1 }), field('error_message', 'text'), field('created_at', 'number', { required: true }), field('updated_at', 'number', { required: true })], ['CREATE UNIQUE INDEX idx_notification_deliveries_key ON notification_deliveries (delivery_key)', 'CREATE INDEX idx_notification_deliveries_inbox ON notification_deliveries (owner_id, inbox_id, created_at)', 'CREATE INDEX idx_notification_deliveries_due ON notification_deliveries (state, next_attempt_at, lease_expires_at)'], true)

  await ensureCollection(client, 'message_deliveries', [
    field('owner_id', 'text', { required: true }), field('session_id', 'text', { required: true }), field('message_id', 'text', { required: true }),
    field('content', 'text', { required: true }), field('metadata', 'json', { required: true }), field('state', 'select', { required: true, values: ['pending', 'running', 'completed', 'interrupted', 'unknown'], maxSelect: 1 }),
    field('created_at', 'number', { required: true }), field('updated_at', 'number', { required: true }), field('response', 'json'),
  ], ['CREATE UNIQUE INDEX idx_message_deliveries_key ON message_deliveries (owner_id, session_id, message_id)', 'CREATE INDEX idx_message_deliveries_pending ON message_deliveries (owner_id, session_id, state, updated_at)'], true)
  await ensureCollection(client, 'message_queue', [
    field('owner_id', 'text', { required: true }), field('session_id', 'text', { required: true }), field('client_id', 'text', { required: true }), field('content', 'text', { required: true }),
    field('kind', 'select', { required: true, values: ['steering', 'follow_up'], maxSelect: 1 }), field('state', 'select', { required: true, values: ['steering', 'enqueued', 'delivered', 'failed', 'cancelled'], maxSelect: 1 }),
    field('position', 'number', { required: true }), field('created_at', 'number', { required: true }), field('updated_at', 'number', { required: true }), field('error', 'text'),
  ], ['CREATE UNIQUE INDEX idx_message_queue_key ON message_queue (owner_id, session_id, client_id)', 'CREATE INDEX idx_message_queue_ready ON message_queue (owner_id, session_id, state, position, created_at)'], true)
  await ensureCollection(client, 'runtime_runs', [
    field('owner_id', 'text', { required: true }), field('session_id', 'text', { required: true }), field('run_id', 'text', { required: true }), field('request_id', 'text'),
    field('state', 'select', { required: true, values: ['starting', 'running', 'waiting_for_approval', 'completed', 'failed', 'interrupted', 'unknown'], maxSelect: 1 }),
    field('created_at', 'number', { required: true }), field('updated_at', 'number', { required: true }), field('error', 'text'),
  ], ['CREATE UNIQUE INDEX idx_runtime_runs_key ON runtime_runs (owner_id, session_id, run_id)', 'CREATE INDEX idx_runtime_runs_state ON runtime_runs (owner_id, session_id, state, updated_at)'], true)
  await ensureCollection(client, 'durable_events', [
    field('owner_id', 'text', { required: true }), field('cursor', 'number', { required: true }), field('session_id', 'text'), field('type', 'text', { required: true }),
    field('payload', 'json', { required: true }), field('occurred_at', 'number', { required: true }), field('payload_bytes', 'number', { required: true }),
  ], ['CREATE UNIQUE INDEX idx_durable_events_cursor ON durable_events (owner_id, cursor)', 'CREATE INDEX idx_durable_events_owner ON durable_events (owner_id, cursor)', 'CREATE INDEX idx_durable_events_retention ON durable_events (occurred_at)'], true)
  await ensureCollection(client, 'proxy_credentials', [
    field('owner_id', 'text', { required: true }), field('credential_id', 'text', { required: true }), field('prefix', 'text', { required: true }), field('secret_hash', 'text', { required: true }),
    field('created_at', 'number', { required: true }), field('last_used_at', 'number'), field('revoked_at', 'number'),
  ], ['CREATE UNIQUE INDEX idx_proxy_credentials_id ON proxy_credentials (credential_id)', 'CREATE UNIQUE INDEX idx_proxy_credentials_prefix ON proxy_credentials (prefix)'], true)
  await ensureCollection(client, 'metadata_migrations', [
    field('user_id', 'text', { required: true }), field('migration_name', 'text', { required: true }), field('migrated_at', 'number', { required: true }), field('result', 'json'),
  ], ['CREATE UNIQUE INDEX idx_metadata_migrations_key ON metadata_migrations (user_id, migration_name)'], true)
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
