import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'

import { homedir } from 'node:os'
import { createHash, randomBytes } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { Database } from 'bun:sqlite'
import {
  AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  parseSessionEntries,
  SessionManager,
} from '@earendil-works/pi-coding-agent'
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent'
import { Hono } from 'hono'
import { entriesPayload, projectEntries, type TranscriptMessage } from './transcript/projector'

import projectsExtension from './subpolar/extensions/projects.ts'
import usageExtension from './subpolar/extensions/usage.ts'
import sessionArchiveExtension from './subpolar/extensions/session-archive.ts'
import sessionTitleExtension from './subpolar/extensions/session-title.ts'
import sessionHistorySearchExtension from './subpolar/extensions/session-history-search.ts'
import listToolsExtension from './subpolar/extensions/list-tools.ts'
import openapiTools from './subpolar/extensions/openapi-tools.ts'
import { createToolRoutingExtension } from './subpolar/extensions/tool-routing.ts'
import {
  authenticateRequest,
  authConfig,
  changePassword,
  clearAuthCookie,
  signIn,
  signOut,
  signUp,
  syncAdminFromEnv,
  getPocketBaseAdmin,
  ensureApplicationCollections,
  getUserPreferences,
  saveUserPreferences,
  type PocketBaseUser,
} from './server/index.ts'
import {
  authorizePiToolCall,
  callTool,
  describeToolForAgent,
  ensureToolRegistry,
  ensureUserDefaults,
  listAgents,
  listPendingApprovals,
  listToolsForAgent,
  searchToolsForAgent,
  upsertRegisteredTool,
  respondToApproval,
  continueApprovedTool,
  createProjectSessionRepository,
  ensureProjectSessionCollections,
  createSessionContextResolver,
  createToolGatewayFromCallTool,
  loadAgentRuntime,
  type PermissionOverride,
  type ToolGateway,
} from './server/index.ts'

type Project = { name: string; path: string }
type SessionRecord = {
  id: string
  project: string
  title: string
  createdAt: number
  updatedAt: number
  archived?: boolean
  profile?: string
  model?: string
  directory?: string
  userId?: string
  permissionOverride?: PermissionOverride
}
type RpcCommand = Record<string, unknown> & { type: string }
type RpcMessage = Record<string, unknown> & { type?: string; id?: string }

type SocketData = { sessionId: string; unsubscribe?: () => void; history?: TranscriptMessage[]; leafId?: string | null; historyReady?: boolean; buffered?: RpcMessage[] }
type PendingPrompt = { content: string; metadata?: Record<string, unknown> }
type SseClient = { enqueue: (chunk: Uint8Array) => void; close: () => void }
type ProxyCredential = { id: string; prefix: string; hash: string; createdAt: number; lastUsedAt?: number }

const root = resolve(import.meta.dir, '..')
const webuiDir = import.meta.dir
const subpolarDataDir = join(homedir(), '.subpolar')
const databasePath = join(subpolarDataDir, 'subpolar.sqlite')
const legacyStatePath = join(webuiDir, '.sessions.json')

const legacyProjectStatePath = join(subpolarDataDir, 'projects.json')
const generalChatRoot = join(subpolarDataDir, 'general-chat')
const legacyProxyCredentialsPath = join(subpolarDataDir, 'proxy-credentials.json')
const port = Number(process.env.WEBUI_PORT ?? 4173)
const internalToken = process.env.SUBPOLAR_INTERNAL_TOKEN || randomBytes(32).toString('hex')
process.env.SUBPOLAR_INTERNAL_TOKEN = internalToken
let applicationDatabasePromise: ReturnType<typeof getPocketBaseAdmin> | undefined
let applicationCollectionsReady: Promise<void> | undefined
let inProcessToolGateway: ToolGateway | undefined
const migratedUsers = new Set<string>()

async function applicationDatabase() {
  if (!applicationDatabasePromise) {
    applicationDatabasePromise = getPocketBaseAdmin().catch((error) => {
      applicationDatabasePromise = undefined
      throw error
    })
  }
  const client = await applicationDatabasePromise
  if (!applicationCollectionsReady) {
    applicationCollectionsReady = ensureApplicationCollections(client).then(() => ensureProjectSessionCollections(client)).then(() => ensureToolRegistry(client)).catch((error) => {
      applicationCollectionsReady = undefined
      throw error
    })
  }
  await applicationCollectionsReady
  if (!inProcessToolGateway) inProcessToolGateway = createToolGatewayFromCallTool(client, callTool)
  return client
}

void applicationDatabase().then(async () => {
  await syncAdminFromEnv()
  console.log('PocketBase application collections ready')
}).catch((error) => {
  console.warn(`PocketBase is not ready: ${error instanceof Error ? error.message : String(error)}`)
})

mkdirSync(subpolarDataDir, { recursive: true })
const database = new Database(databasePath, { create: true })
database.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS settings (
    user_id TEXT PRIMARY KEY,
    preferences TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS projects (
    name TEXT PRIMARY KEY,
    path TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    project TEXT NOT NULL,
    title TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    archived INTEGER NOT NULL DEFAULT 0,
    profile TEXT,
    model TEXT,
    directory TEXT,
    user_id TEXT,
    permission_override TEXT
  );
  CREATE TABLE IF NOT EXISTS proxy_credentials (
    id TEXT PRIMARY KEY,
    prefix TEXT NOT NULL,
    hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS legacy_metadata_migration (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    user_id TEXT NOT NULL,
    migrated_at INTEGER NOT NULL
  );
`)
try { database.exec('ALTER TABLE sessions ADD COLUMN user_id TEXT') } catch { /* already migrated */ }
try { database.exec('ALTER TABLE sessions ADD COLUMN permission_override TEXT') } catch { /* already migrated */ }
const allowedRpcCommands = new Set([
  'prompt', 'steer', 'follow_up', 'abort', 'clear_queue', 'new_session', 'get_state',
  'set_model', 'cycle_model', 'get_available_models', 'set_thinking_level',
  'cycle_thinking_level', 'get_available_thinking_levels', 'set_steering_mode',
  'set_follow_up_mode', 'compact', 'set_auto_compaction', 'set_auto_retry', 'abort_retry',
  'get_session_stats', 'get_entries', 'get_tree', 'get_last_assistant_text', 'set_session_name',
  'get_messages', 'get_commands', 'fork', 'clone', 'get_fork_messages',
])
const applicationExtensionPaths = [

  'projects.ts',
  'usage.ts',
  'session-archive.ts',
  'session-title.ts',
  'session-history-search.ts',
  'list-tools.ts',
  'openapi-tools.ts',
].map((file) => join(webuiDir, 'subpolar', 'extensions', file))

// The bridge is the application host now. These resources are loaded by the SDK
// directly; no Pi CLI process or RPC extension flags are involved.
const applicationExtensionFactories = [

  projectsExtension,
  usageExtension,
  sessionArchiveExtension,
  sessionTitleExtension,
  sessionHistorySearchExtension,
  listToolsExtension,
  openapiTools,
]
const modelRuntimePromise = ModelRuntime.create({ refreshOnCreate: true })

const DEFAULT_SETTINGS = {
  theme: 'dark', mode: 'build', autoScroll: true, expandDiffs: true,
  expandToolCalls: false, showReasoning: false, simpleChatMode: false,
  defaultModels: {}, hiddenSidebarAgents: ['auto', 'compaction', 'summary', 'title'],
  hiddenChatInputAgents: ['compaction', 'summary', 'title'], leaderKey: 'Cmd+O',
  directShortcuts: ['submit', 'abort'], keyboardShortcuts: {
    submit: 'Cmd+Enter', abort: 'Escape', toggleMode: 'T', undo: 'Z', redo: 'Shift+Z',
    compact: 'K', fork: 'F', settings: ',', sessions: 'S', newSession: 'N', closeSession: 'W',
    toggleSidebar: 'B', selectModel: 'M', variantCycle: 'Cmd+T',
  }, customCommands: [], gitCredentials: [], gitIdentity: { name: 'Pi Agent', email: '' },
  tts: { enabled: false }, stt: { enabled: false }, notifications: { enabled: false },
  integrations: [], repoSortMode: 'recent', serverEnvVars: [], disabledDefaultServerEnvVars: [],
}


type ProjectDefinition = { name: string; path: string }

function loadProjectDefinitions(): ProjectDefinition[] {
  const rows = database.query('SELECT name, path FROM projects ORDER BY name').all() as Array<{ name: string; path: string }>
  if (rows.length > 0 || !existsSync(legacyProjectStatePath)) return rows.map((row) => ({ name: row.name, path: resolve(row.path) }))
  try {
    const value = JSON.parse(readFileSync(legacyProjectStatePath, 'utf8')) as unknown
    if (!Array.isArray(value)) return []
    const definitions = value.flatMap((item) => {
      const entry = object(item)
      return typeof entry.name === 'string' && typeof entry.path === 'string'
        ? [{ name: entry.name, path: resolve(entry.path) }]
        : []
    })
    saveProjectDefinitions(definitions)
    return definitions
  } catch {
    return []
  }
}

function loadProxyCredentials(): ProxyCredential[] {
  const rows = database.query('SELECT id, prefix, hash, created_at, last_used_at FROM proxy_credentials ORDER BY created_at').all() as Array<{ id: string; prefix: string; hash: string; created_at: number; last_used_at: number | null }>
  if (rows.length > 0 || !existsSync(legacyProxyCredentialsPath)) return rows.map((row) => ({ id: row.id, prefix: row.prefix, hash: row.hash, createdAt: row.created_at, ...(row.last_used_at == null ? {} : { lastUsedAt: row.last_used_at }) }))
  try {
    const value = JSON.parse(readFileSync(legacyProxyCredentialsPath, 'utf8')) as unknown
    const credentials = Array.isArray(value) ? value.filter((item): item is ProxyCredential => {
      const entry = object(item)
      return typeof entry.id === 'string' && typeof entry.prefix === 'string' && typeof entry.hash === 'string' && typeof entry.createdAt === 'number'
    }) : []
    saveProxyCredentials(credentials)
    return credentials
  } catch {
    return []
  }
}

function saveProxyCredentials(credentials: ProxyCredential[]): void {
  const transaction = database.transaction((items: ProxyCredential[]) => {
    database.exec('DELETE FROM proxy_credentials')
    const insert = database.query('INSERT INTO proxy_credentials (id, prefix, hash, created_at, last_used_at) VALUES (?, ?, ?, ?, ?)')
    for (const credential of items) insert.run(credential.id, credential.prefix, credential.hash, credential.createdAt, credential.lastUsedAt ?? null)
  })
  transaction(credentials)
}

function hashProxySecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex')
}

function proxyCredentialResponse(credential: ProxyCredential) {
  return { id: credential.id, prefix: credential.prefix, createdAt: credential.createdAt, lastUsedAt: credential.lastUsedAt ?? null }
}

function saveProjectDefinitions(definitions: ProjectDefinition[]): void {
  const transaction = database.transaction((items: ProjectDefinition[]) => {
    database.exec('DELETE FROM projects')
    const insert = database.query('INSERT INTO projects (name, path) VALUES (?, ?)')
    for (const project of items) insert.run(project.name, resolve(project.path))
  })
  transaction(definitions)
}

function sessionWorkspace(id: string): string {
  return join(generalChatRoot, id)
}

function loadState(): SessionRecord[] {
  const rows = database.query('SELECT id, project, title, created_at, updated_at, archived, profile, model, directory, user_id, permission_override FROM sessions ORDER BY updated_at').all() as Array<Record<string, unknown>>
  if (rows.length > 0 || !existsSync(legacyStatePath)) return rows.map(sessionFromRow).filter(isSessionRecord)
  try {
    const value = JSON.parse(readFileSync(legacyStatePath, 'utf8')) as unknown
    const legacy = Array.isArray(value) ? value.filter(isSessionRecord) : []
    saveStateSync(legacy)
    return legacy
  } catch {
    return []
  }
}

function sessionFromRow(row: Record<string, unknown>): SessionRecord {
  return {
    id: String(row.id), project: String(row.project), title: String(row.title),
    createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
    ...(row.archived ? { archived: true } : {}),
    ...(typeof row.profile === 'string' ? { profile: row.profile } : {}),
    ...(typeof row.model === 'string' ? { model: row.model } : {}),
    ...(typeof row.directory === 'string' ? { directory: row.directory } : {}),
    ...(typeof row.user_id === 'string' ? { userId: row.user_id } : {}),
    ...(row.permission_override === 'ask' || row.permission_override === 'none' || row.permission_override === 'allow_all'
      ? { permissionOverride: row.permission_override } : {}),
  }
}

function isSessionRecord(value: unknown): value is SessionRecord {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<SessionRecord>
  return typeof item.id === 'string' && typeof item.project === 'string' && typeof item.title === 'string'
    && typeof item.createdAt === 'number' && typeof item.updatedAt === 'number'
}

let sessions = loadState()
const pendingPrompts = new Map<string, PendingPrompt>()
const sseClients = new Set<SseClient>()
const encoder = new TextEncoder()

function broadcastSse(value: unknown): void {
  const chunk = encoder.encode(`data: ${JSON.stringify(value)}\n\n`)
  for (const client of sseClients) {
    try { client.enqueue(chunk) } catch { client.close(); sseClients.delete(client) }
  }
}

function saveStateSync(records: SessionRecord[]): void {
  const transaction = database.transaction((items: SessionRecord[]) => {
    database.exec('DELETE FROM sessions')
    const insert = database.query('INSERT INTO sessions (id, project, title, created_at, updated_at, archived, profile, model, directory, user_id, permission_override) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    for (const session of items) insert.run(session.id, session.project, session.title, session.createdAt, session.updatedAt, session.archived ? 1 : 0, session.profile ?? null, session.model ?? null, session.directory ?? null, session.userId ?? null, session.permissionOverride ?? null)
  })
  transaction(records)
}

async function saveState(): Promise<void> {
  saveStateSync(sessions)
}

async function ensureUserMetadata(userId: string): Promise<void> {
  if (!userId || migratedUsers.has(userId)) return
  const client = await applicationDatabase()
  const repository = createProjectSessionRepository(client)
  await repository.ensureCollections()
  const marker = database.query('SELECT user_id FROM legacy_metadata_migration WHERE id = 1').get() as { user_id?: string } | null
  if (!marker) {
    await repository.migrateLegacyMetadata(userId, {
      projects: loadProjectDefinitions(),
      sessions,
    })
    database.query('INSERT OR REPLACE INTO legacy_metadata_migration (id, user_id, migrated_at) VALUES (1, ?, ?)').run(userId, Date.now())
  }
  migratedUsers.add(userId)
}

function filterValue(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
}

async function resolveToolSessionContext(client: Awaited<ReturnType<typeof applicationDatabase>>, userId: string, sessionId: string, requestedAgent?: string, requestedPermission?: PermissionOverride) {
  const repository = createProjectSessionRepository(client)
  const resolver = createSessionContextResolver({
    sessions: {
      getSession: async (id) => {
        const session = await repository.getSession(userId, id)
        if (!session) return null
        return {
          id: session.id,
          project: session.project,
          title: session.title,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
          ...(session.archived ? { archived: true } : {}),
          ...(session.profile ? { profile: session.profile } : {}),
          ...(session.model ? { model: session.model } : {}),
          ...(session.directory ? { directory: session.directory } : {}),
          userId: session.userId,
          ...(session.permissionOverride ? { permissionOverride: session.permissionOverride } : {}),
        }
      },
      getProject: async (name) => {
        if (name === 'General Chat') return { name, path: generalChatRoot }
        const project = await repository.findProjectByName(userId, name)
        return project ? { name: project.name, path: project.path } : null
      },
    },
    agents: {
      getAgent: async (owner, selector) => {
        const record = await client.collection('agents').getFirstListItem(`user_id = "${filterValue(owner)}" && (id = "${filterValue(selector)}" || name = "${filterValue(selector)}")`).catch(() => null)
        return record as { id: string; user_id: string; name: string; enabled?: boolean } | null
      },
    },
  })
  return resolver.resolve({ identity: userId, userId, sessionId, agentName: requestedAgent, permissionOverride: requestedPermission })
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function mapToolId(toolName: unknown): string {
  const names: Record<string, string> = { read: 'read', write: 'write', edit: 'edit', bash: 'bash', grep: 'grep', find: 'find', ls: 'ls' }
  return typeof toolName === 'string' ? names[toolName] ?? toolName : 'unknown'
}

function readProjectsFile(filePath: string, base: string): Project[] {
  if (!existsSync(filePath)) return []
  try {
    const source = object(JSON.parse(readFileSync(filePath, 'utf8')))
    const entries = object(source.projects ?? source)
    return Object.entries(entries).flatMap(([name, value]) => {
      const path = typeof value === 'string' ? value : object(value).path
      return typeof path === 'string' ? [{ name, path: resolve(base, path) }] : []
    })
  } catch {
    return []
  }
}

function projects(): Project[] {
  const values = [
    ...loadProjectDefinitions(),
    ...readProjectsFile(join(homedir(), '.pi', 'projects.json'), homedir()),
    ...readProjectsFile(join(homedir(), '.pi', 'agent', 'projects.json'), homedir()),
    ...readProjectsFile(join(root, '.pi', 'projects.json'), root),
  ]
  return [...new Map(values.map((project) => [project.name, project])).values()]
}

function generalChatProject(): Project {
  mkdirSync(generalChatRoot, { recursive: true })
  return { name: 'General Chat', path: generalChatRoot }
}

function nativeSessionsDir(): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR
    ? resolve(process.env.PI_CODING_AGENT_DIR.replace(/^~/, homedir()))
    : join(homedir(), '.pi', 'agent')
  return process.env.PI_CODING_AGENT_SESSION_DIR
    ? resolve(process.env.PI_CODING_AGENT_SESSION_DIR.replace(/^~/, homedir()))
    : join(agentDir, 'sessions')
}

function entryTimestamp(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return fallback
}

function nativeSessionRecord(filePath: string, knownProjects: Project[]): SessionRecord | undefined {
  try {
    const lines = readFileSync(filePath, 'utf8').split('\n')
    const header = object(JSON.parse(lines[0] ?? ''))
    if (header.type !== 'session' || typeof header.id !== 'string' || typeof header.cwd !== 'string') return undefined

    const sessionCwd = resolve(header.cwd as string)
    const project = knownProjects.find((item) => item.path === sessionCwd)
      ?? (sessionCwd.startsWith(`${generalChatRoot}/`) ? generalChatProject() : undefined)
    if (!project) return undefined

    const createdAt = entryTimestamp(header.timestamp, 0)
    let updatedAt = createdAt
    let title: string | undefined

    for (const line of lines) {
      if (!line.trim()) continue
      let entry: Record<string, unknown>
      try { entry = object(JSON.parse(line)) } catch { continue }
      updatedAt = Math.max(updatedAt, entryTimestamp(entry.timestamp, updatedAt))
      if (entry.type === 'session_info' && typeof entry.name === 'string' && entry.name.trim()) {
        title = entry.name.trim()
      }

    }

    return {
      id: header.id,
      project: project.name,
      directory: sessionCwd,
      // The first prompt is useful as a preview, but it is not a session name.
      // Keep the neutral title until the title extension emits session_info_changed.
      title: title ?? 'Untitled session',
      createdAt,
      updatedAt,
    }
  } catch {
    return undefined
  }
}

function nativeSessionRecords(): SessionRecord[] {
  const directory = nativeSessionsDir()
  if (!existsSync(directory)) return []

  try {
    const knownProjects = projects()
    return readdirSync(directory, { withFileTypes: true }).flatMap((projectDirectory) => {
      if (!projectDirectory.isDirectory()) return []
      return readdirSync(join(directory, projectDirectory.name), { withFileTypes: true }).flatMap((file) => {
        if (!file.isFile() || !file.name.endsWith('.jsonl')) return []
        const record = nativeSessionRecord(join(directory, projectDirectory.name, file.name), knownProjects)
        return record ? [record] : []
      })
    })
  } catch {
    return []
  }
}

function syncNativeSessions(): void {
  const current = new Map(sessions.map((session) => [session.id, session]))
  for (const native of nativeSessionRecords()) {
    const stored = current.get(native.id)
    if (!stored) {
      sessions.push(native)
      continue
    }
    if (stored.title === 'Untitled session' && native.title !== 'Untitled session') stored.title = native.title
    stored.createdAt = Math.min(stored.createdAt, native.createdAt)
    stored.updatedAt = Math.max(stored.updatedAt, native.updatedAt)
  }
}

function projectForSession(record: SessionRecord): Project | undefined {
  if (record.project === 'General Chat') return generalChatProject()
  return projects().find((project) => project.name === record.project)
}

function projectFor(name: string | undefined): Project {
  if (!name || name === '0' || name.toLocaleLowerCase() === 'general chat') return generalChatProject()
  const value = projects().find((project) => project.name === name)
  if (!value) throw new Error(`Unknown project: ${name}`)
  return value
}

function projectForId(id: number): Project {
  if (id === 0) return generalChatProject()
  const project = projects()[id - 1]
  if (!project) throw new Error(`Unknown project id: ${id}`)
  return project
}

function projectForDirectory(directory: string | undefined): Project {
  if (directory) {
    const value = projects().find((project) => project.path === resolve(directory))
    if (value) return value
  }
  return generalChatProject()
}


type SkillRecord = { name: string; description: string; body: string; scope: 'global' | 'project'; path: string; repoId?: number }

function skillDirectories(directory?: string): Array<{ scope: 'global' | 'project'; directory: string; repoId?: number }> {
  const result: Array<{ scope: 'global' | 'project'; directory: string; repoId?: number }> = []
  const projectDirectory = directory ? resolve(directory) : undefined
  if (projectDirectory) result.push({ scope: 'project', directory: join(projectDirectory, '.subpolar', 'skills') })
  else result.push({ scope: 'project', directory: join(root, '.subpolar', 'skills'), repoId: 1 })
  result.push({ scope: 'global', directory: join(homedir(), '.config', 'subpolar', 'skills') })
  result.push({ scope: 'global', directory: join(homedir(), '.pi', 'skills') })
  return result
}

function readSkills(directory?: string): SkillRecord[] {
  const result: SkillRecord[] = []
  for (const source of skillDirectories(directory)) {
    if (!existsSync(source.directory)) continue
    try {
      for (const entry of readdirSync(source.directory, { withFileTypes: true })) {
        const file = entry.isDirectory() ? join(source.directory, entry.name, 'SKILL.md') : entry.name === 'SKILL.md' ? join(source.directory, entry.name) : ''
        if (!file || !existsSync(file)) continue
        const content = readFileSync(file, 'utf8')
        const heading = content.match(/^#\s+(.+)$/m)
        const description = content.match(/^(?:description|summary):\s*(.+)$/im)?.[1]?.trim() ?? heading?.[1]?.trim() ?? ''
        const name = entry.isDirectory() ? entry.name : source.directory.split('/').pop() ?? 'skill'
        result.push({ name, description, body: content, scope: source.scope, path: file, repoId: source.repoId })
      }
    } catch { /* an unavailable skill directory should not break settings */ }
  }
  return [...new Map(result.map((skill) => [`${skill.scope}:${skill.repoId ?? ''}:${skill.name}`, skill])).values()]
}

function projectResponse(project: Project, id: number, isGeneralChat = false) {
  return {
    id,
    name: project.name,
    directory: project.path,
    fullPath: project.path,
    status: 'ready',
    createdAt: 0,
    updatedAt: 0,
    ...(isGeneralChat ? { isGeneralChat: true } : {}),
  }
}

function projectResponses() {
  return [
    projectResponse(generalChatProject(), 0, true),
    ...projects().map((project, index) => projectResponse(project, index + 1)),
  ]
}

async function ownedProjectResponses(userId: string, client: Awaited<ReturnType<typeof applicationDatabase>>) {
  await ensureUserMetadata(userId)
  const owned = await createProjectSessionRepository(client).listProjects(userId)
  return [
    projectResponse(generalChatProject(), 0, true),
    ...owned.map((project, index) => projectResponse({ name: project.name, path: project.path }, index + 1)),
  ]
}

function storedSessionResponse(record: SessionRecord) {
  const project = projectFor(record.project)
  const projectId = project.name === 'General Chat' ? 0 : Math.max(1, projects().findIndex((item) => item.name === project.name) + 1)
  return { ...record, archived: record.archived ?? false, projectId, directory: record.directory ?? project.path }
}

function rpcData(value: unknown): unknown {
  const response = object(value)
  return response.data ?? value
}

function parseModelSelection(model: string | undefined): { providerID: string; modelID: string } | undefined {
  if (!model) return undefined
  const [providerID, ...rest] = model.split('/')
  const modelID = rest.join('/')
  return providerID && modelID ? { providerID, modelID } : undefined
}

async function transcriptHistory(sessionId: string, selection?: Pick<SessionRecord, 'profile' | 'model'>) {
  const payload = entriesPayload(await sendRpc(sessionId, { type: 'get_entries' }))
  return { ...payload, messages: projectEntries(payload.entries, payload.leafId, sessionId, selection) }
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

async function body(request: Request): Promise<Record<string, unknown>> {
  try {
    return object(await request.json())
  } catch {
    return {}
  }
}

function sessionMessageText(message: unknown): string {
  const value = object(message)
  const content = value.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.flatMap((part) => {
    const item = object(part)
    return typeof item.text === 'string' ? [item.text] : typeof item.thinking === 'string' ? [item.thinking] : []
  }).join('\n')
}

class PiSdkSession {
  private readonly listeners = new Set<(message: RpcMessage) => void>()
  private readonly ready: Promise<void>
  private session!: AgentSession

  constructor(readonly record: SessionRecord, readonly project: Project) {
    this.ready = this.initialize()
  }

  private async initialize(): Promise<void> {
    const client = await applicationDatabase()
    const userId = this.record.userId
    if (!userId) throw new Error('Session has no authenticated owner')
    await ensureUserMetadata(userId)
    await ensureUserDefaults(client, userId)
    const runtime = await loadAgentRuntime(client, userId, this.record.profile ?? 'master')
    const sessionManager = await this.openOrCreateSession()
    const sessionCwd = this.record.directory ?? this.project.path
    const resourceLoader = new DefaultResourceLoader({
      cwd: this.project.path,
      agentDir: getAgentDir(),
      systemPrompt: runtime.systemPrompt,
      extensionFactories: [
        ...applicationExtensionFactories,
        createToolRoutingExtension({
          baseUrl: `http://127.0.0.1:${port}`,
          internalToken,
          gateway: inProcessToolGateway ?? createToolGatewayFromCallTool(client, callTool),
          userId,
          agentName: runtime.agent.name,
          sessionId: this.record.id,
          cwd: sessionCwd,
          permissionOverride: this.record.permissionOverride,
          onApproval: (approval) => {
            broadcastSse({
              type: 'permission.asked',
              directory: sessionCwd,
              properties: {
                id: approval.id,
                sessionID: approval.session_id,
                permission: approval.tool_id === 'bash' ? 'bash' : approval.tool_id,
                patterns: [approval.tool_id],
                metadata: { toolId: approval.tool_id, input: approval.input, reason: approval.reason },
                always: [],
              },
            })
          },
          listTools: () => listToolsForAgent(client, userId, runtime.agent.name),
          searchTools: (query) => searchToolsForAgent(client, userId, runtime.agent.name, query),
          describeTool: (toolId) => describeToolForAgent(client, userId, runtime.agent.name, toolId),
        }),
      ],
    })
    await resourceLoader.reload()
    const modelRuntime = await modelRuntimePromise
    const selectedModel = this.record.model ? parseModelSelection(this.record.model) : undefined
    const model = selectedModel ? modelRuntime.getModel(selectedModel.providerID, selectedModel.modelID) : undefined
    const result = await createAgentSession({
      cwd: this.project.path,
      modelRuntime,
      model,
      sessionManager,
      resourceLoader,
      tools: [...runtime.pi.allowedToolNames],
    })
    this.session = result.session
    this.session.subscribe((event) => this.handle(event))
  }

  private async openOrCreateSession(): Promise<SessionManager> {
    const cwd = this.record.directory ?? this.project.path
    const infos = await SessionManager.list(cwd, nativeSessionsDir())
    const existing = infos.find((info) => info.id === this.record.id)
    return existing ? SessionManager.open(existing.path, nativeSessionsDir(), cwd) : SessionManager.create(cwd, nativeSessionsDir(), { id: this.record.id })
  }

  private handle(event: AgentSessionEvent): void {
    if (event.type === 'session_info_changed') {
      this.record.title = event.name?.trim() || 'Untitled session'
      this.record.updatedAt = Date.now()
      void saveState()
    }
    const message = { ...event, sessionID: this.record.id } as RpcMessage
    const sessionID = this.record.id
    if (event.type === 'agent_start' || event.type === 'turn_start') {
      broadcastSse({ type: 'session.status', properties: { sessionID, status: { type: 'busy' } } })
    }
    if (event.type === 'agent_end' || event.type === 'agent_settled') {
      broadcastSse({ type: 'session.status', properties: { sessionID, status: { type: 'idle' } } })
    }
    if (event.type !== 'agent_settled') {
      for (const listener of this.listeners) listener(message)
      broadcastSse(message)
    }
  }

  onMessage(listener: (message: RpcMessage) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async send(command: RpcCommand): Promise<unknown> {
    await this.ready
    const type = command.type
    let data: unknown
    switch (type) {
      case 'prompt': await this.session.prompt(String(command.message ?? '')); break
      case 'steer': await this.session.steer(String(command.message ?? '')); break
      case 'follow_up': await this.session.followUp(String(command.message ?? '')); break
      case 'abort': await this.session.abort(); break
      case 'clear_queue': data = this.session.clearQueue(); break
      case 'set_model': {
        const model = (await modelRuntimePromise).getModel(String(command.provider ?? ''), String(command.modelId ?? ''))
        if (!model) throw new Error(`Unknown model: ${command.provider}/${command.modelId}`)
        await this.session.setModel(model)
        break
      }
      case 'set_thinking_level': this.session.setThinkingLevel(String(command.level ?? 'medium') as never); break
      case 'get_available_thinking_levels': data = this.session.getAvailableThinkingLevels(); break
      case 'get_entries': data = { entries: this.session.sessionManager.getEntries(), leafId: this.session.sessionManager.getLeafId() }; break
      case 'get_messages': data = { entries: this.session.sessionManager.getEntries(), leafId: this.session.sessionManager.getLeafId() }; break
      case 'get_state': data = { sessionId: this.session.sessionId, model: this.session.model, thinkingLevel: this.session.thinkingLevel, isStreaming: this.session.isStreaming, messages: this.session.messages }; break
      case 'get_session_stats': data = this.session.getSessionStats(); break
      case 'get_last_assistant_text': data = this.session.getLastAssistantText(); break
      case 'set_session_name': this.session.setSessionName(String(command.name ?? '')); break
      case 'get_commands': data = []; break
      case 'set_steering_mode': this.session.setSteeringMode(String(command.mode ?? 'one-at-a-time') as 'all' | 'one-at-a-time'); break
      case 'set_follow_up_mode': this.session.setFollowUpMode(String(command.mode ?? 'one-at-a-time') as 'all' | 'one-at-a-time'); break
      case 'compact': data = await this.session.compact(typeof command.customInstructions === 'string' ? command.customInstructions : undefined); break
      default: throw new Error(`Unsupported SDK command: ${type}`)
    }
    this.record.updatedAt = Date.now()
    await saveState()
    return { type: 'response', id: String(command.id ?? ''), success: true, data }
  }

  get entries() { return this.session.sessionManager.getEntries() }
  get leafId() { return this.session.sessionManager.getLeafId() }
  get agentSession() { return this.session }

  close(): void {
    this.session?.dispose()
  }
}

const active = new Map<string, PiSdkSession>()

function shutdown(): void {
  for (const session of active.values()) session.close()
  active.clear()
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

function recordFor(id: string): SessionRecord {
  syncNativeSessions()
  const record = sessions.find((session) => session.id === id)
  if (!record) throw new Error(`Unknown session: ${id}`)
  return record
}

function rpcSession(id: string): PiSdkSession {
  const existing = active.get(id)
  if (existing) return existing
  const record = recordFor(id)
  const session = new PiSdkSession(record, projectFor(record.project))
  active.set(id, session)
  return session
}

async function sendRpc(id: string, command: RpcCommand): Promise<unknown> {
  if (!allowedRpcCommands.has(command.type)) throw new Error(`Unsupported RPC command: ${command.type}`)
  const session = rpcSession(id)
  const result = await session.send(command) as RpcMessage
  const record = recordFor(id)
  record.updatedAt = Date.now()
  await saveState()
  return result
}

function redactConfig(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactConfig)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (['authorization', 'authorizationtoken', 'apikey', 'api-key', 'token', 'password', 'secret'].some((part) => key.toLowerCase().includes(part))) {
      return [key, '[redacted]']
    }
    return [key, redactConfig(item)]
  }))
}

function openApiProviders(): Record<string, unknown> {
  const files = [join(homedir(), '.pi', 'tools.json'), join(homedir(), '.pi', 'agent', 'tools.json'), join(root, '.pi', 'tools.json')]
  const providers: Record<string, unknown> = {}
  for (const file of files) {
    if (!existsSync(file)) continue
    try {
      const parsed = object(JSON.parse(readFileSync(file, 'utf8')))
      Object.assign(providers, object(parsed.providers ?? parsed.tools ?? parsed))
    } catch {
      continue
    }
  }
  return redactConfig(providers) as Record<string, unknown>
}

async function runtimeProviders(): Promise<{ all: Record<string, unknown>[]; connected: string[]; default: Record<string, string> }> {
  const runtime = await modelRuntimePromise
  const providers = new Map<string, Record<string, unknown>>()
  for (const model of runtime.getModels()) {
    const provider = providers.get(model.provider) ?? {
      id: model.provider,
      source: 'builtin',
      name: model.provider,
      env: [],
      options: {},
      models: {},
    }
    ;(provider.models as Record<string, unknown>)[model.id] = model
    providers.set(model.provider, provider)
  }
  return { all: [...providers.values()], connected: [...providers.keys()], default: {} }
}

type DailyUsage = { date: string; input: number; output: number; cacheRead: number }

async function dailyUsage(): Promise<{ days: DailyUsage[] }> {
  const byDate = new Map<string, DailyUsage>()
  try {
    const allSessions = await SessionManager.listAll(nativeSessionsDir())
    for (const session of allSessions) {
      let entries
      try { entries = parseSessionEntries(readFileSync(session.path, 'utf8')) } catch { continue }
      for (const entry of entries) {
        if (entry.type !== 'message' || entry.message.role !== 'assistant') continue
        const usage = entry.message.usage
        if (!usage) continue
        const date = new Date(entry.timestamp).toISOString().slice(0, 10)
        const total = byDate.get(date) ?? { date, input: 0, output: 0, cacheRead: 0 }
        total.input += typeof usage.input === 'number' ? usage.input : 0
        total.output += typeof usage.output === 'number' ? usage.output : 0
        total.cacheRead += typeof usage.cacheRead === 'number' ? usage.cacheRead : 0
        byDate.set(date, total)
      }
    }
  } catch { /* an unavailable session directory should not break settings */ }
  return { days: [...byDate.values()].sort((a, b) => b.date.localeCompare(a.date)) }
}

function proxyJson(value: unknown, status = 200): Response {
  return json(value, status)
}

async function handleProxy(request: Request): Promise<Response> {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type' } })
  const credentials = loadProxyCredentials()
  const authorization = request.headers.get('authorization') ?? ''
  const secret = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : ''
  const credential = credentials.find((item) => item.hash === hashProxySecret(secret))
  if (!credential) return proxyJson({ error: { message: 'Valid bearer credentials are required', type: 'authentication_error' } }, 401)
  credential.lastUsedAt = Date.now()
  saveProxyCredentials(credentials)

  if (request.method === 'GET' && request.url.endsWith('/v1/models')) {
    const runtime = await modelRuntimePromise
    return proxyJson({ object: 'list', data: runtime.getModels().map((model) => ({ id: `${model.provider}/${model.id}`, object: 'model', owned_by: model.provider })) })
  }
  if (request.method !== 'POST' || !request.url.endsWith('/v1/chat/completions')) return proxyJson({ error: { message: 'Not found', type: 'invalid_request_error' } }, 404)

  try {
    const input = object(await request.json())
    if (!Array.isArray(input.messages)) throw new Error('Request must contain a messages array')
    const runtime = await modelRuntimePromise
    const requested = typeof input.model === 'string' ? input.model.trim() : ''
    const selected = requested.includes('/') ? parseModelSelection(requested) : undefined
    const model = selected
      ? runtime.getModel(selected.providerID, selected.modelID)
      : runtime.getModels().find((candidate) => candidate.id === requested) ?? runtime.getAvailableSnapshot()[0]
    if (!model) return proxyJson({ error: { message: `Unknown or unavailable model: ${requested || '(none selected)'}`, type: 'invalid_request_error' } }, 404)
    // Deliberately exclude system and developer messages. The proxy is a model
    // endpoint, not a way to expose Pi's coding-agent harness prompt.
    const messages = input.messages.filter((message) => {
      const role = object(message).role
      return role !== 'system' && role !== 'developer'
    })
    const result = await runtime.complete(model, { messages } as never)
    const text = result.content?.filter((part) => part.type === 'text').map((part) => part.text).join('') || null
    return proxyJson({
      id: `subpolar-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: `${model.provider}/${model.id}`,
      choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: result.usage?.input ?? 0,
        completion_tokens: result.usage?.output ?? 0,
        total_tokens: result.usage?.totalTokens ?? 0,
      },
    })
  } catch (error) {
    return proxyJson({ error: { message: error instanceof Error ? error.message : String(error), type: 'invalid_request_error' } }, 400)
  }
}

const TRANSCRIPT_FRAME_LIMIT = 192 * 1024
const TRANSCRIPT_MESSAGE_LIMIT = 30

type TranscriptSocket = { data: SocketData; send: (value: string) => unknown; close: (code?: number, reason?: string) => void }

function sendHistoryChunk(socket: TranscriptSocket, mode: 'replace' | 'prepend', before?: string, limit = TRANSCRIPT_MESSAGE_LIMIT): void {
  const all = socket.data.history ?? []
  let end = before ? all.findIndex((message) => message.info.id === before) : all.length
  if (end < 0) end = all.length
  const selected: TranscriptMessage[] = []
  for (let index = end - 1; index >= 0 && selected.length < Math.max(1, limit); index--) {
    const candidate = all[index]
    const proposed = [candidate, ...selected]
    const frame = JSON.stringify({ type: 'history.chunk', mode, messages: proposed })
    if (selected.length > 0 && frame.length > TRANSCRIPT_FRAME_LIMIT) break
    selected.unshift(candidate)
  }
  const first = selected[0]
  const beforeId = first ? (all.findIndex((message) => message.info.id === first.info.id) > 0 ? all[all.findIndex((message) => message.info.id === first.info.id) - 1].info.id : undefined) : undefined
  socket.send(JSON.stringify({ type: 'history.chunk', mode, messages: selected, before: beforeId ?? null, hasMore: Boolean(beforeId), leafId: socket.data.leafId ?? null }))
}

async function loadSocketHistory(socket: TranscriptSocket, session: PiSdkSession, request: { type?: string; before?: string; limit?: number; leafId?: string }): Promise<void> {
  const payload = entriesPayload(await session.send({ type: 'get_entries' }))
  socket.data.history = projectEntries(payload.entries, payload.leafId, socket.data.sessionId, session.record)
  socket.data.leafId = payload.leafId
  socket.data.historyReady = true
  if (request.type === 'history.resume') socket.send(JSON.stringify({ type: 'history.reset' }))
  sendHistoryChunk(socket, request.type === 'history.load' && request.before ? 'prepend' : 'replace', request.before, request.limit)
  socket.send(JSON.stringify({ type: 'history.ready', leafId: payload.leafId }))
  for (const event of socket.data.buffered ?? []) {
    if (event.type !== 'response') socket.send(JSON.stringify({ type: 'transcript.event', event }))
  }
  socket.data.buffered = []
}

async function handleSocketMessage(socket: TranscriptSocket, raw: unknown, session: PiSdkSession): Promise<void> {
  try {
    const request = object(typeof raw === 'string' ? JSON.parse(raw) : raw)
    if (request.type === 'history.load' || request.type === 'history.resume') {
      if (!socket.data.historyReady || request.type === 'history.resume') {
        socket.data.historyReady = false
        await loadSocketHistory(socket, session, request as any)
      } else {
        sendHistoryChunk(socket, request.before ? 'prepend' : 'replace', typeof request.before === 'string' ? request.before : undefined, typeof request.limit === 'number' ? request.limit : undefined)
      }
    }
  } catch (error) {
    socket.send(JSON.stringify({ type: 'history.error', error: error instanceof Error ? error.message : String(error) }))
  }
}

async function handle(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const path = url.pathname.split('/').filter(Boolean)
  if (request.method === 'OPTIONS') return new Response(null, { status: 204 })
  if (request.method === 'GET' && url.pathname === '/api/health') {
    try {
      await applicationDatabase()
      return json({ status: 'healthy', timestamp: new Date().toISOString(), database: 'pocketbase', runtime: 'pi', pi: 'healthy', activeSessions: active.size })
    } catch (error) {
      return json({ status: 'degraded', timestamp: new Date().toISOString(), database: 'pocketbase-unavailable', runtime: 'pi', pi: 'healthy', error: error instanceof Error ? error.message : 'PocketBase is unavailable' }, 503)
    }
  }

  const publicApi = path[0] === 'api' && (path[1] === 'auth' || path[1] === 'auth-info')
  const internalRequest = request.headers.get('authorization') === `Bearer ${internalToken}`
  let authenticatedUser: PocketBaseUser | null = null
  if (path[0] === 'api' && !publicApi && !internalRequest) {
    authenticatedUser = await authenticateRequest(request)
    if (!authenticatedUser) return json({ message: 'Unauthorized' }, 401)
  }

  if (path[0] === 'api' && path[1] === 'auth') {
    if (path[2] === 'session' && request.method === 'GET') {
      authenticatedUser = await authenticateRequest(request)
      return json({ user: authenticatedUser, token: null })
    }
    if (path[2] === 'config' && request.method === 'GET') {
      try { return json(await authConfig()) } catch (error) { return json({ message: error instanceof Error ? error.message : 'PocketBase is unavailable' }, 503) }
    }
    if (path[2] === 'sign-out' && request.method === 'POST') {
      await signOut()
      const response = json({ success: true })
      response.headers.set('set-cookie', clearAuthCookie())
      return response
    }
    if (path[2] === 'sign-in' && path[3] === 'email' && request.method === 'POST') {
      const input = await body(request)
      if (typeof input.email !== 'string' || typeof input.password !== 'string') return json({ message: 'Email and password are required' }, 400)
      try {
        const result = await signIn(input.email, input.password)
        const response = json({ token: result.token, user: result.user })
        response.headers.set('set-cookie', result.cookie)
        return response
      } catch (error) {
        return json({ message: error instanceof Error ? error.message : 'Invalid credentials' }, 401)
      }
    }
    if (path[2] === 'sign-up' && path[3] === 'email' && request.method === 'POST') {
      const input = await body(request)
      if (typeof input.email !== 'string' || typeof input.password !== 'string' || typeof input.name !== 'string') return json({ message: 'Name, email, and password are required' }, 400)
      try {
        const config = await authConfig()
        if (!config.registrationEnabled && !(config.isFirstUser && !config.adminConfigured)) return json({ message: 'Registration is disabled' }, 403)
        const result = await signUp(input.email, input.password, input.name)
        const response = json({ token: result.token, user: result.user }, 201)
        response.headers.set('set-cookie', result.cookie)
        return response
      } catch (error) {
        return json({ message: error instanceof Error ? error.message : 'Registration failed' }, 400)
      }
    }
    if (path[2] === 'change-password' && request.method === 'PUT') {
      if (!authenticatedUser) authenticatedUser = await authenticateRequest(request)
      if (!authenticatedUser) return json({ message: 'Not authenticated' }, 401)
      const input = await body(request)
      if (typeof input.currentPassword !== 'string' || typeof input.newPassword !== 'string') return json({ message: 'Current and new passwords are required' }, 400)
      try {
        await changePassword(authenticatedUser.id, input.currentPassword, input.newPassword)
        return json({ success: true })
      } catch (error) {
        return json({ message: error instanceof Error ? error.message : 'Failed to change password' }, 400)
      }
    }
  }

  if (path[0] === 'api' && path[1] === 'auth-info') {
    if (path[2] === 'config' && request.method === 'GET') {
      try { return json(await authConfig()) } catch (error) { return json({ message: error instanceof Error ? error.message : 'PocketBase is unavailable' }, 503) }
    }
    if (path[2] === 'me' && request.method === 'GET') return json({ user: await authenticateRequest(request) })
  }

  if (path[1] === 'agents' && authenticatedUser) {
    try {
      const client = await applicationDatabase()
      await ensureUserDefaults(client, authenticatedUser.id)
      if (path.length === 2 && request.method === 'GET') return json(await listAgents(client, authenticatedUser.id).then((agents) => agents.map((agent) => ({ ...agent, systemPrompt: agent.system_prompt }))))
      if (path.length === 2 && request.method === 'POST') {
        const input = await body(request)
        const name = typeof input.name === 'string' ? input.name.trim() : ''
        if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) return json({ message: 'A valid agent name is required' }, 400)
        const now = Date.now()
        const record = await client.collection('agents').create({
          user_id: authenticatedUser.id,
          name,
          description: typeof input.description === 'string' ? input.description : '',
          mode: input.mode === 'subagent' ? 'subagent' : 'primary',
          prompt: typeof input.prompt === 'string' ? input.prompt : '',
          systemPrompt: typeof input.systemPrompt === 'string' ? input.systemPrompt : '',
          enabled: input.enabled !== false,
          created_at: now,
          updated_at: now,
        })
        return json({ ...record, systemPrompt: record.systemPrompt }, 201)
      }
      if (path.length === 3 && (request.method === 'PUT' || request.method === 'PATCH')) {
        const id = decodeURIComponent(path[2])
        const existing = await client.collection('agents').getOne(id).catch(() => null)
        if (!existing || existing.user_id !== authenticatedUser.id) return json({ message: 'Agent not found' }, 404)
        const input = await body(request)
        const update = {
          ...(typeof input.name === 'string' ? { name: input.name.trim() } : {}),
          ...(typeof input.description === 'string' ? { description: input.description } : {}),
          ...(input.mode === 'subagent' || input.mode === 'primary' ? { mode: input.mode } : {}),
          ...(typeof input.prompt === 'string' ? { prompt: input.prompt } : {}),
          ...(typeof input.systemPrompt === 'string' ? { systemPrompt: input.systemPrompt } : {}),
          ...(typeof input.enabled === 'boolean' ? { enabled: input.enabled } : {}),
          updated_at: Date.now(),
        }
        const record = await client.collection('agents').update(id, update)
        return json({ ...record, systemPrompt: record.systemPrompt })
      }
      if (path.length === 3 && request.method === 'DELETE') {
        const id = decodeURIComponent(path[2])
        const existing = await client.collection('agents').getOne(id).catch(() => null)
        if (!existing || existing.user_id !== authenticatedUser.id || existing.name === 'master') return json({ message: 'Agent not found' }, 404)
        await client.collection('agents').delete(id)
        return json({ success: true })
      }
    } catch (error) {
      return json({ message: error instanceof Error ? error.message : 'Agent store unavailable' }, 503)
    }
  }

  if (request.method === 'GET' && url.pathname === '/api/usage/daily') return json(await dailyUsage())
  if (url.pathname === '/api/proxy/credentials' && request.method === 'GET') return json({ credentials: loadProxyCredentials().map(proxyCredentialResponse) })
  if (url.pathname === '/api/proxy/credentials' && request.method === 'POST') {
    const secret = `subpolar_${randomBytes(32).toString('base64url')}`
    const credential: ProxyCredential = { id: crypto.randomUUID(), prefix: secret.slice(0, 18), hash: hashProxySecret(secret), createdAt: Date.now() }
    saveProxyCredentials([...loadProxyCredentials(), credential])
    return json({ credential: proxyCredentialResponse(credential), secret }, 201)
  }
  if (path[1] === 'proxy' && path[2] === 'credentials' && path.length === 4 && request.method === 'DELETE') {
    const id = decodeURIComponent(path[3] ?? '')
    saveProxyCredentials(loadProxyCredentials().filter((credential) => credential.id !== id))
    return json({ ok: true })
  }
  if (request.method === 'GET' && url.pathname === '/api/projects') {
    const client = await applicationDatabase()
    return json({ projects: await ownedProjectResponses(authenticatedUser!.id, client) })
  }
  if (request.method === 'GET' && path[1] === 'projects' && path.length === 3) {
    const client = await applicationDatabase()
    const owned = await ownedProjectResponses(authenticatedUser!.id, client)
    const project = owned.find((item) => item.id === Number(path[2]))
    return project ? json({ project }) : json({ error: 'Project not found' }, 404)
  }

  if (request.method === 'POST' && path[1] === 'projects' && path.length === 2) {
    const input = await body(request)
    const name = typeof input.name === 'string' ? input.name.trim() : ''
    if (!name || name.toLocaleLowerCase() === 'general chat') return json({ error: 'A unique project name is required' }, 400)
    const directory = typeof input.directory === 'string' && input.directory.trim()
      ? resolve(input.directory)
      : join(subpolarDataDir, 'projects', name.toLocaleLowerCase().replace(/[^a-z0-9]+/g, '-'))
    const client = await applicationDatabase()
    await ensureUserMetadata(authenticatedUser!.id)
    if (await createProjectSessionRepository(client).findProjectByName(authenticatedUser!.id, name)) return json({ error: 'Project already exists' }, 409)
    mkdirSync(directory, { recursive: true })
    const created = await createProjectSessionRepository(client).createProject(authenticatedUser!.id, { name, path: directory })
    const definitions = loadProjectDefinitions().filter((project) => project.name !== name)
    saveProjectDefinitions([...definitions, { name: created.name, path: created.path }])
    const owned = await ownedProjectResponses(authenticatedUser!.id, client)
    const project = owned.find((item) => item.name === name)
    return json(project ?? { error: 'Unable to create project' }, project ? 201 : 500)
  }
  if (request.method === 'PATCH' && path[1] === 'projects' && path.length === 3) {
    const id = Number(path[2])
    if (id === 0) return json({ error: 'General Chat cannot be renamed' }, 400)
    const client = await applicationDatabase()
    const owned = await createProjectSessionRepository(client).listProjects(authenticatedUser!.id)
    const current = owned[id - 1]
    if (!current) return json({ error: 'Project not found' }, 404)
    const input = await body(request)
    const name = typeof input.name === 'string' && input.name.trim() ? input.name.trim() : current.name
    const directory = typeof input.directory === 'string' && input.directory.trim() ? resolve(input.directory) : current.path
    mkdirSync(directory, { recursive: true })
    const updated = await createProjectSessionRepository(client).updateProject(authenticatedUser!.id, current.id, { name, path: directory })
    if (!updated) return json({ error: 'Project not found' }, 404)
    const definitions = loadProjectDefinitions().filter((project) => project.name !== current.name && resolve(project.path) !== resolve(current.path))
    saveProjectDefinitions([...definitions, { name: updated.name, path: updated.path }])
    return json((await ownedProjectResponses(authenticatedUser!.id, client)).find((project) => project.id === id) ?? { error: 'Project not found' })
  }
  if (request.method === 'DELETE' && path[1] === 'projects' && path.length === 3) {
    const id = Number(path[2])
    if (id === 0) return json({ error: 'General Chat cannot be deleted' }, 400)
    const client = await applicationDatabase()
    const owned = await createProjectSessionRepository(client).listProjects(authenticatedUser!.id)
    const current = owned[id - 1]
    if (!current) return json({ error: 'Project not found' }, 404)
    await createProjectSessionRepository(client).deleteProject(authenticatedUser!.id, current.id)
    saveProjectDefinitions(loadProjectDefinitions().filter((project) => project.name !== current.name && resolve(project.path) !== resolve(current.path)))
    return json({ ok: true })
  }
  if (request.method === 'GET' && path[1] === 'projects' && path[2] === 'default-directory') {
    const name = url.searchParams.get('projectName')?.trim() || 'project'
    const directory = join(subpolarDataDir, 'projects', name.toLocaleLowerCase().replace(/[^a-z0-9]+/g, '-'))
    return json({ directory })
  }
  if (request.method === 'GET' && path[1] === 'projects' && path[2] === 'directories') {
    const requested = url.searchParams.get('path')
    const currentPath = requested ? resolve(requested) : homedir()
    try {
      const directories = readdirSync(currentPath, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
        .map((entry) => ({ name: entry.name, path: join(currentPath, entry.name) }))
      return json({ currentPath, directories })
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 400)
    }
  }
  if (request.method === 'GET' && path[1] === 'projects' && path[2] === 'general-chat') {
    const directory = generalChatProject().path
    return json({ repoId: 0, directory, relativePath: directory, files: {}, agents: [], automationsSkill: { path: '', exists: false, created: false } })
  }
  if (request.method === 'POST' && path[1] === 'projects' && path[2] === 'general-chat') {
    mkdirSync(generalChatProject().path, { recursive: true })
    return json({ ok: true })
  }
  if (request.method === 'POST' && path[1] === 'projects' && path.length === 4 && path[3] === 'access') {
    // Compatibility heartbeat used by the project activity hook.
    return json({ ok: true })
  }
  if (request.method === 'GET' && url.pathname === '/api/agent') {
    try {
      const agents = await listAgents(await applicationDatabase(), authenticatedUser!.id)
      return json(agents.map((agent) => ({ name: agent.name, mode: agent.mode, description: agent.description, systemPrompt: agent.system_prompt })))
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : 'Agent store unavailable' }, 503)
    }
  }
  if (request.method === 'GET' && url.pathname === '/api/provider') {
    try { return json(await runtimeProviders()) } catch { return json({ all: [], connected: [], default: {} }) }
  }
  if (request.method === 'GET' && url.pathname === '/api/config') return json({ model: undefined, default_agent: 'master', default_permission: 'ask' })
  if (request.method === 'GET' && url.pathname === '/api/command') return json([])
  if (request.method === 'GET' && url.pathname === '/api/sessions/status') {
    syncNativeSessions()
    return json(Object.fromEntries(sessions.map((session) => [session.id, { type: 'idle' }])))
  }
  if (request.method === 'GET' && url.pathname === '/api/sse/stream') {
    let heartbeat: ReturnType<typeof setInterval> | undefined
    let client: SseClient | undefined
    let closed = false
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const close = () => {
          if (closed) return
          closed = true
          if (heartbeat) clearInterval(heartbeat)
          if (client) sseClients.delete(client)
          try { controller.close() } catch { /* the consumer may already have cancelled the stream */ }
        }
        client = {
          enqueue: (chunk) => {
            if (closed) return
            try { controller.enqueue(chunk) } catch { close() }
          },
          close,
        }
        sseClients.add(client)
        client.enqueue(encoder.encode(`event: connected\ndata: ${JSON.stringify({ clientId: 'pi-local', connected: active.size, total: active.size })}\n\n`))
        heartbeat = setInterval(() => client?.enqueue(encoder.encode('event: heartbeat\ndata: {}\n\n')), 30000)
      },
      cancel() {
        if (client) client.close()
      },
    })
    return new Response(stream, { headers: { 'cache-control': 'no-cache', 'content-type': 'text/event-stream', 'connection': 'keep-alive' } })
  }
  if (request.method === 'POST' && (url.pathname === '/api/sse/subscribe' || url.pathname === '/api/sse/unsubscribe' || url.pathname === '/api/sse/visibility')) return json({ ok: true })

  if (path[0] !== 'api') return json({ error: 'Not found' }, 404)

  if (path[1] === 'pi' && path[2] === 'tools' && path[3] === 'authorize' && request.method === 'POST') {
    const input = await body(request)
    const userId = internalRequest && typeof input.userId === 'string' ? input.userId : authenticatedUser?.id
    if (!userId) return json({ ok: false, decision: 'deny', message: 'A user identity is required' }, 401)
    try {
      const client = await applicationDatabase()
      const result = await authorizePiToolCall(client, {
        userId,
        agentName: typeof input.agentName === 'string' ? input.agentName : 'master',
        sessionId: typeof input.sessionId === 'string' ? input.sessionId : '',
        toolName: typeof input.toolName === 'string' ? input.toolName : '',
        input: input.input ?? {},
        permissionOverride: input.permissionOverride === 'ask' || input.permissionOverride === 'none' || input.permissionOverride === 'allow_all' ? input.permissionOverride : undefined,
      })
      if (result.decision !== 'approval') return json(result)

      broadcastSse({
        type: 'permission.asked',
        directory: typeof input.cwd === 'string' ? input.cwd : undefined,
        properties: {
          id: result.approvalId,
          sessionID: input.sessionId,
          permission: input.toolName === 'bash' ? 'bash' : input.toolName,
          patterns: [input.toolName],
          metadata: { toolId: mapToolId(input.toolName), input: input.input ?? {}, reason: result.message },
          always: [],
        },
      })
      return json({ ok: false, decision: 'approval', approvalId: result.approvalId, message: result.message }, 202)
    } catch (error) {
      return json({ ok: false, decision: 'deny', message: error instanceof Error ? error.message : 'Tool authorization failed' }, 503)
    }
  }

  if (path[1] === 'subpolar-cli' && path[2] === 'tools' && request.method === 'POST') {
    const input = await body(request)
    const userId = authenticatedUser?.id
      ?? (internalRequest && typeof input.userId === 'string' ? input.userId : undefined)
      ?? (internalRequest && path[3] === 'register' ? 'system' : undefined)
    if (!userId) return json({ error: 'A user identity is required' }, 401)
    try {
      const client = await applicationDatabase()
      if (userId !== 'system') await ensureUserMetadata(userId)
      const agentName = typeof input.agentName === 'string' ? input.agentName : 'master'

      if (path[3] === 'register') {
        if (!internalRequest) return json({ error: 'Tool registration requires the internal token' }, 403)
        if (typeof input.toolId !== 'string' || typeof input.namespace !== 'string' || typeof input.description !== 'string') return json({ error: 'toolId, namespace, and description are required' }, 400)
        const adapter = input.adapter === 'http' || input.adapter === 'openapi' || input.adapter === 'mcp' ? input.adapter : 'internal'
        const risk = input.risk === 'write' || input.risk === 'delete' || input.risk === 'external' ? input.risk : 'read'
        const tool = await upsertRegisteredTool(client, {
          tool_id: input.toolId,
          namespace: input.namespace,
          description: input.description,
          adapter,
          target: typeof input.target === 'string' ? input.target : '',
          operation: typeof input.operation === 'string' ? input.operation : '',
          input_schema: object(input.inputSchema),
          output_schema: object(input.outputSchema),
          risk,
          requires_approval: input.requiresApproval === true,
          enabled: input.enabled !== false,
          metadata: object(input.metadata),
        })
        return json({ tool })
      }

      if (path[3] === 'list') return json({ tools: await listToolsForAgent(client, userId, agentName) })
      if (path[3] === 'search') {
        if (typeof input.query !== 'string' || !input.query.trim()) return json({ error: 'A non-empty query is required' }, 400)
        const tools = await searchToolsForAgent(client, userId, agentName, input.query)
        return json({ tools, columns: ['tool', 'description', 'usage'] })
      }
      if (path[3] === 'describe' && typeof input.toolId === 'string') return json({ tool: await describeToolForAgent(client, userId, agentName, input.toolId) })
      if (path[3] === 'call' && typeof input.toolId === 'string') {
        const sessionId = typeof input.sessionId === 'string' && input.sessionId.trim() ? input.sessionId : undefined
        if (!sessionId || userId === 'system') return json({ error: 'A valid sessionId is required for tool execution' }, 400)
        const localSession = recordFor(sessionId)
        const executionUserId = authenticatedUser?.id ?? localSession.userId
        if (!executionUserId) return json({ error: 'Session has no authenticated owner' }, 403)
        if (typeof input.userId === 'string' && input.userId !== executionUserId) return json({ error: 'Identity assertion does not match the session owner' }, 403)
        const requestedOverride = input.permissionOverride === 'ask' || input.permissionOverride === 'none' || input.permissionOverride === 'allow_all' ? input.permissionOverride : undefined
        const context = await resolveToolSessionContext(client, executionUserId, sessionId, typeof input.agentName === 'string' ? input.agentName : undefined, requestedOverride)
        const gateway = inProcessToolGateway ?? createToolGatewayFromCallTool(client, callTool)
        const result = await gateway.call(
          { toolId: input.toolId, input: input.input ?? {} },
          {
            userId: context.identity.userId,
            agentName: context.agentName,
            sessionId: context.sessionId,
            cwd: context.cwd,
            callId: typeof input.callId === 'string' ? input.callId : crypto.randomUUID(),
            permissionOverride: context.permission.source === 'default' ? undefined : context.permissionOverride,
            waitForApproval: false,
            onApproval: (approval) => {
              broadcastSse({
                type: 'permission.asked',
                directory: context.cwd,
                properties: {
                  id: approval.id,
                  sessionID: approval.session_id,
                  permission: approval.tool_id === 'bash' ? 'bash' : approval.tool_id,
                  patterns: [approval.tool_id],
                  metadata: { toolId: approval.tool_id, input: approval.input, reason: approval.reason },
                  always: [],
                },
              })
            },
          },
        )
        return json(result, result.ok || !('approvalRequired' in result) ? 200 : 202)
      }
      if (path[3] === 'continue' && typeof input.approvalId === 'string') {
        if (userId === 'system') return json({ error: 'An authenticated user is required' }, 401)
        const sessionId = typeof input.sessionId === 'string' ? input.sessionId : undefined
        const session = sessionId ? await createProjectSessionRepository(client).getSession(userId, sessionId) : null
        if (sessionId && !session) return json({ error: 'Session not found' }, 404)
        const result = await continueApprovedTool(client, userId, input.approvalId, { sessionId, cwd: session?.directory, callId: typeof input.callId === 'string' ? input.callId : crypto.randomUUID() })
        return json(result, 'approvalRequired' in result && result.approvalRequired ? 202 : 200)
      }
      return json({ error: 'Unknown tool gateway operation' }, 404)
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : 'Tool gateway unavailable' }, 503)
    }
  }

  if (path[1] === 'permission' && request.method === 'GET') {
    if (!authenticatedUser) return json({ message: 'Unauthorized' }, 401)
    try {
      const approvals = await listPendingApprovals(await applicationDatabase(), authenticatedUser.id)
      return json(approvals.map((approval) => ({ id: approval.id, sessionID: approval.session_id, permission: approval.tool_id === 'bash' ? 'bash' : approval.tool_id, patterns: [approval.tool_id], metadata: { toolId: approval.tool_id, input: approval.input, reason: approval.reason }, always: [] })))
    } catch (error) { return json({ message: error instanceof Error ? error.message : 'Approval store unavailable' }, 503) }
  }

  if (path[1] === 'session' && path[3] === 'permissions' && path[4] && request.method === 'POST') {
    if (!authenticatedUser) return json({ message: 'Unauthorized' }, 401)
    const input = await body(request)
    const approved = input.response !== 'reject'
    const client = await applicationDatabase()
    const approval = await respondToApproval(client, authenticatedUser.id, decodeURIComponent(path[4]), approved)
    if (!approval) return json({ message: 'Approval not found' }, 404)
    if (!approved) return json({ ok: true, approval })
    const session = await createProjectSessionRepository(client).getSession(authenticatedUser.id, decodeURIComponent(path[2] ?? ''))
    if (!session) return json({ ok: true, approval, result: { ok: false, error: { code: 'SESSION_NOT_FOUND', message: 'Session not found' } } }, 404)
    const result = await continueApprovedTool(client, authenticatedUser.id, approval.id, { sessionId: session.id, cwd: session.directory, callId: crypto.randomUUID() })
    return json({ ok: true, approval, result })
  }

  if (path[1] === 'settings' && path[2] === 'agents' && path[3] && path[4] === 'tool-policies' && authenticatedUser) {
    try {
      const client = await applicationDatabase()
      const agent = await client.collection('agents').getOne(decodeURIComponent(path[3])).catch(() => null)
      if (!agent || agent.user_id !== authenticatedUser.id) return json({ message: 'Agent not found' }, 404)
      const filter = `user_id = "${authenticatedUser.id.replaceAll('"', '\\"')}" && agent_id = "${agent.id.replaceAll('"', '\\"')}"`
      if (request.method === 'GET') {
        const policies = await client.collection('agent_tool_policies').getFullList({ filter })
        return json({ policies: policies.map((policy) => ({ ...policy, toolId: policy.tool_id })) })
      }
      if (request.method === 'PUT') {
        const input = await body(request)
        const policies = Array.isArray(input.policies) ? input.policies : []
        const existing = await client.collection('agent_tool_policies').getFullList({ filter })
        for (const policy of existing) await client.collection('agent_tool_policies').delete(policy.id)
        const now = Date.now()
        const saved = []
        for (const value of policies) {
          if (!value || typeof value !== 'object') continue
          const item = value as { toolId?: unknown; effect?: unknown }
          if (typeof item.toolId !== 'string' || !['allow', 'deny', 'approval'].includes(String(item.effect))) continue
          const record = await client.collection('agent_tool_policies').create({ user_id: authenticatedUser.id, agent_id: agent.id, tool_id: item.toolId, effect: item.effect, created_at: now, updated_at: now })
          saved.push({ ...record, toolId: record.tool_id })
        }
        return json({ policies: saved })
      }
    } catch (error) {
      return json({ message: error instanceof Error ? error.message : 'Agent policy store unavailable' }, 503)
    }
  }

  // Settings are intentionally served by the local bridge as well as the full
  // server.  Keeping these routes here prevents a Vite/bridge-only install
  // from turning the settings page into a stream of 404s.
  if (path[1] === 'settings' && path.length === 2 && request.method === 'GET') {
    if (!authenticatedUser) return json({ message: 'Unauthorized' }, 401)
    try {
      const record = await getUserPreferences(await applicationDatabase(), authenticatedUser.id)
      return json({ preferences: { ...DEFAULT_SETTINGS, ...(record?.preferences ?? {}) }, updatedAt: record?.updated_at ?? Date.now() })
    } catch (error) { return json({ message: error instanceof Error ? error.message : 'Settings store unavailable' }, 503) }
  }
  if (path[1] === 'settings' && path.length === 2 && request.method === 'PATCH') {
    if (!authenticatedUser) return json({ message: 'Unauthorized' }, 401)
    const input = await body(request)
    const preferences = object(input.preferences)
    try {
      const client = await applicationDatabase()
      const existing = await getUserPreferences(client, authenticatedUser.id)
      const saved = await saveUserPreferences(client, authenticatedUser.id, { ...DEFAULT_SETTINGS, ...(existing?.preferences ?? {}), ...preferences })
      return json({ preferences: saved.preferences ?? {}, updatedAt: saved.updated_at ?? Date.now() })
    } catch (error) { return json({ message: error instanceof Error ? error.message : 'Settings store unavailable' }, 503) }
  }
  if (path[1] === 'settings' && path.length === 2 && request.method === 'DELETE') {
    if (!authenticatedUser) return json({ message: 'Unauthorized' }, 401)
    try {
      const client = await applicationDatabase()
      const existing = await getUserPreferences(client, authenticatedUser.id)
      if (existing) await client.collection('user_preferences').delete(existing.id)
      return json({ preferences: DEFAULT_SETTINGS, updatedAt: Date.now() })
    } catch (error) { return json({ message: error instanceof Error ? error.message : 'Settings store unavailable' }, 503) }
  }
  if (path[1] === 'settings' && path[2] === 'pi-settings' && request.method === 'GET') {
    // Pi's native config is not required for the bridge to operate. Return a
    // valid empty collection until a config is created by the UI.
    return json({ configs: [], defaultConfig: null })
  }
  if (path[1] === 'settings' && path[2] === 'extensions' && request.method === 'GET') {
    const extensions: Array<{ name: string; path: string; source: 'builtin' | 'global' | 'project' }> = applicationExtensionPaths.filter(existsSync).map((file) => ({ name: file.split('/').pop()?.replace(/\.[^.]+$/, '') ?? file, path: file, source: 'builtin' }))
    const directories = [
      { directory: join(homedir(), '.pi', 'agent', 'extensions'), source: 'global' as const },
      { directory: join(root, '.pi', 'extensions'), source: 'project' as const },
    ]
    for (const source of directories) {
      if (!existsSync(source.directory)) continue
      try {
        for (const entry of readdirSync(source.directory, { withFileTypes: true })) {
          extensions.push({ name: entry.name.replace(/\.[^.]+$/, ''), path: join(source.directory, entry.name), source: source.source })
        }
      } catch { /* ignore unreadable extension directories */ }
    }
    return json({ extensions })
  }
  if (path[1] === 'settings' && path[2] === 'skills' && request.method === 'GET') {
    const directory = url.searchParams.get('directory') ?? undefined
    const repoId = url.searchParams.get('repoId')
    const skills = readSkills(directory).filter((skill) => !repoId || String(skill.repoId ?? '') === repoId)
    return json(skills)
  }
  if (path[1] === 'settings' && path[2] === 'skills' && request.method === 'POST') {
    const input = await body(request)
    if (typeof input.name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.name)) return json({ error: 'Valid skill name is required' }, 400)
    const scope = input.scope === 'project' ? 'project' : 'global'
    const base = scope === 'project' ? join(projectForDirectory(typeof input.directory === 'string' ? input.directory : undefined).path, '.subpolar', 'skills') : join(homedir(), '.config', 'subpolar', 'skills')
    const file = join(base, input.name, 'SKILL.md')
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `# ${input.name}\n\n${typeof input.description === 'string' ? input.description : ''}\n\n${typeof input.body === 'string' ? input.body : ''}\n`, 'utf8')
    return json(readSkills(scope === 'project' ? dirname(dirname(file)) : undefined).find((skill) => skill.name === input.name) ?? { name: input.name, scope, body: input.body ?? '' }, 201)
  }

  if (path[1] === 'sessions' && path.length === 2 && request.method === 'GET') {
    const client = await applicationDatabase()
    const project = url.searchParams.get('project') ?? undefined
    const owned = await createProjectSessionRepository(client).listSessions(authenticatedUser!.id, { project, includeArchived: true })
    const records = owned.map((session) => {
      const local = sessions.find((item) => item.id === session.id)
      const record: SessionRecord = {
        id: session.id,
        project: session.project,
        title: session.title,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        ...(session.archived ? { archived: true } : {}),
        ...(session.profile ? { profile: session.profile } : {}),
        ...(session.model ? { model: session.model } : {}),
        ...(session.directory ? { directory: session.directory } : {}),
        userId: session.userId,
        ...(session.permissionOverride ? { permissionOverride: session.permissionOverride } : {}),
      }
      if (local) Object.assign(local, record)
      return record
    }).filter((session) => !url.searchParams.get('directory') || (session.directory ?? projectForSession(session)?.path) === resolve(url.searchParams.get('directory')!))
    return json({ sessions: records.map(storedSessionResponse).sort((a, b) => b.updatedAt - a.updatedAt) })
  }

  if (path[1] === 'sessions' && path.length === 2 && request.method === 'POST') {
    const input = await body(request)
    const project = typeof input.project === 'number'
      ? projectForId(input.project)
      : typeof input.project === 'string' && /^\d+$/.test(input.project)
        ? projectForId(Number(input.project))
        : typeof input.project === 'string'
          ? projectFor(input.project)
          : projectForDirectory(typeof input.directory === 'string' ? input.directory : undefined)
    const now = Date.now()
    const id = crypto.randomUUID()
    const directory = project.name === 'General Chat' ? sessionWorkspace(id) : project.path
    mkdirSync(directory, { recursive: true })
    const client = await applicationDatabase()
    await ensureUserMetadata(authenticatedUser!.id)
    const stored = await createProjectSessionRepository(client).createSession(authenticatedUser!.id, {
      id,
      project: project.name,
      title: typeof input.title === 'string' && input.title.trim() ? input.title.trim() : 'Untitled session',
      createdAt: now,
      updatedAt: now,
      directory,
      profile: typeof input.agent === 'string' && input.agent.trim() ? input.agent : undefined,
      model: typeof input.model === 'string' && input.model.trim() ? input.model : undefined,
      permissionOverride: input.permission === 'ask' || input.permission === 'none' || input.permission === 'allow_all' ? input.permission : undefined,
    })
    const record: SessionRecord = {
      id: stored.id,
      project: stored.project,
      directory: stored.directory ?? directory,
      title: stored.title,
      createdAt: stored.createdAt,
      updatedAt: stored.updatedAt,
      profile: stored.profile,
      model: stored.model,
      userId: stored.userId,
      permissionOverride: stored.permissionOverride,
    }
    sessions.push(record)
    await saveState()
    rpcSession(record.id)
    return json({ session: storedSessionResponse(record) }, 201)
  }

  if (path[1] === 'sessions' && path.length >= 3) {
    const id = decodeURIComponent(path[2] ?? '')
    try {
      const ownedRecord = recordFor(id)
      if (!internalRequest && ownedRecord.userId !== authenticatedUser?.id) return json({ error: 'Session not found' }, 404)
      if (path.length === 3 && request.method === 'GET') return json(storedSessionResponse(ownedRecord))
      if (path.length === 3 && request.method === 'PATCH') {
        const input = await body(request)
        const title = typeof input.title === 'string' ? input.title.trim() : ''
        const client = await applicationDatabase()
        const record = recordFor(id)
        if (title) {
          await sendRpc(id, { type: 'set_session_name', name: title })
          record.title = title
        }
        if (typeof input.archived === 'boolean') record.archived = input.archived
        const updated = await createProjectSessionRepository(client).updateSession(authenticatedUser!.id, id, {
          ...(title ? { title } : {}),
          ...(typeof input.archived === 'boolean' ? { archived: input.archived } : {}),
        })
        if (updated) {
          record.updatedAt = updated.updatedAt
          record.title = updated.title
        }
        await saveState()
        return json({ session: storedSessionResponse(record) })
      }
      if (path.length === 3 && request.method === 'DELETE') {
        const client = await applicationDatabase()
        await createProjectSessionRepository(client).deleteSession(authenticatedUser!.id, id)
        active.get(id)?.close()
        active.delete(id)
        sessions = sessions.filter((session) => session.id !== id)
        await saveState()
        return json({ ok: true })
      }
      if (path.length === 4 && path[3] === 'messages' && request.method === 'GET') {
        const record = recordFor(id)
        const history = await transcriptHistory(id, record)
        return json({ messages: history.messages })
      }
      if (path.length === 5 && path[3] === 'tool-calls' && request.method === 'GET') {
        const callID = decodeURIComponent(path[4] ?? '')
        const payload = entriesPayload(await sendRpc(id, { type: 'get_entries' }))
        for (const entry of payload.entries) {
          const message = object(object(entry).message)
          if (message.role === 'toolResult' && message.toolCallId === callID) {
            return json({ callID, tool: message.toolName ?? null, input: object(message.input), output: sessionMessageText(message), details: object(message.details), error: message.isError ? sessionMessageText(message) : null })
          }
        }
        return json({ callID, output: '', details: {}, error: null }, 404)
      }
      if (path.length === 4 && path[3] === 'messages' && request.method === 'POST') {
        const input = await body(request)
        const metadata = object(input.metadata)
        const record = recordFor(id)
        const agent = typeof metadata.agent === 'string' && metadata.agent.trim() ? metadata.agent : 'master'
        const model = object(metadata.model)
        record.profile = agent
        if (typeof model.providerID === 'string' && typeof model.modelID === 'string') {
          record.model = `${model.providerID}/${model.modelID}`
        }
        await saveState()
        await createProjectSessionRepository(await applicationDatabase()).updateSession(authenticatedUser!.id, id, {
          profile: record.profile,
          model: record.model,
        }).catch(() => undefined)
        pendingPrompts.set(id, { content: typeof input.content === 'string' ? input.content : '', metadata })
        return json({ ok: true }, 201)
      }
      if (path.length === 4 && path[3] === 'runs' && request.method === 'POST') {
        const prompt = pendingPrompts.get(id)
        pendingPrompts.delete(id)
        if (!prompt?.content.trim()) return json({ error: 'Prompt content is required' }, 400)
        const metadata = prompt.metadata ?? {}
        const model = object(metadata.model)
        if (typeof model.providerID === 'string' && typeof model.modelID === 'string') {
          await sendRpc(id, { type: 'set_model', provider: model.providerID, modelId: model.modelID })
        }
        // The session runtime was selected from PocketBase when the Pi session
        // was created; filesystem `/profile` commands are intentionally gone.
        return json(await sendRpc(id, { type: 'prompt', message: prompt.content }))
      }
      if (path.length === 4 && path[3] === 'state' && request.method === 'GET') return json(rpcData(await sendRpc(id, { type: 'get_state' })))
      if (path.length === 4 && path[3] === 'stats' && request.method === 'GET') return json(rpcData(await sendRpc(id, { type: 'get_session_stats' })))
      if (path.length === 4 && path[3] === 'rpc' && request.method === 'POST') {
        const input = await body(request)
        if (typeof input.type !== 'string') return json({ error: 'RPC type is required' }, 400)
        return json(await sendRpc(id, input as RpcCommand))
      }
      if (path.length === 4 && path[3] === 'prompt' && request.method === 'POST') {
        const input = await body(request)
        if (typeof input.message !== 'string' || !input.message.trim()) return json({ error: 'Prompt message is required' }, 400)
        return json(await sendRpc(id, { type: 'prompt', message: input.message, ...(typeof input.streamingBehavior === 'string' ? { streamingBehavior: input.streamingBehavior } : {}) }))
      }
      if (path.length === 4 && path[3] === 'abort' && request.method === 'POST') return json(await sendRpc(id, { type: 'abort' }))
      return json({ error: 'Not found' }, 404)
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 400)
    }
  }

  if (path[1] === 'extensions' && path[2] === 'projects') {
    if (request.method === 'GET') return json({ projects: projectResponses() })
    if (request.method === 'POST') {
      const input = await body(request)
      if (typeof input.sessionId !== 'string' || typeof input.project !== 'string') return json({ error: 'sessionId and project are required' }, 400)
      projectFor(input.project)
      return json(await sendRpc(input.sessionId, { type: 'prompt', message: `/project ${input.project}` }))
    }
  }

  if (path[1] === 'extensions' && (path[2] === 'profiles' || path[2] === 'agent-profiles') && request.method === 'GET') {
    try {
      const agents = await listAgents(await applicationDatabase(), authenticatedUser!.id)
      return json({ profiles: Object.fromEntries(agents.map((agent) => [agent.name, { systemPrompt: agent.system_prompt, tools: [] }])) })
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : 'Agent store unavailable' }, 503)
    }
  }

  if (path[1] === 'extensions' && (path[2] === 'profiles' || path[2] === 'agent-profiles') && path[3] === 'activate' && request.method === 'POST') {
    const input = await body(request)
    if (typeof input.sessionId !== 'string' || typeof input.profile !== 'string') return json({ error: 'sessionId and profile are required' }, 400)
    return json(await sendRpc(input.sessionId, { type: 'prompt', message: `/profile ${input.profile}` }))
  }

  if (path[1] === 'extensions' && (path[2] === 'tools' || path[2] === 'list-tools') && request.method === 'GET') {
    if (!authenticatedUser) return json({ message: 'Unauthorized' }, 401)
    try {
      const tools = await listToolsForAgent(await applicationDatabase(), authenticatedUser.id, 'master')
      const sessionId = url.searchParams.get('sessionId')
      return json({ tools, ...(sessionId ? { commands: await sendRpc(sessionId, { type: 'get_commands' }) } : {}) })
    } catch (error) { return json({ message: error instanceof Error ? error.message : 'Tool registry unavailable' }, 503) }
  }

  if (path[1] === 'extensions' && path[2] === 'commands' && request.method === 'GET') {
    const sessionId = url.searchParams.get('sessionId')
    if (!sessionId) return json({ commands: [] })
    return json(await sendRpc(sessionId, { type: 'get_commands' }))
  }

  if (path[1] === 'extensions' && path[2] === 'command' && path[3] && request.method === 'POST') {
    const input = await body(request)
    if (typeof input.sessionId !== 'string') return json({ error: 'sessionId is required' }, 400)
    const args = typeof input.args === 'string' && input.args.trim() ? ` ${input.args.trim()}` : ''
    return json(await sendRpc(input.sessionId, { type: 'prompt', message: `/${decodeURIComponent(path[3])}${args}` }))
  }

  if (path[1] === 'extensions' && (path[2] === 'session-search' || path[2] === 'session-history-search') && request.method === 'GET') {
    const query = (url.searchParams.get('q') ?? '').toLocaleLowerCase().trim()
    if (!query) return json({ sessions: [] })
    const matches = []
    for (const record of sessions) {
      try {
        const response = await sendRpc(record.id, { type: 'get_messages' }) as RpcMessage
        const payload = entriesPayload(response)
        const text = projectEntries(payload.entries, payload.leafId, record.id).map((item) => sessionMessageText(item.info)).join('\n')
        if (`${record.title}\n${text}`.toLocaleLowerCase().includes(query)) matches.push(record)
      } catch {
        continue
      }
    }
    return json({ sessions: matches })
  }

  if (path[1] === 'extensions' && path[2] === 'usage' && request.method === 'GET') {
    const values = []
    for (const record of sessions) {
      try {
        const response = await sendRpc(record.id, { type: 'get_session_stats' }) as RpcMessage
        values.push({ session: record, stats: response.data ?? null })
      } catch {
        values.push({ session: record, stats: null })
      }
    }
    return json({ sessions: values })
  }

  if (path[1] === 'extensions' && path[2] === 'session-title') {
    if (request.method === 'GET') {
      const sessionId = url.searchParams.get('sessionId')
      return json({ title: sessionId ? recordFor(sessionId).title : null })
    }
    if (request.method === 'POST') {
      const input = await body(request)
      if (typeof input.sessionId !== 'string' || typeof input.title !== 'string' || !input.title.trim()) return json({ error: 'sessionId and title are required' }, 400)
      const response = await sendRpc(input.sessionId, { type: 'set_session_name', name: input.title.trim() })
      const record = recordFor(input.sessionId)
      record.title = input.title.trim()
      await saveState()
      return json({ response, session: record })
    }
  }

  if (path[1] === 'extensions' && path[2] === 'openapi-tools' && request.method === 'GET') return json({ providers: openApiProviders() })
  return json({ error: 'Not found' }, 404)
}

const app = new Hono()
app.all('*', async (context) => {
  const request = context.req.raw
  const origin = request.headers.get('origin')
  if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return context.json({ error: 'Origin not allowed' }, 403)
  const response = new URL(request.url).pathname.startsWith('/proxy/')
    ? await handleProxy(request)
    : await handle(request)
  response.headers.set('access-control-allow-methods', 'GET,POST,PATCH,DELETE,OPTIONS')
  response.headers.set('access-control-allow-headers', 'content-type, authorization')
  if (request.url.includes('/proxy/')) response.headers.set('access-control-allow-origin', '*')
  else if (origin) response.headers.set('access-control-allow-origin', origin)
  return response
})

const _server = Bun.serve<SocketData>({
  port,
  hostname: '127.0.0.1',
  // Agent turns and transcript WebSockets can legitimately remain quiet for
  // longer than Bun's 10-second default while a model or tool is working.
  idleTimeout: 120,
  async fetch(request, server) {
    const url = new URL(request.url)
    const match = url.pathname.match(/^\/api\/sessions\/([^/]+)\/events$/)
    if (match) {
      const user = await authenticateRequest(request)
      if (!user) return json({ message: 'Unauthorized' }, 401)
      const sessionId = decodeURIComponent(match[1] ?? '')
      const record = recordFor(sessionId)
      if (record.userId !== user.id) return json({ error: 'Session not found' }, 404)
      if (server.upgrade(request, { data: { sessionId } })) return undefined
      return json({ error: 'WebSocket upgrade failed' }, 400)
    }
    return app.fetch(request)
  },
  websocket: {
    open(socket) {
      try {
        const session = rpcSession(socket.data.sessionId)
        socket.data.buffered = []
        // Subscribe before reading entries. Events generated during the read are replayed
        // after the authoritative snapshot, so a reconnect cannot lose a turn.
        socket.data.unsubscribe = session.onMessage((message) => {
          if (!socket.data.historyReady) {
            if ((socket.data.buffered ?? []).length < 200) socket.data.buffered!.push(message)
            return
          }
          if (message.type !== 'response') socket.send(JSON.stringify({ type: 'transcript.event', event: message }))
        })
      } catch {
        socket.close(1011, 'Unknown session')
      }
    },
    close(socket) {
      socket.data.unsubscribe?.()
    },
    message(socket, raw) {
      void handleSocketMessage(socket, raw, rpcSession(socket.data.sessionId))
    },
  },
})

void _server
