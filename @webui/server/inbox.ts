import type PocketBase from 'pocketbase'
import { escapeFilter } from './pocketbase.ts'
import { redactSensitive, redactSensitiveText } from './security-redaction.ts'

export type InboxKind = 'approval_required' | 'agent_question' | 'task_completed' | 'task_failed' | 'review_required' | 'automation_result' | 'browser_approval'
export type InboxItem = { id: string; owner_id: string; project_id?: string; kind: InboxKind; reference_id: string; title: string; body?: string; deep_link?: Record<string, string>; resolved: boolean; underlying_state?: string; metadata?: unknown; created_at: number; resolved_at?: number }
export type InboxUpsertInput = Omit<InboxItem, 'id' | 'resolved' | 'created_at'> & { reopen?: boolean }

const INBOX_KINDS: readonly InboxKind[] = ['approval_required', 'agent_question', 'task_completed', 'task_failed', 'review_required', 'automation_result', 'browser_approval']
const MAX_IDENTIFIER = 200
const MAX_TITLE = 200
const MAX_BODY = 12000
const MAX_DEEP_LINK_ENTRIES = 16
const MAX_DEEP_LINK_VALUE = 500
const MAX_DEEP_LINK_SIZE = 4000
const MAX_METADATA = 16000
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/
const SENSITIVE_KEY = /(?:pass(word)?|secret|token|api[-_]?key|access[-_]?token|refresh[-_]?token|authorization|cookie|credential|private[-_]?key)/i
const DEEP_LINK_ID_KEYS = new Set(['taskId', 'projectId', 'sessionId', 'automationId', 'runId', 'browserSessionId'])
const ENCODED_ID = /^[A-Za-z0-9._~!$&'()*+,;=:@%-]+$/
const inboxLocks = new WeakMap<object, Map<string, Promise<void>>>()

function validOwner(ownerId: string): string {
  if (typeof ownerId !== 'string' || !ownerId.trim() || ownerId.length > MAX_IDENTIFIER || CONTROL_CHARACTERS.test(ownerId)) throw new Error('Invalid inbox owner')
  return ownerId.trim()
}

function boundedText(value: unknown, max: number, name: string, required = false): string | undefined {
  if (value === undefined) {
    if (required) throw new Error(`Invalid inbox ${name}`)
    return undefined
  }
  if (typeof value !== 'string') throw new Error(`Invalid inbox ${name}`)
  const text = redactSensitiveText(value).trim()
  if ((!text && required) || text.length > max || CONTROL_CHARACTERS.test(text)) throw new Error(`Invalid inbox ${name}`)
  return text || undefined
}

function encodedId(value: string): boolean {
  if (!value || value.length > MAX_IDENTIFIER || !ENCODED_ID.test(value)) return false
  try {
    const decoded = decodeURIComponent(value)
    return Boolean(decoded) && !/[\s\\\u0000-\u001f\u007f]/.test(decoded) && encodeURIComponent(decoded) === value
  } catch {
    return false
  }
}

function internalDeepLinkPath(value: string): boolean {
  if (value === '/' || ['/home', '/agents', '/projects', '/repos', '/automations', '/history', '/settings', '/new'].includes(value)) return true
  if (!value.startsWith('/') || value.startsWith('//') || /[?#\\\s]/.test(value)) return false
  const segments = value.slice(1).split('/')
  if (segments.some((segment) => !segment)) return false
  const [section, first, third, fourth] = segments
  if (section === 'tasks' || section === 'runs') return segments.length === 2 && encodedId(first)
  if (section === 'agents') return segments.length === 2 && encodedId(first)
  if (section === 'new') return (segments.length === 2 && encodedId(first)) || (segments.length === 3 && encodedId(first) && encodedId(third))
  if (section === 'automations') return (segments.length === 1) || (segments.length === 2 && encodedId(first))
  if (section === 'projects' || section === 'repos') {
    if (!encodedId(first)) return false
    if (segments.length === 3 && third === 'automations') return true
    return segments.length === 4 && third === 'sessions' && encodedId(fourth)
  }
  return false
}

export function sanitizeDeepLink(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid inbox deep link')
  const entries = Object.entries(value)
  if (entries.length > MAX_DEEP_LINK_ENTRIES) throw new Error('Inbox deep link is too large')
  const result: Record<string, string> = {}
  for (const [key, rawValue] of entries) {
    if ((!DEEP_LINK_ID_KEYS.has(key) && key !== 'path') || SENSITIVE_KEY.test(key) || typeof rawValue !== 'string') throw new Error('Invalid inbox deep link')
    const sanitized = redactSensitiveText(rawValue).trim()
    const validValue = key === 'path' ? internalDeepLinkPath(sanitized) : encodedId(sanitized)
    if (sanitized !== rawValue.trim() || !sanitized || sanitized.length > MAX_DEEP_LINK_VALUE || CONTROL_CHARACTERS.test(sanitized) || !validValue) throw new Error('Invalid inbox deep link')
    result[key] = sanitized
  }
  if (JSON.stringify(result).length > MAX_DEEP_LINK_SIZE) throw new Error('Inbox deep link is too large')
  return result
}

function validateMetadata(value: unknown, depth = 0): void {
  if (depth > 8) throw new Error('Inbox metadata is too deeply nested')
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Invalid inbox metadata')
    return
  }
  if (typeof value === 'string') {
    if (CONTROL_CHARACTERS.test(value) || value.length > MAX_BODY) throw new Error('Invalid inbox metadata')
    return
  }
  if (Array.isArray(value)) {
    if (value.length > 64) throw new Error('Inbox metadata is too large')
    value.forEach((item) => validateMetadata(item, depth + 1))
    return
  }
  if (!value || typeof value !== 'object') throw new Error('Invalid inbox metadata')
  const entries = Object.entries(value)
  if (entries.length > 64) throw new Error('Inbox metadata is too large')
  for (const [key, item] of entries) {
    if (key.length > 100 || CONTROL_CHARACTERS.test(key)) throw new Error('Invalid inbox metadata')
    validateMetadata(item, depth + 1)
  }
}

function safeMetadata(value: unknown): unknown {
  if (value === undefined) return undefined
  let sanitized: unknown
  let encoded: string | undefined
  try {
    sanitized = redactSensitive(value)
    validateMetadata(sanitized)
    encoded = JSON.stringify(sanitized)
  } catch {
    throw new Error('Invalid inbox metadata')
  }
  if (encoded === undefined || encoded.length > MAX_METADATA) throw new Error('Inbox metadata is too large')
  return sanitized
}

function safeInput(input: InboxUpsertInput): { data: Omit<InboxItem, 'id' | 'resolved' | 'created_at'> & { identity_key: string }; reopen: boolean } {
  const owner_id = validOwner(input.owner_id)
  const project_id = input.project_id === undefined ? undefined : boundedText(input.project_id, MAX_IDENTIFIER, 'project id', true)
  const reference_id = boundedText(input.reference_id, MAX_IDENTIFIER, 'reference id', true)
  if (!reference_id || !INBOX_KINDS.includes(input.kind)) throw new Error('Invalid inbox identity')
  const title = boundedText(input.title, MAX_TITLE, 'title', true)
  if (!title) throw new Error('Invalid inbox title')
  const body = boundedText(input.body, MAX_BODY, 'body')
  const deep_link = sanitizeDeepLink(input.deep_link)
  const metadata = safeMetadata(input.metadata)
  if (input.reopen !== undefined && typeof input.reopen !== 'boolean') throw new Error('Invalid inbox reopen transition')
  const underlyingState = input.underlying_state === undefined ? undefined : boundedText(input.underlying_state, MAX_IDENTIFIER, 'underlying state', true)
  return {
    data: {
      owner_id,
      ...(project_id ? { project_id } : {}),
      kind: input.kind,
      reference_id,
      identity_key: identityKey({ owner_id, project_id, kind: input.kind, reference_id }),
      title,
      ...(body === undefined ? {} : { body }),
      ...(deep_link === undefined ? {} : { deep_link }),
      ...(underlyingState === undefined ? {} : { underlying_state: underlyingState }),
      ...(metadata === undefined ? {} : { metadata }),
    },
    reopen: input.reopen === true,
  }
}

function projectKey(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null
}

function identityKey(input: Pick<InboxItem, 'kind' | 'reference_id' | 'owner_id'> & { project_id?: string }): string {
  return JSON.stringify([input.owner_id, input.project_id ?? null, input.kind, input.reference_id])
}

async function withInboxLock<T>(client: object, key: string, work: () => Promise<T>): Promise<T> {
  let locks = inboxLocks.get(client)
  if (!locks) {
    locks = new Map()
    inboxLocks.set(client, locks)
  }
  const previous = locks.get(key) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => { release = resolve })
  locks.set(key, current)
  await previous
  try {
    return await work()
  } finally {
    release()
    if (locks.get(key) === current) locks.delete(key)
  }
}

function sameIdentity(value: Record<string, unknown>, input: Omit<InboxItem, 'id' | 'resolved' | 'created_at'>): boolean {
  return value.owner_id === input.owner_id
    && value.kind === input.kind
    && value.reference_id === input.reference_id
    && projectKey(value.project_id) === projectKey(input.project_id)
}

function inboxRecord(value: Record<string, unknown>): InboxItem {
  const body = boundedText(value.body, MAX_BODY, 'body')
  let deep_link: Record<string, string> | undefined
  try { deep_link = sanitizeDeepLink(value.deep_link) } catch { deep_link = undefined }
  let metadata: unknown
  try { metadata = safeMetadata(value.metadata) } catch { metadata = undefined }
  const state = boundedText(value.underlying_state, MAX_IDENTIFIER, 'underlying state')
  return {
    id: String(value.id),
    owner_id: String(value.owner_id),
    ...(typeof value.project_id === 'string' ? { project_id: value.project_id } : {}),
    kind: value.kind as InboxKind,
    reference_id: String(value.reference_id),
    title: boundedText(value.title, MAX_TITLE, 'title', true) ?? 'Inbox notification',
    ...(body === undefined ? {} : { body }),
    ...(deep_link === undefined ? {} : { deep_link }),
    resolved: value.resolved === true,
    ...(state === undefined ? {} : { underlying_state: state }),
    ...(metadata === undefined ? {} : { metadata }),
    created_at: typeof value.created_at === 'number' ? value.created_at : 0,
    ...(typeof value.resolved_at === 'number' ? { resolved_at: value.resolved_at } : {}),
  }
}

export class InboxRepository {
  constructor(private readonly client: PocketBase) {}

  async upsert(input: InboxUpsertInput): Promise<InboxItem> {
    const valid = safeInput(input)
    return withInboxLock(this.client as unknown as object, valid.data.identity_key, async () => {
      const filter = `owner_id = "${escapeFilter(valid.data.owner_id)}" && kind = "${escapeFilter(valid.data.kind)}" && reference_id = "${escapeFilter(valid.data.reference_id)}"`
      const candidates = await this.client.collection('inbox_items').getFullList({ filter, sort: '-created_at' }).catch(() => []) as Record<string, unknown>[]
      const existing = candidates.find((value) => sameIdentity(value, valid.data))
      if (existing) {
        const transitioned = valid.reopen || (valid.data.underlying_state !== undefined && valid.data.underlying_state !== existing.underlying_state)
        const data = {
          ...valid.data,
          resolved: transitioned ? false : existing.resolved === true,
          ...(transitioned ? { resolved_at: null } : existing.resolved === true && existing.resolved_at !== undefined ? { resolved_at: existing.resolved_at } : { resolved_at: null }),
        }
        return inboxRecord(await this.client.collection('inbox_items').update(String(existing.id), data))
      }
      try {
        return inboxRecord(await this.client.collection('inbox_items').create({ ...valid.data, resolved: false, created_at: Date.now() }))
      } catch (error) {
        // The unique index is the cross-process arbiter. A concurrent creator may
        // win after the read above; converge on that record instead of surfacing
        // a duplicate-key error to an otherwise idempotent caller.
        if (!(error instanceof Error) || !/duplicate|unique/i.test(error.message)) throw error
        const raced = await this.client.collection('inbox_items').getFullList({ filter, sort: '-created_at' }).catch(() => []) as Record<string, unknown>[]
        const winner = raced.find((value) => sameIdentity(value, valid.data))
        if (!winner) throw error
        const transitioned = valid.reopen || (valid.data.underlying_state !== undefined && valid.data.underlying_state !== winner.underlying_state)
        return inboxRecord(await this.client.collection('inbox_items').update(String(winner.id), {
          ...valid.data,
          resolved: transitioned ? false : winner.resolved === true,
          ...(transitioned ? { resolved_at: null } : winner.resolved === true && winner.resolved_at !== undefined ? { resolved_at: winner.resolved_at } : { resolved_at: null }),
        }))
      }
    })
  }

  async list(ownerId: string, projectId?: string): Promise<InboxItem[]> {
    const owner = validOwner(ownerId)
    const project = projectId === undefined ? undefined : boundedText(projectId, MAX_IDENTIFIER, 'project id', true)
    const rows = await this.client.collection('inbox_items').getFullList({ filter: `owner_id = "${escapeFilter(owner)}"${project ? ` && project_id = "${escapeFilter(project)}"` : ''}`, sort: '-created_at' }) as Record<string, unknown>[]
    return rows.filter((row) => row.owner_id === owner && (project === undefined || projectKey(row.project_id) === project)).map(inboxRecord)
  }

  async resolve(ownerId: string, id: string): Promise<InboxItem | null> {
    const owner = validOwner(ownerId)
    const item = await this.client.collection('inbox_items').getOne(id).catch(() => null) as Record<string, unknown> | null
    if (!item || item.owner_id !== owner) return null
    return inboxRecord(await this.client.collection('inbox_items').update(id, { resolved: true, resolved_at: Date.now() }))
  }

  async resolveReference(ownerId: string, kind: InboxKind, referenceId: string, projectId?: string): Promise<boolean> {
    const owner = validOwner(ownerId)
    if (!INBOX_KINDS.includes(kind) || typeof referenceId !== 'string' || !referenceId.trim()) return false
    const project = projectId === undefined ? undefined : boundedText(projectId, MAX_IDENTIFIER, 'project id', true)
    const rows = await this.client.collection('inbox_items').getFullList({ filter: `owner_id = "${escapeFilter(owner)}" && kind = "${escapeFilter(kind)}" && reference_id = "${escapeFilter(referenceId)}"` }) as Record<string, unknown>[]
    const item = rows.find((row) => row.owner_id === owner && row.kind === kind && row.reference_id === referenceId && (project === undefined || projectKey(row.project_id) === project))
    if (!item) return false
    await this.client.collection('inbox_items').update(String(item.id), { resolved: true, resolved_at: Date.now() })
    return true
  }
}
