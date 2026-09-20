import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync, statSync } from 'node:fs'

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
import { entriesPayload, projectEntries, redactTranscriptPayload, type TranscriptMessage } from './transcript/projector'

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
  ProjectPathConflictError,
  ensureProjectSessionCollections,
  createSessionContextResolver,
  SessionContextError,
  createToolGatewayFromCallTool,
  loadAgentRuntime,
  type PermissionOverride,
  type ToolGateway,
  createProviderAccountService,
  ensureProviderAccountCollections,
  type ProviderAccount,
  createProviderCatalogAsync,
  createProviderRuntime,
  composeProviderRuntimeId,
  parseProviderRuntimeId,
  providerRuntimeMapping,
  type ProviderRuntime,
  ProviderLoginFlowController,
  ProviderLoginFlowError,
  PocketBaseProviderLoginFlowStorage,
  ensureProviderLoginFlowCollection,
  providerLoginFlowStorageError,
  createCustomProviderService,
  ensureCustomProviderCollection,
  customProviderDiscoveryUrl,
  CustomProviderValidationError,
  assertGatewayAccess,
  authenticateGatewayCredential,
  createGatewayCredential,
  listGatewayCredentials,
  publicGatewayCredential,
  revokeGatewayCredential,
  rotateGatewayCredential,
  GatewayAuthError,
  type GatewayCredentialAuth,
  type GatewayPermission,
  ensureTaskCollections,
  TaskRepository,
  TaskControlError,
  type TaskState,
  configureSubagentToolRunner,
  SubagentController,
  PocketBaseWorktreeStore,
  WorktreeController,
  BrowserSessionService,
  BrowserRuntimeError,
  AutomationRepository,
  createAutomationWorker,
  expireAutomationLeases,
  markInterruptedRuns,
  type AutomationExecutor,
  type AutomationRecord,
  type AutomationRun,
  InboxRepository,
  NotificationRepository,
  createPushNotificationAdapter,
  type NotificationAdapter,
} from './server/index.ts'
import { effectiveAgentConfiguration } from './server/tools.ts'
import {
  NewSessionRouteError,
  resolveNewSessionRoute,
} from './server/new-session-route.ts'
import {
  assertSafeBrowserMutation,
  isAllowedOrigin,
  InProcessRateLimiter,
  readJsonBody,
  requestId,
  REQUEST_LIMITS,
  RequestSecurityError,
  rateLimitKey,
} from './server/request-security.ts'
import { fetchWithNetworkPolicy, networkPolicyFromMetadata, readBoundedResponse } from './server/network-policy.ts'
import { redactSensitive, redactSensitiveText } from './server/security-redaction.ts'
import { handleVoiceRoute, localVoiceBackends, type VoiceBackends, redactVoiceSettings, VoiceAuthorizationError } from './server/voice/index.ts'
import { permissionAskedProperties } from './server/approval-event.ts'
import { escapeFilter } from './server/pocketbase.ts'
import { createEventCursor, ensureEventCursorSchema } from './server/event-cursor.ts'
import { assertPathWithinWorkspace, canonicalProjectPath, configuredWorkspaceRoot, isPathWithin } from './server/project-filesystem.ts'
import { GitPathPolicy } from './server/git/policy.ts'
import { GitReadService } from './server/git/service.ts'
import { GitServiceError } from './server/git/contracts.ts'
import {
  createCapabilitiesPayload,
  createHealthPayload,
  createLegacyHealthPayload,
  type DiagnosticComponents,
  errorEnvelope,
} from './server/contracts.ts'
import {
  MessageDeliveryConflictError,
  messageDeliveryFromRow,
  messageDeliveryResponse,
  replayMessageDeliveryResponse,
  reconcileRunningDeliveries,
  reserveMessageDelivery,
  withDeliveryMetadata,
  type MessageDelivery,
} from './server/message-delivery.ts'
import {
  QueueEntryConflictError,
  QueueEntryTransitionError,
  claimQueueEntry,
  clearQueue,
  listQueueEntries,
  reorderQueueEntry,
  reserveQueueEntry,
  updateQueueEntry,
} from './server/message-queue.ts'

type Project = { id?: string | number; name: string; path: string; agentNames?: readonly string[]; hasAgentOverride?: boolean }
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

type SocketData = { sessionId: string; userId: string; record: SessionRecord; project: Project; unsubscribe?: () => void; history?: TranscriptMessage[]; leafId?: string | null; historyReady?: boolean; buffered?: RpcMessage[] }
type SseClient = { userId: string; enqueue: (chunk: Uint8Array) => void; close: () => void }
type ProxyCredential = { id: string; prefix: string; hash: string; createdAt: number; lastUsedAt?: number }
const root = resolve(import.meta.dir, '..')
const webuiDir = import.meta.dir
const subpolarDataDir = join(homedir(), '.subpolar')
const projectsRoot = configuredWorkspaceRoot()
const databasePath = join(subpolarDataDir, 'subpolar.sqlite')
const legacyStatePath = join(webuiDir, '.sessions.json')

const legacyProjectStatePath = join(subpolarDataDir, 'projects.json')
const generalChatRoot = join(projectsRoot, 'general-chat')
const legacyProxyCredentialsPath = join(subpolarDataDir, 'proxy-credentials.json')
const port = Number(process.env.WEBUI_PORT ?? 4173)
const internalToken = process.env.SUBPOLAR_INTERNAL_TOKEN || randomBytes(32).toString('hex')
process.env.SUBPOLAR_INTERNAL_TOKEN = internalToken
let applicationDatabasePromise: ReturnType<typeof getPocketBaseAdmin> | undefined
let applicationCollectionsReady: Promise<void> | undefined
let inProcessToolGateway: ToolGateway | undefined
let subagentController: SubagentController | undefined
let subagentWorktrees: WorktreeController | undefined
let automationWorker: ReturnType<typeof createAutomationWorker> | undefined
let automationScheduler: ReturnType<typeof setInterval> | undefined
let automationMaintenanceInitialized = false
let providerAccountServicePromise: Promise<ReturnType<typeof createProviderAccountService>> | undefined
let providerLoginFlowControllerPromise: Promise<ProviderLoginFlowController> | undefined
const migratedUsers = new Set<string>()
const requestRateLimiter = new InProcessRateLimiter()
const voiceBackends: VoiceBackends = localVoiceBackends({
  sttExecutable: process.env.SUBPOLAR_VOICE_STT_EXECUTABLE,
  ttsExecutable: process.env.SUBPOLAR_VOICE_TTS_EXECUTABLE,
  sttModels: process.env.SUBPOLAR_VOICE_STT_MODELS?.split(',').map((value) => value.trim()).filter(Boolean),
  ttsModels: process.env.SUBPOLAR_VOICE_TTS_MODELS?.split(',').map((value) => value.trim()).filter(Boolean),
  ttsVoices: process.env.SUBPOLAR_VOICE_TTS_VOICES?.split(',').map((value) => value.trim()).filter(Boolean),
})

async function voiceAuthorization(request: Request, user: PocketBaseUser | null, credential: GatewayCredentialAuth | null, internal: boolean) {
  const url = new URL(request.url)
  const sessionId = url.searchParams.get('sessionId') ?? request.headers.get('x-session-id')
  if (!sessionId?.trim()) throw new VoiceAuthorizationError()
  const client = await applicationDatabase()
  const session = await createProjectSessionRepository(client).getSessionById(sessionId)
  if (!session || !session.userId || (!internal && !credential && (!user || user.id !== session.userId)) || (credential && credential.ownerId !== session.userId)) throw new VoiceAuthorizationError()
  const agents = await listAgents(client, session.userId)
  const agent = agents.find((item) => item.id === session.profile || item.name === session.profile) ?? agents.find((item) => item.name === 'master')
  if (!agent || agent.enabled === false) throw new VoiceAuthorizationError()
  if (credential) assertGatewayAccess(credential, 'call', { projectId: session.projectId, agentName: agent.name, sessionId: session.id })
  return { userId: session.userId, sessionId: session.id, ...(session.projectId ? { projectId: session.projectId } : {}), agentName: agent.name, authorize: () => undefined }
}

async function applicationDatabase() {
  if (!applicationDatabasePromise) {
    applicationDatabasePromise = getPocketBaseAdmin().catch((error) => {
      applicationDatabasePromise = undefined
      throw error
    })
  }
  const client = await applicationDatabasePromise
  if (!applicationCollectionsReady) {
    applicationCollectionsReady = ensureApplicationCollections(client)
      .then(() => ensureProjectSessionCollections(client))
      .then(() => ensureToolRegistry(client))
        .then(() => ensureProviderAccountCollections(client))
        .then(() => ensureCustomProviderCollection(client))
        .then(() => ensureProviderLoginFlowCollection(client))
        .then(() => ensureTaskCollections(client))
      .catch((error) => {
        applicationCollectionsReady = undefined
        throw error
      })
  }
  await applicationCollectionsReady
  if (!inProcessToolGateway) inProcessToolGateway = createToolGatewayFromCallTool(client, callTool)
  if (!subagentController) {
    const tasks = new TaskRepository(client)
    subagentWorktrees = new WorktreeController(new PocketBaseWorktreeStore(client))
    subagentController = new SubagentController(tasks, inProcessToolGateway, executeSubagentHost, 2, async (ownerId, parentAgent, targetAgent, projectId) => {
      const agents = await listAgents(client, ownerId)
      const parent = agents.find((agent) => agent.name === parentAgent || agent.id === parentAgent)
      const target = agents.find((agent) => agent.name === targetAgent || agent.id === targetAgent)
      if (!parent?.enabled || !target?.enabled || target.mode !== 'subagent') return false
      const project = projectId ? await createProjectSessionRepository(client).getProject(ownerId, projectId) : null
      if (projectId && !project) return false
      if (project?.agentNames?.length && !project.agentNames.includes(target.name) && !project.agentNames.includes(target.id)) return false
      const configured = effectiveAgentConfiguration(target, projectId)
      return configured.policies.subagent === true
    }, async (ownerId, approvalId, sessionId) => {
      const approval = await client.collection('tool_approvals').getOne(approvalId).catch(() => null)
      return Boolean(approval && approval.user_id === ownerId && approval.session_id === sessionId && approval.tool_id === 'subagent/run' && approval.status === 'approved')
    })
    configureSubagentToolRunner(async (rawInput, context) => {
      const input = object(rawInput)
      const targetAgent = typeof input.targetAgent === 'string' ? input.targetAgent.trim() : ''
      const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : ''
      if (!targetAgent || !prompt || !context.sessionId) throw new Error('targetAgent, prompt, and an owned session are required')
      const session = await createProjectSessionRepository(client).getSessionById(context.sessionId)
      if (!session || session.userId !== context.userId) throw new Error('Session is not owned by the caller')
       const agents = await listAgents(client, context.userId)
       const parent = agents.find((agent) => agent.name === context.agentName || agent.id === context.agentName)
       const projectId = session.projectId ? String(session.projectId) : undefined
       const configuredParent = parent ? effectiveAgentConfiguration(parent, projectId) : undefined
       const declaredParentCapabilities = configuredParent
         ? ['subagent/run', 'read', 'write', 'bash'].filter((capability) => capability === 'subagent/run' ? configuredParent.policies.subagent === true : configuredParent.policies.builtin[capability] === true)
         : ['read']
       const parentCapabilities = (context.capabilities?.length ? context.capabilities : declaredParentCapabilities) as never[]
       const target = agents.find((agent) => agent.name === targetAgent || agent.id === targetAgent)
       const configuredTarget = target ? effectiveAgentConfiguration(target, projectId) : undefined
      const targetCapabilities = new Set(['subagent/run', 'read', 'write', 'bash'].filter((capability) => capability === 'subagent/run' ? configuredTarget?.policies.subagent === true : configuredTarget?.policies.builtin[capability] === true))
      const requestedCapabilities = Array.isArray(input.capabilities) ? input.capabilities.filter((value): value is never => typeof value === 'string') : parentCapabilities
      if (requestedCapabilities.some((capability) => !targetCapabilities.has(String(capability)))) throw new Error('Requested capabilities exceed the target agent ceiling')
      return subagentController!.run({
        ownerId: context.userId,
        sessionId: context.sessionId,
        parentAgent: context.agentName,
        targetAgent,
        prompt,
        capabilities: requestedCapabilities,
        projectId,
        coding: input.coding !== false,
        approvalId: typeof input.approvalId === 'string' ? input.approvalId : undefined,
        cwd: context.cwd,
      }, parentCapabilities)
    })
  }
  return client
}

async function providerAccountService() {
  if (!providerAccountServicePromise) {
    providerAccountServicePromise = applicationDatabase().then((client) => createProviderAccountService({ client })).catch((error) => {
      providerAccountServicePromise = undefined
      throw error
    })
  }
  return providerAccountServicePromise
}

function providerAccountStatus(account: ProviderAccount) {
  const expired = account.credentialExpiresAt !== undefined && account.credentialExpiresAt <= Date.now()
  const state = account.status !== 'active'
    ? 'unconfigured'
    : expired
      ? 'expired'
      : account.hasCredential
        ? 'authenticated'
        : 'unconfigured'
  return {
    state,
    configured: state === 'authenticated',
    method: account.authType,
    source: 'pocketbase',
    label: account.displayName,
  }
}

function providerAccountInstance(account: ProviderAccount) {
  const runtimeProviderId = composeProviderRuntimeId(account.providerType, account.instanceId)
  return {
    id: runtimeProviderId,
    instanceId: runtimeProviderId,
    providerId: account.providerType,
    label: account.displayName,
    source: 'pocketbase' as const,
    authMethod: account.authType,
    status: providerAccountStatus(account),
  }
}

function providerCatalogAccount(account: ProviderAccount): Record<string, unknown> {
  const status = providerAccountStatus(account)
  return {
    id: account.instanceId,
    provider_id: account.providerType,
    display_name: account.displayName,
    auth_type: account.authType,
    status: status.state,
    ...(account.credentialExpiresAt === undefined ? {} : { credential_expires_at: account.credentialExpiresAt }),
  }
}

async function ownedProviderAccount(userId: string, wireInstanceId: string): Promise<{ account: ProviderAccount } | null> {
  const parsed = parseProviderRuntimeId(decodeURIComponent(wireInstanceId))
  if (!parsed) return null
  const account = await (await providerAccountService()).getAccount(userId, parsed.instanceId)
  if (!account || account.providerType !== parsed.providerType) return null
  return { account }
}

interface UserProviderRuntimeOptions {
  refreshOnCreate?: boolean
  allowModelNetwork?: boolean
}

async function userProviderRuntime(
  userId: string,
  accounts?: readonly ProviderAccount[],
  options: UserProviderRuntimeOptions = {},
): Promise<ProviderRuntime> {
  const accountService = await providerAccountService()
  const selectedAccounts = accounts ?? await accountService.listAccounts(userId)
  return createProviderRuntime({
    userId,
    accountService,
    accounts: selectedAccounts,
    baseRuntime: await modelRuntimePromise,
    refreshOnCreate: options.refreshOnCreate ?? false,
    allowModelNetwork: options.allowModelNetwork ?? false,
  })
}

async function providerLoginFlowController(): Promise<ProviderLoginFlowController> {
  if (!providerLoginFlowControllerPromise) {
    providerLoginFlowControllerPromise = (async () => {
      const client = await applicationDatabase()
      const accountService = await providerAccountService()
      const baseRuntime = await modelRuntimePromise
      return new ProviderLoginFlowController({
        storage: new PocketBaseProviderLoginFlowStorage(client),
        resolveProviderInstance: async (providerInstanceId, ownerId) => {
          const parsed = parseProviderRuntimeId(providerInstanceId)
          if (parsed) {
            const account = await accountService.getAccount(ownerId, parsed.instanceId).catch(() => null)
            return account && account.providerType === parsed.providerType ? providerRuntimeMapping(account) : undefined
          }
          return baseRuntime.getProvider(providerInstanceId) ? { runtimeProviderId: providerInstanceId } : undefined
        },
        runtimeFactory: async (context) => {
          const parsed = parseProviderRuntimeId(context.providerInstanceId)
          if (!parsed) return baseRuntime
          const account = await accountService.getAccount(context.ownerId, parsed.instanceId)
          if (!account || account.providerType !== parsed.providerType) throw new Error('Provider account not found')
          return userProviderRuntime(context.ownerId, [account])
        },
        credentialSink: async (context, credential) => {
          const parsed = parseProviderRuntimeId(context.providerInstanceId)
          if (parsed) {
            const account = await accountService.getAccount(context.ownerId, parsed.instanceId)
            if (!account || account.providerType !== parsed.providerType) throw new Error('Provider account not found')
            await accountService.updateAccount(context.ownerId, account.instanceId, { authType: credential.type, credential })
            return
          }
          await accountService.createAccount(context.ownerId, {
            providerType: context.runtimeProviderId,
            displayName: context.displayName ?? context.runtimeProviderId,
            authType: credential.type,
            credential,
          })
        },
      })
    })().catch((error) => {
      providerLoginFlowControllerPromise = undefined
      throw error
    })
  }
  return providerLoginFlowControllerPromise
}

void providerAccountService().then(async () => {
  await syncAdminFromEnv()
  console.log('PocketBase application collections ready')
}).catch((error) => {
  console.warn(`PocketBase is not ready: ${redactedDiagnostic(error)}`)
})

mkdirSync(subpolarDataDir, { recursive: true })
mkdirSync(projectsRoot, { recursive: true })
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
  CREATE TABLE IF NOT EXISTS message_deliveries (
    owner_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    content TEXT NOT NULL,
    metadata TEXT NOT NULL,
    state TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    response TEXT,
    PRIMARY KEY (owner_id, session_id, message_id)
  );
  CREATE INDEX IF NOT EXISTS idx_message_deliveries_pending
    ON message_deliveries (owner_id, session_id, state, updated_at);
  CREATE TABLE IF NOT EXISTS message_queue (
    owner_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    client_id TEXT NOT NULL,
    content TEXT NOT NULL,
    kind TEXT NOT NULL,
    state TEXT NOT NULL,
    position INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    error TEXT,
    PRIMARY KEY (owner_id, session_id, client_id)
  );
  CREATE INDEX IF NOT EXISTS idx_message_queue_ready
    ON message_queue (owner_id, session_id, state, position, created_at);
`)
ensureEventCursorSchema(database)
try { database.exec('ALTER TABLE sessions ADD COLUMN user_id TEXT') } catch { /* already migrated */ }
try { database.exec('ALTER TABLE sessions ADD COLUMN permission_override TEXT') } catch { /* already migrated */ }
try { database.exec('ALTER TABLE message_deliveries ADD COLUMN response TEXT') } catch { /* already migrated */ }
reconcileRunningDeliveries(database)
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
  if (rows.length > 0 || !existsSync(legacyProjectStatePath)) return rows.flatMap((row) => {
    try { return [{ name: row.name, path: assertPathWithinWorkspace(row.path, projectsRoot) }] }
    catch { return [] }
  })
  try {
    const value = JSON.parse(readFileSync(legacyProjectStatePath, 'utf8')) as unknown
    if (!Array.isArray(value)) return []
    const definitions = value.flatMap((item) => {
      const entry = object(item)
      if (typeof entry.name !== 'string' || typeof entry.path !== 'string') return []
      try { return [{ name: entry.name, path: assertPathWithinWorkspace(entry.path, projectsRoot) }] }
      catch { return [] }
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
    for (const project of items) {
      try { insert.run(project.name, assertPathWithinWorkspace(project.path, projectsRoot)) }
      catch { /* Do not persist legacy paths outside the workspace. */ }
    }
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
const sseClients = new Set<SseClient>()
const encoder = new TextEncoder()
const eventCursor = createEventCursor(database)

function getMessageDelivery(ownerId: string, sessionId: string, messageId: string): MessageDelivery | null {
  const row = database.query(
    'SELECT owner_id, session_id, message_id, content, metadata, state, created_at, updated_at, response FROM message_deliveries WHERE owner_id = ? AND session_id = ? AND message_id = ?',
  ).get(ownerId, sessionId, messageId) as Record<string, unknown> | null
  return row ? messageDeliveryFromRow(row) : null
}

function getLatestMessageDelivery(ownerId: string, sessionId: string): MessageDelivery | null {
  const row = database.query(
    'SELECT owner_id, session_id, message_id, content, metadata, state, created_at, updated_at, response FROM message_deliveries WHERE owner_id = ? AND session_id = ? AND state = ? ORDER BY updated_at DESC LIMIT 1',
  ).get(ownerId, sessionId, 'pending') as Record<string, unknown> | null
  return row ? messageDeliveryFromRow(row) : null
}

function messageDeliveryId(input: unknown): string | undefined {
  if (input === undefined) return undefined
  if (typeof input !== 'string' || input.trim() === '' || input.length > 256) throw new Error('Invalid messageID')
  return input.trim()
}

function claimMessageDelivery(delivery: MessageDelivery): MessageDelivery | null {
  // A running delivery is intentionally not retried after a bridge restart: its
  // execution outcome is ambiguous, so retrying it could execute the prompt twice.
  const result = database.query(
    'UPDATE message_deliveries SET state = ?, updated_at = ? WHERE owner_id = ? AND session_id = ? AND message_id = ? AND state = ?',
  ).run('running', Date.now(), delivery.ownerId, delivery.sessionId, delivery.messageId, 'pending') as { changes?: number }
  if (result.changes !== 1) return null
  return getMessageDelivery(delivery.ownerId, delivery.sessionId, delivery.messageId)
}

function completeMessageDelivery(delivery: MessageDelivery, response: unknown): void {
  let serializedResponse: string | null = null
  try { serializedResponse = JSON.stringify(response) ?? null } catch { /* Replay falls back to delivery metadata. */ }
  database.query(
    'UPDATE message_deliveries SET state = ?, response = ?, updated_at = ? WHERE owner_id = ? AND session_id = ? AND message_id = ? AND state = ?',
  ).run('completed', serializedResponse, Date.now(), delivery.ownerId, delivery.sessionId, delivery.messageId, 'running')
}

function interruptMessageDelivery(delivery: MessageDelivery): void {
  database.query(
    'UPDATE message_deliveries SET state = ?, updated_at = ? WHERE owner_id = ? AND session_id = ? AND message_id = ? AND state = ?',
  ).run('interrupted', Date.now(), delivery.ownerId, delivery.sessionId, delivery.messageId, 'running')
}

function queueClientId(input: unknown): string {
  if (typeof input !== 'string' || input.trim() === '' || input.length > 256) throw new Error('Invalid clientId')
  return input.trim()
}

function broadcastSse(value: unknown, userId?: string): void {
  if (!userId) return
  const safeValue = redactSensitive(value)
  const properties = object(safeValue).properties
  const sessionId = typeof object(properties).sessionID === 'string' ? object(properties).sessionID as string : null
  const event = eventCursor.append(userId, sessionId, safeValue)
  const chunk = encoder.encode(`id: ${event.id}\ndata: ${JSON.stringify(event.payload)}\n\n`)
  for (const client of sseClients) {
    if (client.userId !== userId) continue
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

async function resolveToolSessionContext(
  client: Awaited<ReturnType<typeof applicationDatabase>>,
  userId: string,
  sessionId: string,
  requestedAgent?: string,
  requestedPermission?: PermissionOverride,
) {
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
          ...(requestedAgent === undefined && session.profile ? { profile: session.profile } : {}),
          ...(session.model ? { model: session.model } : {}),
          ...(session.directory ? { directory: session.directory } : {}),
          userId: session.userId,
          ...(session.permissionOverride ? { permissionOverride: session.permissionOverride } : {}),
        }
      },
      getProject: async (name) => {
        if (name === 'General Chat') return { name, path: generalChatRoot }
        return await repository.findProjectByName(userId, name)
      },
    },
    agents: {
      getAgent: async (owner, selector) => {
        const record = await client.collection('agents').getFirstListItem(`user_id = "${filterValue(owner)}" && (id = "${filterValue(selector)}" || name = "${filterValue(selector)}")`).catch(() => null)
        return record as { id: string; user_id: string; name: string; enabled?: boolean } | null
      },
    },
    defaultAgentName: requestedAgent ?? 'master',
  })
  // Resolve the session and project first. A request agent is only a validated
  // selection within that durable context, never the source of its authority.
  const context = await resolver.resolve({
    identity: userId,
    userId,
    sessionId,
    ...(requestedAgent === undefined ? {} : { agent: requestedAgent }),
    ...(requestedPermission === undefined ? {} : { permission: requestedPermission }),
  })
  const project = context.project as Project
  if (project.hasAgentOverride === true && !project.agentNames?.includes(context.agent.name)) {
    throw new SessionContextError('SESSION_AGENT_MISMATCH', 'Agent is not available for this project')
  }
  return context
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function requestedPermissionOverride(value: unknown): PermissionOverride | null | undefined {
  if (value === undefined) return undefined
  return value === 'ask' || value === 'none' || value === 'allow_all' ? value : null
}

function requestedMetadataPermission(metadata: Record<string, unknown>): PermissionOverride | null | undefined {
  const values = [metadata.permission, metadata.permissionOverride].filter((value) => value !== undefined)
  if (values.length === 0) return undefined
  const permissions = values.map(requestedPermissionOverride)
  if (permissions.some((permission) => permission === null)) return null
  const first = permissions[0]
  return permissions.every((permission) => permission === first) ? first : null
}

function sessionContextFailure(error: unknown): Response | undefined {
  if (!(error instanceof SessionContextError)) return undefined
  const denied = error.code === 'PERMISSION_MISMATCH'
    || error.code === 'SESSION_AGENT_MISMATCH'
    || error.code === 'AGENT_NOT_OWNED'
    || error.code === 'AGENT_DISABLED'
  return json({ error: error.message, code: error.code }, denied ? 403 : 400)
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
      if (typeof path !== 'string') return []
      try { return [{ name, path: assertPathWithinWorkspace(resolve(base, path), projectsRoot) }] }
      catch { return [] }
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

function safeProjectPath(value: string): string {
  return assertPathWithinWorkspace(value, projectsRoot)
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
  for (const native of nativeSessionRecords()) {
    const matches = sessions.filter((session) => session.id === native.id)
    if (matches.length > 1) continue
    const stored = matches.length === 1 ? matches[0] : undefined
    if (!stored) {
      sessions.push(native)
      continue
    }
    if (stored.title === 'Untitled session' && native.title !== 'Untitled session') stored.title = native.title
    stored.createdAt = Math.min(stored.createdAt, native.createdAt)
    stored.updatedAt = Math.max(stored.updatedAt, native.updatedAt)
  }
}

type DurableSession = {
  id: string
  project: string
  title: string
  createdAt: number
  updatedAt: number
  archived?: boolean
  profile?: string
  model?: string
  directory?: string
  userId: string
  permissionOverride?: PermissionOverride
}

function localSessionRecord(stored: DurableSession): SessionRecord {
  return {
    id: stored.id,
    project: stored.project,
    title: stored.title,
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
    archived: stored.archived,
    profile: stored.profile,
    model: stored.model,
    directory: stored.directory,
    userId: stored.userId,
    permissionOverride: stored.permissionOverride,
  }
}

function projectFor(name: string | undefined): Project {
  if (!name || name === '0' || name.toLocaleLowerCase() === 'general chat') return generalChatProject()
  const value = projects().find((project) => project.name === name)
  if (!value) throw new Error(`Unknown project: ${name}`)
  return value
}

type SkillRecord = { name: string; description: string; body: string; scope: 'global' | 'project'; path: string; repoId?: number }

function skillDirectories(directory?: string): Array<{ scope: 'global' | 'project'; directory: string; repoId?: number }> {
  const result: Array<{ scope: 'global' | 'project'; directory: string; repoId?: number }> = []
  const projectDirectory = directory ? assertPathWithinWorkspace(directory, projectsRoot) : undefined
  if (projectDirectory) {
    result.push({ scope: 'project', directory: assertPathWithinWorkspace(join(projectDirectory, '.subpolar', 'skills'), projectsRoot) })
  }
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
        const candidate = entry.isDirectory() ? join(source.directory, entry.name, 'SKILL.md') : entry.name === 'SKILL.md' ? join(source.directory, entry.name) : ''
        if (!candidate || !existsSync(candidate)) continue
        let file = candidate
        if (source.scope === 'project') {
          try { file = assertPathWithinWorkspace(candidate, projectsRoot) } catch { continue }
        }
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
    ...(project.agentNames?.length ? { agentNames: project.agentNames, hasAgentOverride: true } : {}),
  }
}

async function ownedProjectResponses(userId: string, client: Awaited<ReturnType<typeof applicationDatabase>>) {
  await ensureUserMetadata(userId)
  const owned = await createProjectSessionRepository(client).listProjects(userId)
  return [
    projectResponse(generalChatProject(), 0, true),
    ...owned.map((project, index) => projectResponse({ name: project.name, path: project.path, agentNames: project.agentNames, hasAgentOverride: project.hasAgentOverride }, index + 1)),
  ]
}

function storedSessionResponse(record: SessionRecord, ownedProjects: readonly Project[] = projects()) {
  const project = record.project === 'General Chat'
    ? generalChatProject()
    : ownedProjects.find((item) => item.name === record.project) ?? { name: record.project, path: record.directory ?? '' }
  const projectId = project.name === 'General Chat' ? 0 : Math.max(1, ownedProjects.findIndex((item) => item.name === project.name) + 1)
  return { ...record, archived: record.archived ?? false, projectId, directory: record.directory ?? project.path }
}

const SESSION_PAGE_DEFAULT_LIMIT = 25
const SESSION_PAGE_MAX_LIMIT = 100
const SESSION_SEARCH_MAX_LENGTH = 200
const SESSION_CURSOR_MAX_LENGTH = 2048
type SessionCursor = { updatedAt: number; id: string; order: 'asc' | 'desc'; limit: number; search: string; project?: string; directory?: string }

function encodeSessionCursor(cursor: SessionCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}

function decodeSessionCursor(value: string): SessionCursor | null {
  try {
    if (value.length > SESSION_CURSOR_MAX_LENGTH) return null
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<SessionCursor>
    if ((parsed.order !== 'asc' && parsed.order !== 'desc') || typeof parsed.updatedAt !== 'number' || typeof parsed.id !== 'string' || typeof parsed.limit !== 'number' || typeof parsed.search !== 'string') return null
    return parsed as SessionCursor
  } catch {
    return null
  }
}

function sessionPageLimit(value: string | null): number {
  const parsed = value === null || value.trim() === '' ? SESSION_PAGE_DEFAULT_LIMIT : Number(value)
  if (!Number.isFinite(parsed)) return SESSION_PAGE_DEFAULT_LIMIT
  return Math.min(SESSION_PAGE_MAX_LIMIT, Math.max(1, Math.floor(parsed)))
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

type ModelSelection = { providerID: string; modelID: string; value: string }

class ModelUnavailableError extends Error {
  readonly code = 'MODEL_UNAVAILABLE'

  constructor(selection: Pick<ModelSelection, 'providerID' | 'modelID'>) {
    super(`Unknown or unavailable model: ${selection.providerID ? `${selection.providerID}/${selection.modelID}` : selection.modelID}`)
    this.name = 'ModelUnavailableError'
  }
}

function modelSelection(value: unknown): ModelSelection | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const parsed = typeof value === 'string'
    ? parseModelSelection(value.trim())
    : (() => {
        const selected = object(value)
        const providerID = typeof selected.providerID === 'string' ? selected.providerID.trim() : ''
        const modelID = typeof selected.modelID === 'string' ? selected.modelID.trim() : ''
        return providerID && modelID ? { providerID, modelID } : undefined
      })()
  if (!parsed) throw new ModelUnavailableError({ providerID: '', modelID: String(value) })
  return { ...parsed, value: `${parsed.providerID}/${parsed.modelID}` }
}

async function validateModelSelection(userId: string, selection: ModelSelection | undefined): Promise<void> {
  if (!selection) return
  const runtime = await userProviderRuntime(userId)
  if (!runtime.getModel(selection.providerID, selection.modelID)) throw new ModelUnavailableError(selection)
}

async function persistSessionModel(
  client: Awaited<ReturnType<typeof applicationDatabase>>,
  ownerId: string,
  sessionId: string,
  record: SessionRecord,
  selection: ModelSelection,
): Promise<void> {
  const updated = await createProjectSessionRepository(client).updateSession(ownerId, sessionId, { model: selection.value })
  if (!updated) throw new Error('Session was not found')
  record.model = updated.model
  const local = sessions.find((session) => session.id === sessionId && session.userId === ownerId)
  if (local && local !== record) local.model = updated.model
  await saveState()
}

async function transcriptHistory(sessionId: string, selection: SessionRecord) {
  if (!selection.userId) throw new Error('Session owner is unavailable')
  const payload = entriesPayload(await sendRpc(sessionId, { type: 'get_entries' }, selection))
  return { ...payload, messages: projectEntries(payload.entries, payload.leafId, sessionId, selection) }
}

function json(value: unknown, status = 200, correlationId?: string): Response {
  const response = new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
  if (correlationId) response.headers.set('x-request-id', correlationId)
  return response
}

class TaskRequestError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) {
    super(message)
    this.name = 'TaskRequestError'
  }
}

function gatewayErrorResponse(error: unknown): Response | null {
  if (!(error instanceof GatewayAuthError)) return null
  return json({ error: { code: error.code, message: error.message } }, error.code === 'GATEWAY_PERMISSION_DENIED' || error.code === 'GATEWAY_SCOPE_DENIED' ? 403 : 401)
}

async function body(request: Request): Promise<Record<string, unknown>> {
  return readJsonBody(request)
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

async function executeSubagentHost(input: { task: import('./server/task-control-plane.ts').TaskRecord; signal: AbortSignal; capabilities: readonly string[]; cwd?: string }): Promise<unknown> {
  const taskInput = object(input.task.input)
  const cwd = input.cwd ?? configuredWorkspaceRoot()
  let worktree: Awaited<ReturnType<WorktreeController['create']>> | undefined
  if (taskInput.coding !== false && input.task.project_id && subagentWorktrees) {
    worktree = await subagentWorktrees.create({ ownerId: input.task.owner_id, projectId: input.task.project_id, repository: cwd, baseRef: 'HEAD', taskId: input.task.id })
    await (await applicationDatabase()).collection('tasks').update(input.task.id, { worktree_id: worktree.id, base_ref: worktree.baseRef, updated_at: Date.now() })
  }
  const record: SessionRecord = { id: `subagent-${input.task.id}`, project: 'Subagent', title: input.task.title, createdAt: Date.now(), updatedAt: Date.now(), userId: input.task.owner_id, profile: input.task.subagent_id, directory: worktree?.path ?? cwd }
  const project: Project = { name: 'Subagent', path: worktree?.path ?? cwd }
  const session = new PiSdkSession(record, project, input.capabilities)
  const abort = () => { void session.send({ type: 'abort' }) }
  input.signal.addEventListener('abort', abort, { once: true })
  try {
    await session.send({ type: 'prompt', message: typeof taskInput.prompt === 'string' ? taskInput.prompt : input.task.title })
    return { text: session.agentSession.getLastAssistantText(), sessionId: record.id, worktreeId: worktree?.id }
  } finally {
    input.signal.removeEventListener('abort', abort)
    session.close()
    if (worktree && subagentWorktrees) await subagentWorktrees.remove(worktree)
  }
}

const executeAutomationHost: AutomationExecutor = async (run: AutomationRun, automation: AutomationRecord, signal: AbortSignal): Promise<unknown> => {
  const client = await applicationDatabase()
  const repository = createProjectSessionRepository(client)
  const sessionId = `automation-${run.id}`
  const stored = await repository.getSession(automation.owner_id, sessionId) ?? await repository.createSession(automation.owner_id, {
    id: sessionId,
    projectId: automation.project_id ?? null,
    title: automation.name,
    profile: automation.agent_id,
  })
  const record = localSessionRecord(stored)
  const project = automation.project_id
    ? await repository.getProject(automation.owner_id, automation.project_id)
    : null
  const configuredProject: Project = project ? { name: project.name, path: project.path } : generalChatProject()
  if (automation.project_id && !project) throw new Error('Automation project is unavailable')
  const session = rpcSession(sessionId, automation.owner_id, record, configuredProject, automation.agent_id)
  const key = activeKey(automation.owner_id, sessionId)
  const abort = () => { void session.send({ type: 'abort' }).catch(() => undefined) }
  signal.addEventListener('abort', abort, { once: true })
  try {
    if (signal.aborted) throw new Error('Automation cancelled')
    await session.send({ type: 'prompt', message: automation.prompt })
    return { text: session.agentSession.getLastAssistantText(), sessionId }
  } finally {
    signal.removeEventListener('abort', abort)
    session.close()
    if (active.get(key) === session) active.delete(key)
  }
}

const runtimeNotificationAdapter: NotificationAdapter = async (subscription, item) => {
  if (subscription.channel !== 'push') throw Object.assign(new Error('Email notification delivery is not configured'), { code: 'EMAIL_DELIVERY_UNAVAILABLE' })
  return createPushNotificationAdapter()(subscription, item)
}

function automationWorkerFor(client: Awaited<ReturnType<typeof applicationDatabase>>): ReturnType<typeof createAutomationWorker> {
  if (!automationWorker) automationWorker = createAutomationWorker(new AutomationRepository(client, { serializationScope: 'process', notificationAdapter: runtimeNotificationAdapter }), executeAutomationHost)
  return automationWorker
}

function routeError(correlationId: string, code: string, message: string, status: number): Response {
  return json({ error: message, code, requestId: correlationId }, status, correlationId)
}

function routeLimit(value: string | null, fallback = 50): number {
  const parsed = value === null ? fallback : Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, 100) : fallback
}

const TRIGGER_KEY_ERROR = 'Invalid trigger_key'
const SECRET_LIKE_TRIGGER_KEY = /(?:^|[-_.:])(secret|token|password|apikey|api[-_]?key)(?:$|[-_.:=])/i

function validateTriggerKey(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value) || SECRET_LIKE_TRIGGER_KEY.test(value)) {
    throw new Error(TRIGGER_KEY_ERROR)
  }
  return value
}

async function ownedProjectIdForRoute(client: Awaited<ReturnType<typeof applicationDatabase>>, ownerId: string, value: unknown): Promise<string | undefined | null> {
  if (value === undefined || value === null || value === '' || value === '0') return undefined
  if (typeof value !== 'string') return null
  const repository = createProjectSessionRepository(client)
  const direct = await repository.getProject(ownerId, value)
  if (direct) return direct.id
  if (/^\d+$/.test(value)) {
    const projects = await repository.listProjects(ownerId)
    return projects[Number(value) - 1]?.id ?? null
  }
  return null
}

function notificationPreferenceValue(value: unknown): Record<string, unknown> {
  const candidate = object(value)
  const events = object(candidate.events)
  return {
    enabled: candidate.enabled === true,
    events: {
      permissionAsked: events.permissionAsked !== false,
      questionAsked: events.questionAsked !== false,
      sessionError: events.sessionError !== false,
      sessionIdle: events.sessionIdle === true,
    },
  }
}

async function runAutomationSchedulerTick(): Promise<void> {
  const client = await applicationDatabase()
  if (!automationMaintenanceInitialized) {
    await markInterruptedRuns(client, { serializationScope: 'process' })
    automationMaintenanceInitialized = true
  }
  await expireAutomationLeases(client, Date.now(), { serializationScope: 'process' })
  await automationWorkerFor(client).executeDue()
  await new NotificationRepository(client).sweepDue(runtimeNotificationAdapter)
}

function startAutomationScheduler(): void {
  if (automationScheduler) return
  automationScheduler = setInterval(() => {
    void runAutomationSchedulerTick().catch((error) => console.warn(`Automation scheduler failed: ${redactedDiagnostic(error)}`))
  }, 10000)
}

class PiSdkSession {
  private readonly listeners = new Set<(message: RpcMessage) => void>()
  private readonly ready: Promise<void>
  private runtimeAgentName: string
  private runtimePermissionOverride: PermissionOverride
  private session!: AgentSession
  private modelRuntime!: ProviderRuntime

  constructor(readonly record: SessionRecord, readonly project: Project, private readonly capabilities?: readonly string[]) {
    this.runtimeAgentName = record.profile ?? 'master'
    this.runtimePermissionOverride = record.permissionOverride ?? 'ask'
    this.ready = this.initialize()
  }

  private async initialize(): Promise<void> {
    const client = await applicationDatabase()
    const userId = this.record.userId
    if (!userId) throw new Error('Session has no authenticated owner')
    await ensureUserMetadata(userId)
    await ensureUserDefaults(client, userId)
    const context = await resolveToolSessionContext(client, userId, this.record.id)
    this.runtimeAgentName = context.agentName
    this.runtimePermissionOverride = context.permissionOverride
    this.record.profile = context.agentName
    if (context.session?.permissionOverride !== undefined) this.record.permissionOverride = context.session.permissionOverride
    const runtime = await loadAgentRuntime(client, userId, context.agentName, context.session?.project)
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
           permissionOverride: this.runtimePermissionOverride,
           capabilities: this.capabilities,
          onApproval: (approval) => {
            broadcastSse({
              type: 'permission.asked',
              directory: sessionCwd,
              properties: permissionAskedProperties({ id: approval.id, sessionId: approval.session_id, toolId: approval.tool_id, input: approval.input, reason: approval.reason }),
            }, userId)
          },
           listTools: () => listToolsForAgent(client, userId, runtime.agent.name, context.session?.project),
           searchTools: (query) => searchToolsForAgent(client, userId, runtime.agent.name, query),
           describeTool: (toolId) => describeToolForAgent(client, userId, runtime.agent.name, toolId),
        }),
      ],
    })
    await resourceLoader.reload()
    this.modelRuntime = await userProviderRuntime(userId)
    const selectedModel = this.record.model ? parseModelSelection(this.record.model) : undefined
    const model = selectedModel ? this.modelRuntime.getModel(selectedModel.providerID, selectedModel.modelID) : undefined
    if (selectedModel && !model) throw new Error('Selected provider account or model is unavailable')
    const result = await createAgentSession({
      cwd: this.project.path,
      modelRuntime: this.modelRuntime,
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
    const message = redactSensitive({ ...event, sessionID: this.record.id }) as RpcMessage
    const sessionID = this.record.id
    if (event.type === 'agent_start' || event.type === 'turn_start') {
      broadcastSse({ type: 'session.status', properties: { sessionID, status: { type: 'busy' } } }, this.record.userId)
    }
    if (event.type === 'agent_end' || event.type === 'agent_settled') {
      broadcastSse({ type: 'session.status', properties: { sessionID, status: { type: 'idle' } } }, this.record.userId)
    }
    if (event.type === 'agent_settled') void deliverNextQueuedFollowUp(this)
    if (event.type !== 'agent_settled') {
      for (const listener of this.listeners) listener(message)
      broadcastSse(message, this.record.userId)
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
        const model = this.modelRuntime.getModel(String(command.provider ?? ''), String(command.modelId ?? ''))
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
  get agentName() { return this.runtimeAgentName }
  get permissionOverride() { return this.runtimePermissionOverride }

  close(): void {
    this.session?.dispose()
  }
}

async function deliverNextQueuedFollowUp(session: PiSdkSession): Promise<void> {
  const ownerId = session.record.userId
  if (!ownerId) return
  const entry = listQueueEntries(database, ownerId, session.record.id).find((item) => item.kind === 'follow_up' && item.state === 'enqueued')
  if (!entry) return
  const claimed = claimQueueEntry(database, ownerId, session.record.id, entry.clientId)
  if (!claimed) return
  try {
    await session.send({ type: 'follow_up', message: entry.content, id: entry.clientId })
    updateQueueEntry(database, ownerId, session.record.id, entry.clientId, 'delivered')
  } catch (error) {
    updateQueueEntry(database, ownerId, session.record.id, entry.clientId, 'failed', error instanceof Error ? error.message : 'Follow-up delivery failed')
  }
  broadcastSse({ type: 'message.queue.updated', properties: { sessionID: session.record.id } }, ownerId)
}

const active = new Map<string, PiSdkSession>()

function activeKey(userId: string, id: string): string {
  return `${userId}:${id}`
}

function shutdown(): void {
  for (const session of active.values()) session.close()
  active.clear()
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

function recordFor(id: string, userId: string): SessionRecord {
  syncNativeSessions()
  const record = sessions.find((session) => session.id === id && session.userId === userId)
  if (!record) throw new Error(`Unknown session: ${id}`)
  return record
}

async function ownedSessionRecord(client: Awaited<ReturnType<typeof applicationDatabase>>, userId: string, id: string): Promise<SessionRecord | null> {
  const stored = await createProjectSessionRepository(client).getSession(userId, id)
  if (!stored) return null
  const local = sessions.find((session) => session.id === id && session.userId === userId)
  const record = localSessionRecord(stored)
  if (local) {
    Object.assign(local, record)
    return local
  }
  return record
}

async function ownedSessionProject(client: Awaited<ReturnType<typeof applicationDatabase>>, userId: string, record: SessionRecord): Promise<Project | null> {
  if (record.project === 'General Chat') return generalChatProject()
  const project = await createProjectSessionRepository(client).findProjectByName(userId, record.project)
  if (!project) return null
  let projectPath: string
  try {
    projectPath = assertPathWithinWorkspace(project.path)
  } catch {
    return null
  }
  if (record.directory && !isPathWithin(projectPath, record.directory)) return null
  return { name: project.name, path: projectPath }
}

function rpcSession(
  id: string,
  userId: string,
  suppliedRecord?: SessionRecord,
  suppliedProject?: Project,
  requiredAgent?: string,
  requiredPermission?: PermissionOverride,
): PiSdkSession {
  if (!userId.trim()) throw new Error('Session owner is unavailable')
  const key = activeKey(userId, id)
  const existing = active.get(key)
  if (existing) {
    if (existing.record.userId !== userId || (suppliedProject && !isPathWithin(suppliedProject.path, existing.record.directory ?? existing.project.path))) {
      throw new Error('Session project mismatch')
    }
    const agentMatches = requiredAgent === undefined || existing.agentName === requiredAgent
    const permissionMatches = requiredPermission === undefined || existing.permissionOverride === requiredPermission
    if (agentMatches && permissionMatches) return existing
    existing.close()
    active.delete(key)
  }
  const record = suppliedRecord ?? recordFor(id, userId)
  if (record.userId !== userId) throw new Error('Session owner mismatch')
  const configuredProject = suppliedProject ?? (suppliedRecord ? undefined : projectFor(record.project))
  if (!configuredProject) throw new Error('Session project is unavailable')
  if (record.directory && !isPathWithin(configuredProject.path, record.directory)) throw new Error('Session directory is outside its project')
  const project = configuredProject
  const session = new PiSdkSession(record, project)
  active.set(key, session)
  return session
}

async function sendRpc(id: string, command: RpcCommand, owner: SessionRecord): Promise<unknown> {
  if (!allowedRpcCommands.has(command.type)) throw new Error(`Unsupported RPC command: ${command.type}`)
  const userId = owner.userId
  if (!userId) throw new Error('Session owner is unavailable')
  const client = await applicationDatabase()
  const context = await resolveToolSessionContext(client, userId, id)
  owner.profile = context.agentName
  owner.permissionOverride = context.session?.permissionOverride
  const project = await ownedSessionProject(client, userId, owner)
  if (!project) throw new Error('Session project is unavailable')
  const session = rpcSession(id, userId, owner, project, context.agentName, context.permissionOverride)
  const result = await session.send(command) as RpcMessage
  const record = session.record
  record.updatedAt = Date.now()
  await saveState()
  return command.type === 'get_entries' || command.type === 'get_messages' || command.type === 'get_state'
    ? redactTranscriptPayload(result)
    : redactSensitive(result)
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

async function runtimeProviders(userId: string): Promise<{ all: Record<string, unknown>[]; connected: string[]; default: Record<string, string> }> {
  const runtime = await userProviderRuntime(userId)
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

async function dailyUsage(userId: string, client: Awaited<ReturnType<typeof applicationDatabase>>): Promise<{ days: DailyUsage[] }> {
  const byDate = new Map<string, DailyUsage>()
  try {
    const ownedIds = new Set((await createProjectSessionRepository(client).listSessions(userId, { includeArchived: true })).map((session) => session.id))
    const allSessions = await SessionManager.listAll(nativeSessionsDir())
    for (const session of allSessions) {
      if (!ownedIds.has(session.id)) continue
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

function redactedDiagnostic(error: unknown): string {
  return redactSensitiveText(error instanceof Error ? error.message : String(error))
}

function healthDiagnosticTimeoutMs(): number {
  const configured = Number(process.env.SUBPOLAR_HEALTH_DIAGNOSTIC_TIMEOUT_MS)
  return Number.isInteger(configured) && configured > 0 ? Math.min(configured, 5_000) : 1_500
}

function boundedHealthDiagnostic<T>(operation: Promise<T>, fallback: T): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => resolve(fallback), healthDiagnosticTimeoutMs())
    operation.then((value) => { clearTimeout(timer); resolve(value) }, (error) => { clearTimeout(timer); reject(error) })
  })
}

async function diagnosticsComponents(): Promise<DiagnosticComponents> {
  const pocketbase = await boundedHealthDiagnostic<DiagnosticComponents['pocketbase']>(
    applicationDatabase()
      .then(() => ({ state: 'available' as const }))
      .catch(() => ({ state: 'unavailable' as const, reason: 'pocketbase_unavailable' })),
    { state: 'unknown' as const, reason: 'pocketbase_check_timeout' },
  )

  let runtime: Awaited<typeof modelRuntimePromise> | undefined
  const runtimeComponent = await boundedHealthDiagnostic<DiagnosticComponents['runtime']>(
    modelRuntimePromise
      .then((value) => {
        runtime = value
        return { state: 'available' as const, details: { modelCount: value.getModels().length } }
      })
      .catch(() => ({ state: 'unknown' as const, reason: 'runtime_not_observed' })),
    { state: 'unknown' as const, reason: 'runtime_check_timeout' },
  )

  let providers: DiagnosticComponents['providers'] = { state: 'unknown', reason: 'runtime_not_observed' }
  if (runtime) {
    providers = await boundedHealthDiagnostic<DiagnosticComponents['providers']>(
      createProviderCatalogAsync(runtime)
        .then((catalog) => {
          const configured = catalog.providers.filter((provider) => provider.authStatus.configured)
          const hasProviderError = catalog.providers.some((provider) => provider.authStatus.state === 'error')
          return {
            state: hasProviderError ? 'degraded' as const : configured.length > 0 ? 'available' as const : 'unconfigured' as const,
            details: {
              configured: configured.length,
              total: catalog.providers.length,
              providers: catalog.providers.map((provider) => ({ id: provider.id, state: provider.authStatus.state })),
            },
          }
        })
        .catch(() => ({ state: 'unknown' as const, reason: 'provider_status_not_observed' })),
      { state: 'unknown' as const, reason: 'provider_check_timeout' },
    )
  }

  const filesystem = existsSync(projectsRoot)
    ? { state: 'available' as const }
    : { state: 'unavailable' as const, reason: 'project_root_unavailable' }
  const clientOnly = { state: 'unknown' as const, reason: 'client_capability_not_observed' }

  return {
    bridge: { state: 'available', details: { transport: 'bun' } },
    runtime: runtimeComponent,
    pocketbase,
    projectFilesystem: filesystem,
    providers,
    browser: clientOnly,
    stt: clientOnly,
    tts: clientOnly,
  }
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
    const input = await body(request)
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
    console.warn(`Proxy request failed: ${redactedDiagnostic(error)}`)
    return proxyJson({ error: { message: 'Proxy request failed', type: 'invalid_request_error' } }, 400)
  }
}

const TRANSCRIPT_FRAME_LIMIT = 192 * 1024
const TRANSCRIPT_MESSAGE_LIMIT = 30
const TRANSCRIPT_INPUT_LIMIT = 64 * 1024

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
  const size = typeof raw === 'string'
    ? new TextEncoder().encode(raw).byteLength
    : raw instanceof ArrayBuffer ? raw.byteLength : raw instanceof Uint8Array ? raw.byteLength : 0
  if (size > TRANSCRIPT_INPUT_LIMIT) {
    socket.close(1009, 'Message too large')
    return
  }
  const limited = requestRateLimiter.consume(`websocket-message:${socket.data.userId}:${socket.data.sessionId}`, REQUEST_LIMITS.read.limit, REQUEST_LIMITS.read.windowMs)
  if (!limited.allowed) {
    socket.close(1008, 'Message rate limit exceeded')
    return
  }
  try {
    const request = object(typeof raw === 'string' ? JSON.parse(raw) : raw instanceof ArrayBuffer || raw instanceof Uint8Array ? JSON.parse(new TextDecoder().decode(raw)) : raw)
    if (request.type === 'history.load' || request.type === 'history.resume') {
      if (!socket.data.historyReady || request.type === 'history.resume') {
        socket.data.historyReady = false
        await loadSocketHistory(socket, session, request as any)
      } else {
        sendHistoryChunk(socket, request.before ? 'prepend' : 'replace', typeof request.before === 'string' ? request.before : undefined, typeof request.limit === 'number' ? request.limit : undefined)
      }
    }
  } catch (error) {
    socket.send(JSON.stringify({ type: 'history.error', error: 'Unable to process session history request' }))
  }
}

async function handle(request: Request, correlationId = requestId(request)): Promise<Response> {
  const url = new URL(request.url)
  const path = url.pathname.split('/').filter(Boolean)
  if (request.method === 'OPTIONS') return new Response(null, { status: 204 })
  if (request.method === 'GET' && url.pathname === '/api/health') {
    try {
      await applicationDatabase()
        return json(createLegacyHealthPayload(true, new Date().toISOString()))
    } catch (error) {
      console.warn(`Health check degraded: ${redactedDiagnostic(error)}`)
        return json(createLegacyHealthPayload(false, new Date().toISOString()), 503)
    }
  }

  if (request.method === 'GET' && url.pathname === '/api/v1/capabilities') {
    return json(createCapabilitiesPayload(correlationId))
  }
  if (request.method === 'GET' && url.pathname === '/api/v1/health') {
    return json(createHealthPayload(await diagnosticsComponents(), new Date().toISOString(), correlationId))
  }

  const publicApi = path[0] === 'api' && (
    path[1] === 'auth'
    || path[1] === 'auth-info'
    || (path[1] === 'v1' && (path[2] === 'capabilities' || path[2] === 'health'))
  )
  const internalRequest = request.headers.get('authorization') === `Bearer ${internalToken}`
  let gatewayCredential: GatewayCredentialAuth | null = null
  const authorization = request.headers.get('authorization') ?? ''
  if (authorization.startsWith('Bearer subpolar_gw_')) {
    try {
      gatewayCredential = await authenticateGatewayCredential(await applicationDatabase(), authorization.slice('Bearer '.length))
    } catch (error) {
      if (error instanceof GatewayAuthError) {
        const status = error.code === 'GATEWAY_TOKEN_REQUIRED' || error.code === 'GATEWAY_TOKEN_INVALID' ? 401 : 403
        return json({ error: { code: error.code, message: error.message } }, status)
      }
      return json({ error: { code: 'GATEWAY_AUTH_UNAVAILABLE', message: 'Gateway authentication unavailable' } }, 503)
    }
  }
  let authenticatedUser: PocketBaseUser | null = null
  if (path[0] === 'api' && !publicApi && !internalRequest && !gatewayCredential) {
    authenticatedUser = await authenticateRequest(request)
    if (!authenticatedUser) return json({ message: 'Unauthorized' }, 401)
  }

  if (path[0] === 'api' && (path[1] === 'stt' || path[1] === 'tts')) {
    let voiceContext
    try {
      voiceContext = await voiceAuthorization(request, authenticatedUser, gatewayCredential, internalRequest)
    } catch (error) {
      if (error instanceof GatewayAuthError) return json({ error: { code: error.code, message: 'Voice access is not permitted' } }, 403)
      return json({ error: 'Voice access is not permitted', code: 'FORBIDDEN' }, 403)
    }
    const voiceResponse = await handleVoiceRoute(request, voiceBackends, voiceContext)
    if (voiceResponse) return voiceResponse
  }

  if (path[0] === 'api' && path[1] === 'auth') {
    if (path[2] === 'session' && request.method === 'GET') {
      authenticatedUser = await authenticateRequest(request)
      return json({ user: authenticatedUser, token: null })
    }
    if (path[2] === 'config' && request.method === 'GET') {
      try { return json(await authConfig()) } catch (error) { console.warn(`Auth configuration unavailable: ${redactedDiagnostic(error)}`); return json({ message: 'PocketBase is unavailable' }, 503) }
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
        return json({ message: 'Invalid credentials' }, 401)
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
        return json({ message: 'Registration failed' }, 400)
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
        return json({ message: 'Failed to change password' }, 400)
      }
    }
  }

  if (path[0] === 'api' && path[1] === 'auth-info') {
    if (path[2] === 'config' && request.method === 'GET') {
      try { return json(await authConfig()) } catch (error) { console.warn(`Auth information unavailable: ${redactedDiagnostic(error)}`); return json({ message: 'PocketBase is unavailable' }, 503) }
    }
    if (path[2] === 'me' && request.method === 'GET') return json({ user: await authenticateRequest(request) })
  }

  if (path[1] === 'gateway' && path[2] === 'credentials') {
    if (!authenticatedUser) return json({ error: { code: 'GATEWAY_OWNER_REQUIRED', message: 'An authenticated owner is required' } }, 401)
    const client = await applicationDatabase()
    if (path.length === 3 && request.method === 'GET') return json({ credentials: (await listGatewayCredentials(client, authenticatedUser.id)).map(publicGatewayCredential) })
    if (path.length === 3 && request.method === 'POST') {
      const input = await body(request)
      const permissions = Array.isArray(input.permissions) ? input.permissions.filter((value): value is GatewayPermission => typeof value === 'string') : []
      const scope = input.scope && typeof input.scope === 'object' && !Array.isArray(input.scope) ? input.scope as Record<string, unknown> : undefined
      const created = await createGatewayCredential(client, {
        ownerId: authenticatedUser.id,
        principal: typeof input.principal === 'string' ? input.principal : '',
        permissions,
        scope: { projectIds: Array.isArray(scope?.projectIds) ? scope.projectIds.filter((value): value is string => typeof value === 'string') : [], agentNames: Array.isArray(scope?.agentNames) ? scope.agentNames.filter((value): value is string => typeof value === 'string') : [], sessionIds: Array.isArray(scope?.sessionIds) ? scope.sessionIds.filter((value): value is string => typeof value === 'string') : [] },
        ...(typeof input.expiresAt === 'number' ? { expiresAt: input.expiresAt } : {}),
      })
      return json({ credential: publicGatewayCredential(created.credential), secret: created.secret }, 201)
    }
    if (path.length === 5 && path[4] === 'rotate' && request.method === 'POST') {
      const rotated = await rotateGatewayCredential(client, authenticatedUser.id, decodeURIComponent(path[3] ?? ''))
      return rotated ? json({ credential: publicGatewayCredential(rotated.credential), secret: rotated.secret }, 201) : json({ error: { code: 'GATEWAY_CREDENTIAL_NOT_FOUND', message: 'Gateway credential not found' } }, 404)
    }
    if (path.length === 4 && request.method === 'DELETE') return json({ ok: await revokeGatewayCredential(client, authenticatedUser.id, decodeURIComponent(path[3] ?? '')) })
  }

  if (path[1] === 'automations' && authenticatedUser) {
    const client = await applicationDatabase()
    const automations = new AutomationRepository(client, { serializationScope: 'process' })
    try {
      if (path.length === 3 && path[2] === 'runs' && request.method === 'GET') {
        const limit = routeLimit(url.searchParams.get('limit'))
        const offsetValue = Number(url.searchParams.get('offset') ?? 0)
        const offset = Number.isInteger(offsetValue) && offsetValue >= 0 ? Math.min(offsetValue, 10000) : 0
        const runsCollection = client.collection('automation_runs') as unknown as { getList?: (page: number, perPage: number, options: Record<string, unknown>) => Promise<{ items: Array<Record<string, unknown>> }>; getFullList: (options: Record<string, unknown>) => Promise<Array<Record<string, unknown>>> }
        const page = Math.floor(offset / 100) + 1
        const pageResult = await runsCollection.getList?.(page, 100, { filter: `owner_id = "${escapeFilter(authenticatedUser.id)}"`, sort: '-created_at' })
        const rawRuns = pageResult?.items ?? await runsCollection.getFullList({ filter: `owner_id = "${escapeFilter(authenticatedUser.id)}"`, sort: '-created_at' })
        const definitions = new Map((await automations.listOwned(authenticatedUser.id)).map((item) => [item.id, item]))
        const projectValue = url.searchParams.get('repoId') ?? url.searchParams.get('projectId') ?? undefined
        const projectId = await ownedProjectIdForRoute(client, authenticatedUser.id, projectValue)
        if (projectValue !== undefined && projectId === null) return routeError(correlationId, 'PROJECT_NOT_FOUND', 'Project not found', 404)
        const jobFilter = url.searchParams.get('jobId') ?? url.searchParams.get('automationId')
        const triggerFilter = url.searchParams.get('triggerSource')
        const runs = rawRuns
          .filter((item) => item.owner_id === authenticatedUser.id && definitions.has(String(item.automation_id)))
          .filter((item) => !url.searchParams.get('status') || item.state === url.searchParams.get('status'))
          .filter((item) => !jobFilter || String(item.automation_id) === jobFilter)
          .filter((item) => projectId === undefined || definitions.get(String(item.automation_id))?.project_id === projectId)
          .filter((item) => !triggerFilter || (triggerFilter === 'manual' ? String(item.trigger_key).startsWith('manual') : triggerFilter === 'automation' ? String(item.trigger_key).startsWith('schedule') : true))
          .slice(pageResult ? offset % 100 : offset, pageResult ? (offset % 100) + limit : offset + limit)
          .map((item) => ({ ...item, automation: definitions.get(String(item.automation_id)) }))
        return json({ runs, limit, offset }, 200, correlationId)
      }
      if (path.length === 2 && request.method === 'GET') {
        const projectValue = url.searchParams.get('projectId') ?? url.searchParams.get('project_id') ?? undefined
        const projectId = await ownedProjectIdForRoute(client, authenticatedUser.id, projectValue)
        if (projectValue !== undefined && projectId === null) return routeError(correlationId, 'PROJECT_NOT_FOUND', 'Project not found', 404)
        const values = await automations.listOwned(authenticatedUser.id)
        const filtered = projectId === undefined ? values : values.filter((item) => item.project_id === projectId)
        const limit = routeLimit(url.searchParams.get('limit'), 100)
        return json({ automations: filtered.slice(0, limit), jobs: filtered.slice(0, limit) }, 200, correlationId)
      }
      if (path.length === 2 && request.method === 'POST') {
        const input = await body(request)
        if (typeof input.name !== 'string' || typeof input.prompt !== 'string' || typeof input.agent_id !== 'string' || typeof input.timezone !== 'string' || !input.schedule || typeof input.schedule !== 'object') return routeError(correlationId, 'INVALID_AUTOMATION_INPUT', 'name, prompt, agent_id, timezone, and schedule are required', 400)
        const ownedAgents = await listAgents(client, authenticatedUser.id)
        if (!ownedAgents.some((agent) => agent.id === input.agent_id || agent.name === input.agent_id)) return routeError(correlationId, 'AGENT_NOT_FOUND', 'Agent is not owned by the authenticated user', 403)
        const projectId = await ownedProjectIdForRoute(client, authenticatedUser.id, input.project_id)
        if (projectId === null) return routeError(correlationId, 'PROJECT_NOT_FOUND', 'Project is not owned by the authenticated user', 403)
        const created = await automations.create(authenticatedUser.id, { name: input.name, prompt: input.prompt, agent_id: input.agent_id, timezone: input.timezone, schedule: input.schedule as never, ...(projectId === undefined ? {} : { project_id: projectId }), ...(input.retry_policy && typeof input.retry_policy === 'object' ? { retry_policy: input.retry_policy as never } : {}), ...(input.concurrency_policy === 'allow' || input.concurrency_policy === 'skip' || input.concurrency_policy === 'queue' ? { concurrency_policy: input.concurrency_policy } : {}) })
        if (input.enabled === false) await automations.cancel(authenticatedUser.id, created.id)
        return json({ automation: created, job: created }, 201, correlationId)
      }
      if (path.length === 3) {
        const id = decodeURIComponent(path[2])
        if (request.method === 'GET') { const found = await automations.getOwned(authenticatedUser.id, id); return found ? json({ automation: found, job: found }, 200, correlationId) : routeError(correlationId, 'AUTOMATION_NOT_FOUND', 'Automation not found', 404) }
        if (request.method === 'DELETE') {
          const found = await automations.getOwned(authenticatedUser.id, id)
          if (!found) return routeError(correlationId, 'AUTOMATION_NOT_FOUND', 'Automation not found', 404)
          await client.collection('automations').update(id, { state: 'deleted', updated_at: Date.now() })
          return json({ ok: true }, 200, correlationId)
        }
        if (request.method === 'PATCH' || request.method === 'PUT') {
          const input = await body(request)
          if (Object.keys(input).some((key) => !['name', 'prompt', 'agent_id', 'project_id', 'timezone', 'schedule', 'retry_policy', 'concurrency_policy', 'enabled'].includes(key))) return routeError(correlationId, 'UNSUPPORTED_AUTOMATION_FIELD', 'Unsupported automation field', 400)
          if (typeof input.enabled === 'boolean' && Object.keys(input).length === 1) {
            const found = await automations.getOwned(authenticatedUser.id, id)
            if (!found) return routeError(correlationId, 'AUTOMATION_NOT_FOUND', 'Automation not found', 404)
            if (input.enabled === false) await automations.cancel(authenticatedUser.id, id)
            else await client.collection('automations').update(id, { state: 'active', updated_at: Date.now() })
            const updated = await automations.getOwned(authenticatedUser.id, id)
            return updated ? json({ automation: updated, job: updated }, 200, correlationId) : routeError(correlationId, 'AUTOMATION_NOT_FOUND', 'Automation not found', 404)
          }
          if (typeof input.agent_id === 'string' && !(await listAgents(client, authenticatedUser.id)).some((agent) => agent.id === input.agent_id || agent.name === input.agent_id)) return routeError(correlationId, 'AGENT_NOT_FOUND', 'Agent is not owned by the authenticated user', 403)
          const projectId = await ownedProjectIdForRoute(client, authenticatedUser.id, input.project_id)
          if (projectId === null) return routeError(correlationId, 'PROJECT_NOT_FOUND', 'Project is not owned by the authenticated user', 403)
          const { enabled, ...automationPatch } = input
          const patch = { ...automationPatch, ...(input.project_id !== undefined ? { project_id: projectId } : {}) }
          const updated = await automations.update(authenticatedUser.id, id, patch as never)
          if (!updated) return routeError(correlationId, 'AUTOMATION_NOT_FOUND', 'Automation not found', 404)
          if (typeof enabled === 'boolean') {
            if (enabled === false) await automations.cancel(authenticatedUser.id, id)
            else await client.collection('automations').update(id, { state: 'active', updated_at: Date.now() })
          }
          const result = await automations.getOwned(authenticatedUser.id, id)
          return result ? json({ automation: result, job: result }, 200, correlationId) : routeError(correlationId, 'AUTOMATION_NOT_FOUND', 'Automation not found', 404)
        }
      }
      if (path.length === 4 && path[3] === 'run' && request.method === 'POST') {
        const automationId = decodeURIComponent(path[2])
        const target = await automations.getOwned(authenticatedUser.id, automationId)
        if (!target) return routeError(correlationId, 'AUTOMATION_NOT_FOUND', 'Automation not found', 404)
        const input = await body(request)
        const key = input.trigger_key === undefined ? `manual:${Date.now()}` : validateTriggerKey(input.trigger_key)
        const queued = await automations.trigger(authenticatedUser.id, automationId, key)
        const run = await automationWorkerFor(client).execute(authenticatedUser.id, queued.id)
        return json({ run }, run.state === 'pending' || run.state === 'retrying' ? 202 : 200, correlationId)
      }
      if ((path.length === 4 && path[3] === 'cancel' || path.length === 5 && path[3] === 'runs' && path[4] === 'cancel' || path.length === 6 && path[3] === 'runs' && path[5] === 'cancel') && request.method === 'POST') {
        const automationId = decodeURIComponent(path[2])
        const runId = path.length === 6 ? decodeURIComponent(path[4]) : (await body(request)).run_id
        if (typeof runId !== 'string' || !runId.trim()) return routeError(correlationId, 'AUTOMATION_RUN_REQUIRED', 'run_id is required', 400)
        const run = await client.collection('automation_runs').getOne(runId).catch(() => null) as Record<string, unknown> | null
        if (!run || run.owner_id !== authenticatedUser.id || run.automation_id !== automationId) return routeError(correlationId, 'AUTOMATION_RUN_NOT_FOUND', 'Automation run not found', 404)
        const cancelled = await automations.cancelRun(authenticatedUser.id, runId)
        if (cancelled) await automationWorkerFor(client).executeDue()
        return cancelled ? json({ run: cancelled }, 200, correlationId) : routeError(correlationId, 'AUTOMATION_RUN_NOT_FOUND', 'Automation run not found', 404)
      }
      if (path.length === 4 && path[3] === 'history' && request.method === 'GET') return json({ runs: (await automations.history(authenticatedUser.id, decodeURIComponent(path[2]))).slice(0, routeLimit(url.searchParams.get('limit'))) }, 200, correlationId)
      if (path.length === 5 && path[3] === 'runs' && request.method === 'GET') {
        const automationId = decodeURIComponent(path[2])
        const runId = decodeURIComponent(path[4])
        const owned = await automations.getOwned(authenticatedUser.id, automationId)
        const run = owned ? (await automations.history(authenticatedUser.id, automationId)).find((candidate) => candidate.id === runId) : undefined
        return run ? json({ run }, 200, correlationId) : routeError(correlationId, 'AUTOMATION_RUN_NOT_FOUND', 'Automation run not found', 404)
      }
    } catch (error) {
      const code = error instanceof RequestSecurityError ? error.code : error instanceof Error && error.message === TRIGGER_KEY_ERROR ? 'INVALID_TRIGGER_KEY' : error instanceof Error && error.message.includes('not found') ? 'AUTOMATION_NOT_FOUND' : 'AUTOMATION_REQUEST_FAILED'
      const status = error instanceof RequestSecurityError ? error.status : code === 'AUTOMATION_NOT_FOUND' ? 404 : 400
      return routeError(correlationId, code, error instanceof Error ? error.message : 'Automation request failed', status)
    }
  }

  if (path[1] === 'inbox' && authenticatedUser) {
    const client = await applicationDatabase()
    const inbox = new InboxRepository(client)
    try {
      if (path.length === 2 && request.method === 'GET') return json({ items: await inbox.list(authenticatedUser.id, url.searchParams.get('projectId') ?? undefined) })
      if (path.length === 4 && path[3] === 'resolve' && request.method === 'POST') { const item = await inbox.resolve(authenticatedUser.id, decodeURIComponent(path[2])); return item ? json({ item }) : json({ error: 'Inbox item not found' }, 404) }
      if (path.length === 3 && request.method === 'POST') {
        const input = await body(request)
        if (typeof input.kind !== 'string' || typeof input.reference_id !== 'string' || typeof input.title !== 'string') return json({ error: 'kind, reference_id, and title are required' }, 400)
        if (typeof input.project_id === 'string' && !(await createProjectSessionRepository(client).getProject(authenticatedUser.id, input.project_id))) return json({ error: 'Project is not owned by the authenticated user' }, 403)
        return json({ item: await inbox.upsert({
          owner_id: authenticatedUser.id,
          kind: input.kind as never,
          reference_id: input.reference_id,
          title: input.title,
          ...(typeof input.body === 'string' ? { body: input.body } : {}),
          ...(typeof input.project_id === 'string' ? { project_id: input.project_id } : {}),
          ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
          ...(input.deep_link !== undefined ? { deep_link: input.deep_link as Record<string, string> } : {}),
          ...(input.reopen === true ? { reopen: true } : {}),
          ...(typeof input.underlying_state === 'string' ? { underlying_state: input.underlying_state } : {}),
        }) }, 201)
      }
    } catch (error) { return json({ error: error instanceof Error ? error.message : 'Inbox request failed' }, 400) }
  }

  if (path[1] === 'notifications' && authenticatedUser) {
    try {
      const client = await applicationDatabase()
      const notifications = new NotificationRepository(client)
      if (path.length === 2 && request.method === 'GET') return json({ subscriptions: await notifications.list(authenticatedUser.id) }, 200, correlationId)
      if (path.length === 2 && request.method === 'POST') {
        const input = await body(request)
        if ((input.channel !== 'push' && input.channel !== 'email') || typeof input.target !== 'string') return routeError(correlationId, 'INVALID_NOTIFICATION_SUBSCRIPTION', 'channel and target are required', 400)
        return json({ subscription: await notifications.subscribe(authenticatedUser.id, { channel: input.channel, target: input.target }) }, 201, correlationId)
      }
      if (path.length === 3 && path[2] === 'subscribe' && (request.method === 'POST' || request.method === 'DELETE')) {
        const input = await body(request)
        if (typeof input.endpoint !== 'string' || !input.endpoint.trim()) return routeError(correlationId, 'INVALID_NOTIFICATION_SUBSCRIPTION', 'endpoint is required', 400)
        const rows = await client.collection('notification_subscriptions').getFullList({ filter: `owner_id = "${escapeFilter(authenticatedUser.id)}"` }) as Array<Record<string, unknown>>
        const existing = rows.find((item) => item.owner_id === authenticatedUser.id && item.target === input.endpoint)
        if (request.method === 'DELETE') {
          if (!existing) return routeError(correlationId, 'NOTIFICATION_SUBSCRIPTION_NOT_FOUND', 'Notification subscription not found', 404)
          await client.collection('notification_subscriptions').delete(String(existing.id))
          return json({ success: true }, 200, correlationId)
        }
        if (existing) return json({ subscription: existing }, 200, correlationId)
        return json({ subscription: await notifications.subscribe(authenticatedUser.id, { channel: 'push', target: input.endpoint }) }, 201, correlationId)
      }
      if (path.length === 3 && path[2] === 'subscriptions' && request.method === 'GET') return json({ subscriptions: await notifications.list(authenticatedUser.id) }, 200, correlationId)
      if (path.length === 3 && path[2] === 'subscriptions' && request.method === 'POST') {
        const input = await body(request)
        if ((input.channel !== 'push' && input.channel !== 'email') || typeof input.target !== 'string') return routeError(correlationId, 'INVALID_NOTIFICATION_SUBSCRIPTION', 'channel and target are required', 400)
        return json({ subscription: await notifications.subscribe(authenticatedUser.id, { channel: input.channel, target: input.target }) }, 201, correlationId)
      }
      if (path.length === 4 && path[2] === 'subscriptions' && request.method === 'DELETE') {
        const subscription = await client.collection('notification_subscriptions').getOne(decodeURIComponent(path[3])).catch(() => null) as Record<string, unknown> | null
        if (!subscription || subscription.owner_id !== authenticatedUser.id) return routeError(correlationId, 'NOTIFICATION_SUBSCRIPTION_NOT_FOUND', 'Notification subscription not found', 404)
        await client.collection('notification_subscriptions').delete(String(subscription.id))
        return json({ success: true }, 200, correlationId)
      }
      if (path.length === 3 && path[2] === 'subscriptions' && request.method === 'DELETE') {
        const input = await body(request)
        if (typeof input.endpoint !== 'string' || !input.endpoint.trim()) return routeError(correlationId, 'INVALID_NOTIFICATION_SUBSCRIPTION', 'endpoint is required', 400)
        const rows = await client.collection('notification_subscriptions').getFullList({ filter: `owner_id = "${escapeFilter(authenticatedUser.id)}"` }) as Array<Record<string, unknown>>
        const subscription = rows.find((item) => item.owner_id === authenticatedUser.id && item.target === input.endpoint)
        if (!subscription) return routeError(correlationId, 'NOTIFICATION_SUBSCRIPTION_NOT_FOUND', 'Notification subscription not found', 404)
        await client.collection('notification_subscriptions').delete(String(subscription.id))
        return json({ success: true }, 200, correlationId)
      }
      if (path.length === 3 && path[2] === 'preferences' && request.method === 'GET') {
        const record = await getUserPreferences(client, authenticatedUser.id)
        return json({ preferences: notificationPreferenceValue(record?.preferences && object(record.preferences).notifications), updatedAt: record?.updated_at ?? Date.now() }, 200, correlationId)
      }
      if (path.length === 3 && path[2] === 'preferences' && request.method === 'PATCH') {
        const input = await body(request)
        const record = await getUserPreferences(client, authenticatedUser.id)
        const current = object(record?.preferences)
        const requested = object(input.preferences ?? input)
        const saved = await saveUserPreferences(client, authenticatedUser.id, { ...current, notifications: notificationPreferenceValue({ ...object(current.notifications), ...requested, events: { ...object(object(current.notifications).events), ...object(requested.events) } }) })
        return json({ preferences: notificationPreferenceValue(object(saved.preferences).notifications), updatedAt: saved.updated_at ?? Date.now() }, 200, correlationId)
      }
      if (path.length === 3 && path[2] === 'delivery-status' && request.method === 'GET') {
        const limit = routeLimit(url.searchParams.get('limit'))
        const rows = (await client.collection('notification_deliveries').getList(1, limit, { filter: `owner_id = "${escapeFilter(authenticatedUser.id)}"`, sort: '-created_at' })).items as Array<Record<string, unknown>>
        const deliveries = rows.filter((item) => item.owner_id === authenticatedUser.id).slice(0, limit).map((item) => ({ id: item.id, inbox_id: item.inbox_id, subscription_id: item.subscription_id, state: item.state, error_message: item.error_message, created_at: item.created_at }))
        return json({ deliveries }, 200, correlationId)
      }
      if (path.length === 3 && path[2] === 'vapid-public-key' && request.method === 'GET') {
        const publicKey = process.env.VAPID_PUBLIC_KEY?.trim()
        return publicKey ? json({ publicKey }, 200, correlationId) : routeError(correlationId, 'NOTIFICATION_PUSH_UNAVAILABLE', 'Push notifications are not configured', 503)
      }
      if (path.length === 3 && path[2] === 'test' && request.method === 'POST') return routeError(correlationId, 'NOTIFICATION_TEST_UNAVAILABLE', 'Notification test delivery is not configured', 501)
    } catch (error) {
      return routeError(correlationId, 'NOTIFICATION_REQUEST_FAILED', error instanceof Error ? error.message : 'Notification request failed', 400)
    }
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
           ...(input.template === 'general' || input.template === 'coding' || input.template === 'plan' || input.template === 'reviewer' ? { template: input.template } : {}),
           ...(typeof input.model === 'string' ? { model: input.model } : {}),
           ...(input.thinking === 'off' || input.thinking === 'minimal' || input.thinking === 'low' || input.thinking === 'medium' || input.thinking === 'high' ? { thinking: input.thinking } : {}),
           ...(input.approval_mode === 'auto' || input.approval_mode === 'ask' || input.approval_mode === 'deny' ? { approval_mode: input.approval_mode } : {}),
           ...(input.policies && typeof input.policies === 'object' ? { policies: input.policies } : {}),
           ...(input.project_overrides && typeof input.project_overrides === 'object' ? { project_overrides: input.project_overrides } : {}),
           ...(input.tool_context_modes && typeof input.tool_context_modes === 'object' ? { tool_context_modes: input.tool_context_modes } : {}),
           ...(input.skill_context_modes && typeof input.skill_context_modes === 'object' ? { skill_context_modes: input.skill_context_modes } : {}),
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
           ...(input.template === 'general' || input.template === 'coding' || input.template === 'plan' || input.template === 'reviewer' ? { template: input.template } : {}),
           ...(typeof input.model === 'string' ? { model: input.model } : {}),
           ...(input.thinking === 'off' || input.thinking === 'minimal' || input.thinking === 'low' || input.thinking === 'medium' || input.thinking === 'high' ? { thinking: input.thinking } : {}),
           ...(input.approval_mode === 'auto' || input.approval_mode === 'ask' || input.approval_mode === 'deny' ? { approval_mode: input.approval_mode } : {}),
           ...(input.policies && typeof input.policies === 'object' ? { policies: input.policies } : {}),
           ...(input.project_overrides && typeof input.project_overrides === 'object' ? { project_overrides: input.project_overrides } : {}),
           ...(input.tool_context_modes && typeof input.tool_context_modes === 'object' ? { tool_context_modes: input.tool_context_modes } : {}),
           ...(input.skill_context_modes && typeof input.skill_context_modes === 'object' ? { skill_context_modes: input.skill_context_modes } : {}),
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
      console.warn(`Agent store request failed: ${redactedDiagnostic(error)}`)
      return json({ message: 'Agent store unavailable' }, 503)
    }
  }

  if (path[1] === 'tasks' && authenticatedUser) {
    const tasks = new TaskRepository(await applicationDatabase())
    try {
      if (path.length === 2 && request.method === 'GET') {
        const states = url.searchParams.getAll('state').filter((value): value is TaskState => ['draft', 'queued', 'running', 'waiting_for_input', 'waiting_for_approval', 'review_required', 'failed', 'completed', 'cancelled'].includes(value))
        return json({ tasks: await tasks.listOwned(authenticatedUser.id, states) })
      }
      if (path.length === 2 && request.method === 'POST') {
        const input = object(await body(request)); const title = typeof input.title === 'string' ? input.title.trim() : ''
        if (!title) return json({ error: 'title is required' }, 400)
        const state = input.state === 'draft' ? 'draft' : 'queued'
        const client = await applicationDatabase()
        const repository = createProjectSessionRepository(client)
        const kind = input.kind === 'subagent_run' ? 'subagent_run' : 'task'
        const sessionId = typeof input.sessionId === 'string' ? input.sessionId.trim() : ''
        const requestedProjectId = typeof input.projectId === 'string' ? input.projectId.trim() : ''
        const session = sessionId ? await repository.getSession(authenticatedUser.id, sessionId) : null
        if (sessionId && !session) throw new TaskRequestError('SESSION_NOT_FOUND', 'Session not found', 404)
        const projectId = requestedProjectId || session?.projectId || undefined
        const project = projectId ? await repository.getProject(authenticatedUser.id, projectId) : null
        if (projectId && !project) throw new TaskRequestError('PROJECT_NOT_FOUND', 'Project not found', 404)
        if (session?.projectId && projectId !== session.projectId) throw new TaskRequestError('SESSION_PROJECT_MISMATCH', 'Session and project do not match')

        const parentRunId = typeof input.parentRunId === 'string' ? input.parentRunId.trim() : ''
        const parentRun = parentRunId ? await tasks.getOwned(authenticatedUser.id, parentRunId) : null
        if (parentRunId && !parentRun) throw new TaskRequestError('PARENT_TASK_NOT_FOUND', 'Parent task not found', 404)
        if (parentRun && !sessionId && !projectId) throw new TaskRequestError('PARENT_CONTEXT_REQUIRED', 'Parent task requires an owned session or project')
        if (parentRun && ((sessionId && parentRun.session_id !== sessionId) || (projectId && parentRun.project_id !== projectId))) throw new TaskRequestError('PARENT_CONTEXT_MISMATCH', 'Parent task context does not match')

        const agents = await listAgents(client, authenticatedUser.id)
        const resolveAgent = (value: unknown, code: string) => {
          if (typeof value !== 'string' || !value.trim()) return undefined
          const agent = agents.find((candidate) => candidate.id === value.trim() || candidate.name === value.trim())
          if (!agent) throw new TaskRequestError(code, 'Agent not found', 404)
          if (!agent.enabled) throw new TaskRequestError('AGENT_DISABLED', 'Agent is disabled', 409)
          return agent
        }
        const parentAgent = resolveAgent(input.agentId ?? session?.profile, 'PARENT_AGENT_NOT_FOUND')
        const targetAgent = resolveAgent(input.subagentId, 'TARGET_AGENT_NOT_FOUND')
        if (kind === 'subagent_run') {
          if (!session) throw new TaskRequestError('SESSION_REQUIRED', 'An owned session is required')
          if (!projectId) throw new TaskRequestError('PROJECT_REQUIRED', 'An owned project is required')
          if (!parentAgent || !targetAgent) throw new TaskRequestError('AGENT_REQUIRED', 'Parent and target agents are required')
          if (session.profile && parentAgent.name !== session.profile && parentAgent.id !== session.profile) throw new TaskRequestError('SESSION_AGENT_MISMATCH', 'Session and parent agent do not match')
          if (targetAgent.mode !== 'subagent') throw new TaskRequestError('TARGET_AGENT_DENIED', 'Target agent is not a subagent', 403)
          if (project?.agentNames?.length && !project.agentNames.includes(targetAgent.name) && !project.agentNames.includes(targetAgent.id)) throw new TaskRequestError('TARGET_AGENT_DENIED', 'Target agent is not enabled for this project', 403)
          const configuredTarget = effectiveAgentConfiguration(targetAgent, projectId)
          const requested = object(input.input).capabilities
          const capabilities = Array.isArray(requested) ? requested.filter((value): value is string => typeof value === 'string') : []
          const ceiling = new Set(['subagent/run', 'read', 'write', 'bash'].filter((capability) => capability === 'subagent/run' ? configuredTarget.policies.subagent : configuredTarget.policies.builtin[capability]))
          if (capabilities.some((capability) => !ceiling.has(capability))) throw new TaskRequestError('CAPABILITY_ESCALATION', 'Requested capabilities exceed the target agent ceiling', 403)
        }
        return json({ task: await tasks.create({ owner_id: authenticatedUser.id, project_id: projectId, session_id: (session?.id ?? sessionId) || undefined, parent_run_id: parentRun?.id, agent_id: parentAgent?.id, subagent_id: targetAgent?.id, state, kind, title, input: input.input }) }, 201)
      }
      const taskId = decodeURIComponent(path[2] ?? '')
      const ownedTask = await tasks.getOwned(authenticatedUser.id, taskId)
      if (path.length >= 3 && !ownedTask) return json({ error: { code: 'TASK_NOT_FOUND', message: 'Task not found' } }, 404)
      if (path.length === 3 && request.method === 'GET') {
        return json({ task: ownedTask })
      }
      if (path.length === 4 && path[3] === 'activity' && request.method === 'GET') return json({ activity: await tasks.listActivity(authenticatedUser.id, taskId) })
      if (path.length === 4 && path[3] === 'audit' && request.method === 'GET') return json({ audit: await tasks.listAudit(authenticatedUser.id, taskId) })
      if (path.length === 4 && path[3] === 'worktree' && request.method === 'GET') {
        const worktree = await (await applicationDatabase()).collection('task_worktrees').getFirstListItem(`owner_id = "${escapeFilter(authenticatedUser.id)}" && task_id = "${escapeFilter(taskId)}"`).catch(() => null)
        return worktree ? json({ worktree }) : json({ error: { code: 'WORKTREE_NOT_FOUND', message: 'Worktree not found' } }, 404)
      }
      if (path.length === 4 && path[3] === 'cancel' && request.method === 'POST') {
        if (subagentController) return json({ task: await subagentController.cancel(authenticatedUser.id, taskId) })
        return json({ task: await tasks.transition(authenticatedUser.id, taskId, 'cancelled', { error_code: 'CANCELLED' }) })
      }
      if (path.length === 4 && path[3] === 'resume' && request.method === 'POST') {
        if (!subagentController) return json({ error: { code: 'SUBAGENT_UNAVAILABLE', message: 'Subagent execution host is unavailable' } }, 503)
        return json({ task: await subagentController.resume(authenticatedUser.id, taskId) })
      }
      if (path.length === 4 && path[3] === 'review' && request.method === 'POST') {
        const input = object(await body(request)); if (input.decision !== 'approved' && input.decision !== 'rejected') return json({ error: 'decision must be approved or rejected' }, 400)
        return json({ task: await tasks.review(authenticatedUser.id, taskId, input.decision, typeof input.note === 'string' ? input.note : undefined) })
      }
      return json({ error: 'Task route not found' }, 404)
    } catch (error) {
      if (error instanceof TaskRequestError) return json({ error: { code: error.code, message: error.message } }, error.status)
      if (error instanceof TaskControlError) return json({ error: { code: error.code, message: error.message } }, error.code === 'TASK_NOT_FOUND' ? 404 : 409)
      throw error
    }
  }

  if (path[1] === 'browser' && path[2] === 'sessions' && authenticatedUser) {
    const browser = new BrowserSessionService(await applicationDatabase())
    const browserContext = (input: Record<string, unknown> = {}) => ({ ownerId: authenticatedUser!.id, ...(typeof input.projectId === 'string' && input.projectId.trim() ? { projectId: input.projectId.trim() } : {}), ...(typeof input.sessionId === 'string' && input.sessionId.trim() ? { sessionId: input.sessionId.trim() } : {}), ...(typeof input.taskId === 'string' && input.taskId.trim() ? { taskId: input.taskId.trim() } : {}) })
    try {
      if (path.length === 3 && request.method === 'POST') {
        const input = object(await body(request))
        return json({ session: await browser.create(browserContext(input), object(input.limits)) }, 201)
      }
      if (path.length === 3 && request.method === 'GET') return json({ sessions: await browser.list(browserContext({ projectId: url.searchParams.get('projectId') ?? undefined, sessionId: url.searchParams.get('sessionId') ?? undefined, taskId: url.searchParams.get('taskId') ?? undefined })) })
      const browserId = decodeURIComponent(path[3] ?? '')
      const context = browserContext({ projectId: url.searchParams.get('projectId') ?? undefined, sessionId: url.searchParams.get('sessionId') ?? undefined, taskId: url.searchParams.get('taskId') ?? undefined })
      if (path.length === 4 && request.method === 'GET') return json({ session: await browser.get(context, browserId) })
      if (path.length === 5 && path[4] === 'close' && request.method === 'POST') return json({ session: await browser.close(context, browserId) })
      if (path.length === 5 && path[4] === 'audit' && request.method === 'GET') {
        const owned = await browser.get(context, browserId)
        const audit = await (await applicationDatabase()).collection('browser_audit').getFullList({ filter: `owner_id = "${escapeFilter(authenticatedUser.id)}" && browser_session_id = "${escapeFilter(owned.id)}"`, sort: '-created_at' })
        return json({ audit })
      }
      return json({ error: 'Browser session route not found' }, 404)
    } catch (error) {
      if (error instanceof BrowserRuntimeError) return json({ error: { code: error.code, message: error.message } }, error.code === 'BROWSER_SESSION_NOT_FOUND' ? 404 : 409)
      console.warn(`Browser session request failed: ${redactedDiagnostic(error)}`)
      return json({ error: { code: 'BROWSER_UNAVAILABLE', message: 'Browser session store unavailable' } }, 503)
    }
  }

  if (path[1] === 'providers' && authenticatedUser) {
    try {
      const userId = authenticatedUser.id

      if (path[2] === 'custom') {
        const customProviders = createCustomProviderService(await applicationDatabase())
        if (path.length === 3 && request.method === 'GET') return json({ providers: await customProviders.list(userId) })
        if (path.length === 3 && request.method === 'POST') {
          const input = object(await body(request))
          const id = typeof input.id === 'string' ? input.id.trim() : ''
          const name = typeof input.name === 'string' ? input.name.trim() : ''
          const baseUrl = typeof input.baseUrl === 'string' ? input.baseUrl.trim() : ''
          if (!id || !/^[a-zA-Z0-9_-]+$/.test(id) || !name || !baseUrl) return json({ message: 'id, name, and baseUrl are required' }, 400)
          const saved = await customProviders.save(userId, input)
          return json({ provider: saved.provider }, saved.created ? 201 : 200)
        }
        if (path.length === 4 && request.method === 'DELETE') {
          const id = decodeURIComponent(path[3] ?? '')
          await customProviders.delete(userId, id)
          return json({ ok: true })
        }
        if (path.length === 4 && path[3] === 'discover-models' && request.method === 'POST') {
          try {
            const input = object(await body(request))
            const baseUrl = typeof input.baseUrl === 'string' ? input.baseUrl.trim() : ''
            if (!baseUrl) return json({ message: 'baseUrl is required' }, 400)
            const discoveryUrl = customProviderDiscoveryUrl(baseUrl)
            const headers: Record<string, string> = { Accept: 'application/json' }
            if (typeof input.apiKey === 'string' && input.apiKey) headers.Authorization = `Bearer ${input.apiKey}`
            const networkPolicy = networkPolicyFromMetadata(input)
            const response = await fetchWithNetworkPolicy(discoveryUrl, { headers }, networkPolicy)
            if (!response.ok) return json({ message: `Model discovery failed with HTTP ${response.status}` }, 502)
            const payload = object(JSON.parse(await readBoundedResponse(response, networkPolicy.maxResponseBytes ?? 4 * 1024 * 1024)))
            const models = Array.isArray(payload.data)
              ? payload.data.map((model) => object(model)).map((model) => model.id).filter((id): id is string => typeof id === 'string')
              : []
            return json({ models })
          } catch (error) {
            if (error instanceof CustomProviderValidationError) return json({ message: error.message }, 400)
            if (error instanceof RequestSecurityError) return json({ message: error.message }, error.status)
            console.warn(`Custom provider discovery failed: ${redactedDiagnostic(error)}`)
            return json({ message: 'Model discovery failed' }, 502)
          }
        }
        return json({ message: 'Not found' }, 404)
      }

      const accountService = await providerAccountService()

      if (path[2] === 'catalog' && request.method === 'GET' && path.length === 3) {
        const query = new URL(request.url).searchParams
        const shouldRefresh = query.get('refresh') !== 'false'
        const forceRefresh = query.get('force') === 'true' || query.get('force') === '1'
        const accounts = await accountService.listAccounts(userId)
        // Use the global catalog here so unconfigured providers remain visible
        // and users can start a login flow. The account records are still
        // scoped to this user and are the only account instances returned.
        const runtime = await modelRuntimePromise

        if (shouldRefresh) {
          // Refresh the shared provider catalog when possible. A failed
          // provider refresh must not hide models already in the local catalog.
          try {
            await runtime.refresh({
              allowNetwork: true,
              force: forceRefresh,
              signal: AbortSignal.timeout(15_000),
            })
          } catch (error) {
            console.warn(`Provider catalog refresh failed: ${redactedDiagnostic(error)}`)
          }
        }

        const catalog = await createProviderCatalogAsync(runtime, {
          accounts: accounts.map(providerCatalogAccount),
          includeRuntimeInstance: false,
          signal: AbortSignal.timeout(15_000),
        })
        return json({ catalog })
      }

      if (path[2] === 'accounts') {
        if (path.length === 3 && request.method === 'GET') {
          const accounts = await accountService.listAccounts(userId)
          return json({ accounts: accounts.map(providerAccountInstance) })
        }
        if (path.length >= 4) {
          const wireInstanceId = path[3]
          const owned = await ownedProviderAccount(userId, wireInstanceId)
          if (!owned) return json({ message: 'Provider account not found' }, 404)
          if (path[4] === 'status' && request.method === 'GET' && path.length === 5) {
            const status = await accountService.getAccountStatus(userId, owned.account.instanceId)
            return json({ status })
          }
          if (path.length === 4 && request.method === 'GET') return json({ account: providerAccountInstance(owned.account) })
          if (path.length === 4 && request.method === 'PATCH') {
            const input = await body(request)
            const update: { displayName?: string; status?: 'active' | 'disabled' } = {
              ...(typeof input.displayName === 'string' ? { displayName: input.displayName } : {}),
              ...(input.status === 'active' || input.status === 'disabled' ? { status: input.status } : {}),
            }
            const updated = await accountService.updateAccount(userId, owned.account.instanceId, update)
            return updated ? json({ account: providerAccountInstance(updated) }) : json({ message: 'Provider account not found' }, 404)
          }
          if (path.length === 4 && request.method === 'DELETE') {
            await accountService.deleteAccount(userId, owned.account.instanceId)
            return json({ ok: true })
          }
        }
      }

      if (path[2] === 'login-flows') {
        const controller = await providerLoginFlowController()
        if (path.length === 3 && request.method === 'POST') {
          const input = await body(request)
          if (typeof input.providerInstanceId !== 'string' || typeof input.type !== 'string') return json({ message: 'providerInstanceId and type are required' }, 400)
          if (input.type !== 'api_key' && input.type !== 'oauth') return json({ message: 'type must be api_key or oauth' }, 400)
          const providerInstanceId = input.providerInstanceId.trim()
          if (!providerInstanceId) return json({ message: 'providerInstanceId is required' }, 400)
          const parsed = parseProviderRuntimeId(providerInstanceId)
          if (parsed) {
            if (!(await ownedProviderAccount(userId, providerInstanceId))) return json({ message: 'Provider account not found' }, 404)
          } else if (!(await modelRuntimePromise).getProvider(providerInstanceId)) {
            return json({ message: 'Provider not found' }, 404)
          }
          const flow = await controller.start({
            ownerId: userId,
            providerInstanceId,
            type: input.type,
            ...(typeof input.displayName === 'string' && input.displayName.trim() ? { displayName: input.displayName } : {}),
          })
          return json({ flow }, 201)
        }
        if (path.length >= 4) {
          const flowId = decodeURIComponent(path[3] ?? '')
          if (path.length === 4 && request.method === 'GET') return json({ status: await controller.status({ ownerId: userId, flowId }) })
          if (path.length === 5 && path[4] === 'events' && request.method === 'GET') {
            const after = url.searchParams.get('after')
            const limit = url.searchParams.get('limit')
            return json(await controller.getEvents({
              ownerId: userId,
              flowId,
              ...(after === null ? {} : { after: Number(after) }),
              ...(limit === null ? {} : { limit: Number(limit) }),
            }))
          }
          if (path.length === 5 && path[4] === 'respond' && request.method === 'POST') {
            const input = await body(request)
            if (typeof input.promptId !== 'string' || typeof input.value !== 'string') return json({ message: 'promptId and value are required' }, 400)
            return json({ status: await controller.respond({ ownerId: userId, flowId, promptId: input.promptId, value: input.value }) })
          }
          if (path.length === 5 && path[4] === 'cancel' && request.method === 'POST') {
            return json({ status: await controller.cancel({ ownerId: userId, flowId }) })
          }
        }
      }
    } catch (error) {
      if (error instanceof CustomProviderValidationError) return json({ message: error.message }, 400)
      if (error instanceof RequestSecurityError) return json({ message: error.message }, error.status)
      if (error instanceof ProviderLoginFlowError) {
        const status = error.code === 'FLOW_NOT_FOUND' ? 404
          : error.code === 'FLOW_EXPIRED' ? 410
            : error.code === 'INVALID_INPUT' || error.code === 'INVALID_PROMPT_RESPONSE' ? 400 : 409
        return json({ message: 'Provider login request failed', code: error.code }, status)
      }
      const storageError = providerLoginFlowStorageError(error)
      console.error('Provider login flow request failed', redactSensitive(storageError))
      return json({ message: 'Provider login storage unavailable' }, 503)
    }
  }

  if (request.method === 'GET' && url.pathname === '/api/usage/daily') return json(await dailyUsage(authenticatedUser!.id, await applicationDatabase()))
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
  if (path[1] === 'projects' && path.length >= 4 && path[3] === 'repository' && request.method === 'GET') {
    const projectId = decodeURIComponent(path[2] ?? '')
    try {
      const client = await applicationDatabase()
      const projectRepository = createProjectSessionRepository(client)
      const service = new GitReadService(new GitPathPolicy((owner, id) => projectRepository.getProject(owner, id)))
      const action = path[4]
      const result = action === undefined ? await service.discover(authenticatedUser!.id, projectId, request.signal)
        : action === 'status' && path.length === 5 ? await service.status(authenticatedUser!.id, projectId, request.signal)
          : action === 'branches' && path.length === 5 ? await service.branches(authenticatedUser!.id, projectId, request.signal)
            : action === 'worktrees' && path.length === 5 ? await service.worktrees(authenticatedUser!.id, projectId, request.signal)
              : action === 'diff' && path.length === 5 ? await service.diff(authenticatedUser!.id, projectId, { path: url.searchParams.get('path') ?? undefined, ref: url.searchParams.get('ref') ?? undefined, staged: url.searchParams.get('staged') === 'true' }, request.signal)
                : null
      if (!result) return json({ error: { code: 'NOT_FOUND', message: 'Repository route not found' }, requestId: correlationId }, 404)
      return json({ ...result, requestId: correlationId })
    } catch (error) {
      if (error instanceof GitServiceError) return json({ error: { code: error.code, message: error.message }, requestId: correlationId }, error.status)
      console.warn(`Git read request failed: ${redactedDiagnostic(error)}`)
      return json({ error: { code: 'GIT_UNAVAILABLE', message: 'Git repository information is unavailable' }, requestId: correlationId }, 503)
    }
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
    const directory = safeProjectPath(typeof input.directory === 'string' && input.directory.trim()
      ? input.directory
      : join(projectsRoot, 'projects', name.toLocaleLowerCase().replace(/[^a-z0-9]+/g, '-')))
    const client = await applicationDatabase()
    await ensureUserMetadata(authenticatedUser!.id)
    const repository = createProjectSessionRepository(client)
    if (await repository.findProjectByName(authenticatedUser!.id, name)) return json({ error: 'Project already exists' }, 409)
    let created
    try {
      await repository.assertProjectPathAvailable(authenticatedUser!.id, directory)
      mkdirSync(directory, { recursive: true })
      created = await repository.createProject(authenticatedUser!.id, {
        name,
        path: directory,
        ...(Array.isArray(input.agentNames) ? { agentNames: input.agentNames.filter((agentName): agentName is string => typeof agentName === 'string') } : {}),
      })
    } catch (error) {
      if (error instanceof ProjectPathConflictError) return json({ error: error.message, code: error.code }, 409)
      throw error
    }
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
    const directory = typeof input.directory === 'string' && input.directory.trim() ? safeProjectPath(input.directory) : safeProjectPath(current.path)
    let updated
    try {
      await createProjectSessionRepository(client).assertProjectPathAvailable(authenticatedUser!.id, directory, current.id)
      mkdirSync(directory, { recursive: true })
      updated = await createProjectSessionRepository(client).updateProject(authenticatedUser!.id, current.id, {
        name,
        path: directory,
        ...(Array.isArray(input.agentNames) ? { agentNames: input.agentNames.filter((agentName): agentName is string => typeof agentName === 'string') } : {}),
      })
    } catch (error) {
      if (error instanceof ProjectPathConflictError) return json({ error: error.message, code: error.code }, 409)
      throw error
    }
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
  if (request.method === 'POST' && path[1] === 'attachments' && path[2] === 'project') {
    const input = await body(request)
    if (typeof input.directory !== 'string' || typeof input.path !== 'string') return json({ error: 'directory and path are required' }, 400)
    const directory = input.directory
    const requestedPath = input.path
    const client = await applicationDatabase()
    const owned = await createProjectSessionRepository(client).listProjects(authenticatedUser!.id)
    const project = owned.find((item) => canonicalProjectPath(item.path) === canonicalProjectPath(directory))
    if (!project) return json({ error: 'Project path is not owned by the authenticated user' }, 403)
    const file = assertPathWithinWorkspace(requestedPath, project.path)
    const info = statSync(file)
    if (!info.isFile()) return json({ error: 'Attachment is not a file' }, 400)
    if (!/\.(md|mdx|txt|json|csv|xml|ya?ml|js|jsx|ts|tsx|css|html|pdf|png|jpe?g|gif|webp)$/i.test(file)) return json({ error: 'File type is not supported' }, 415)
    if (info.size > 10 * 1024 * 1024) return json({ error: 'Attachment exceeds the 10 MB limit' }, 413)
    return json({ path: file, name: file.split('/').pop() ?? file, size: info.size, mime: 'text/plain' })
  }
  if (request.method === 'POST' && path[1] === 'attachments' && path[2] === 'markdown') {
    const input = await body(request)
    if (typeof input.directory !== 'string' || typeof input.name !== 'string' || typeof input.content !== 'string') return json({ error: 'directory, name, and content are required' }, 400)
    const directory = input.directory
    const name = input.name
    const content = input.content
    if (!/^[a-zA-Z0-9._-]+\.md$/i.test(input.name) || input.content.length > 10 * 1024 * 1024) return json({ error: 'Invalid Markdown attachment' }, 400)
    const client = await applicationDatabase()
    const owned = await createProjectSessionRepository(client).listProjects(authenticatedUser!.id)
    const project = owned.find((item) => canonicalProjectPath(item.path) === canonicalProjectPath(directory))
    if (!project) return json({ error: 'Project path is not owned by the authenticated user' }, 403)
    const file = assertPathWithinWorkspace(join(project.path, name), project.path)
    writeFileSync(file, content, 'utf8')
    return json({ path: file, name }, 201)
  }
  if (request.method === 'POST' && path[1] === 'attachments' && path[2] === 'website') {
    const input = await body(request)
    if (typeof input.url !== 'string') return json({ error: 'url is required' }, 400)
    const target = new URL(input.url)
    const response = await fetchWithNetworkPolicy(target, {}, { allowedHosts: [target.hostname], maxResponseBytes: 1024 * 1024, maxRedirects: 3 })
    if (!response.ok) return json({ error: `Website returned HTTP ${response.status}` }, 400)
    const content = await readBoundedResponse(response, 1024 * 1024)
    return json({ url: target.href, content, size: new TextEncoder().encode(content).byteLength })
  }
  if (request.method === 'GET' && path[1] === 'projects' && path[2] === 'default-directory') {
    const name = url.searchParams.get('projectName')?.trim() || 'project'
    const directory = join(projectsRoot, 'projects', name.toLocaleLowerCase().replace(/[^a-z0-9]+/g, '-'))
    return json({ directory })
  }
  if (request.method === 'GET' && path[1] === 'projects' && path[2] === 'directories') {
    const requested = url.searchParams.get('path')
    const currentPath = requested ? safeProjectPath(requested) : canonicalProjectPath(projectsRoot)
    try {
      const client = await applicationDatabase()
      const ownedRoots = (await createProjectSessionRepository(client).listProjects(authenticatedUser!.id))
        .map((project) => canonicalProjectPath(project.path))
      if (currentPath !== canonicalProjectPath(projectsRoot) && !ownedRoots.some((projectRoot) => isPathWithin(projectRoot, currentPath))) {
        return json({ error: 'Project path is not owned by the authenticated user' }, 403)
      }
      const directories = readdirSync(currentPath, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
        .map((entry) => ({ name: entry.name, path: join(currentPath, entry.name) }))
      return json({ currentPath, directories })
    } catch (error) {
      console.warn(`Directory listing failed: ${redactedDiagnostic(error)}`)
      return json({ error: 'Unable to list project directories' }, 400)
    }
  }
  if (request.method === 'GET' && path[1] === 'projects' && path[2] === 'general-chat') {
    const directory = generalChatProject().path
    return json({ repoId: 0, directory, relativePath: directory, files: {}, agents: [], automationsSkill: { path: '', exists: false, created: false } })
  }
  if (request.method === 'GET' && url.pathname === '/api/new-session/resolve') {
    const client = await applicationDatabase()
    const repository = createProjectSessionRepository(client)
    const ownedProjects = await repository.listProjects(authenticatedUser!.id)
    const projectCandidates = [
      { id: 0, ...generalChatProject() },
      ...ownedProjects.map((project, index) => ({
        id: index + 1,
        name: project.name,
        path: project.path,
        agentNames: project.agentNames,
        hasAgentOverride: project.hasAgentOverride,
      })),
    ]
    const agentCandidates = await listAgents(client, authenticatedUser!.id)
    try {
      const resolved = resolveNewSessionRoute({
        projectName: url.searchParams.get('projectName') ?? undefined,
        agentName: url.searchParams.get('agentName') ?? undefined,
        projects: projectCandidates,
        agents: agentCandidates,
      })
      const projectId = typeof resolved.project.id === 'number' ? resolved.project.id : 0
      return json({
        context: {
          project: projectResponse(resolved.project, projectId, projectId === 0),
          agent: { id: resolved.agent.id, name: resolved.agent.name, description: resolved.agent.description },
          defaults: { permission: 'ask' },
        },
      })
    } catch (error) {
      if (error instanceof NewSessionRouteError) {
        const status = error.code === 'NEW_SESSION_PROJECT_NOT_FOUND' || error.code === 'NEW_SESSION_AGENT_NOT_FOUND' ? 404 : 409
        return json({ error: error.message, code: error.code }, status)
      }
      throw error
    }
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
      console.warn(`Agent listing failed: ${redactedDiagnostic(error)}`)
      return json({ error: 'Agent store unavailable' }, 503)
    }
  }
  if (request.method === 'GET' && url.pathname === '/api/provider') {
    try {
      if (!authenticatedUser) return json({ all: [], connected: [], default: {} }, 401)
      return json(await runtimeProviders(authenticatedUser.id))
    } catch { return json({ all: [], connected: [], default: {} }) }
  }
  if (request.method === 'GET' && url.pathname === '/api/config') return json({ model: undefined, default_agent: 'master', default_permission: 'ask' })
  if (request.method === 'GET' && url.pathname === '/api/command') return json([])
  if (request.method === 'GET' && url.pathname === '/api/sessions/status') {
    const owned = await createProjectSessionRepository(await applicationDatabase()).listSessions(authenticatedUser!.id, { includeArchived: true })
    return json(Object.fromEntries(owned.map((session) => [session.id, { type: active.get(activeKey(authenticatedUser!.id, session.id))?.record.userId === authenticatedUser!.id ? 'busy' : 'idle' }])))
  }
  if (request.method === 'GET' && url.pathname === '/api/sse/stream') {
    if (gatewayCredential) {
      const denied = (() => { try { assertGatewayAccess(gatewayCredential!, 'events', { ...(url.searchParams.get('sessionId') ? { sessionId: url.searchParams.get('sessionId')! } : {}) }); return null } catch (error) { return gatewayErrorResponse(error) } })()
      if (denied) return denied
    }
    const eventUserId = authenticatedUser?.id ?? gatewayCredential?.ownerId
    if (!eventUserId) return json({ error: { code: 'GATEWAY_OWNER_REQUIRED', message: 'An authenticated owner is required' } }, 401)
    const after = url.searchParams.get('after') ?? request.headers.get('last-event-id')
    const replay = eventCursor.replay(eventUserId, after)
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
          userId: eventUserId,
          enqueue: (chunk) => {
            if (closed) return
            try { controller.enqueue(chunk) } catch { close() }
          },
          close,
        }
        if (replay.reset) {
          client.enqueue(encoder.encode(`event: cursor.reset\nid: ${replay.resetCursor ?? 0}\ndata: ${JSON.stringify({ cursor: replay.resetCursor ?? 0, reason: 'retention' })}\n\n`))
        }
        for (const event of replay.events) {
          client.enqueue(encoder.encode(`id: ${event.id}\ndata: ${JSON.stringify(event.payload)}\n\n`))
        }
        sseClients.add(client)
        const connected = [...active.values()].filter((session) => session.record.userId === eventUserId).length
        client.enqueue(encoder.encode(`event: connected\ndata: ${JSON.stringify({ clientId: 'pi-local', connected, total: connected })}\n\n`))
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
    const sessionId = typeof input.sessionId === 'string' ? input.sessionId.trim() : ''
    if (!sessionId) return json({ ok: false, decision: 'deny', message: 'An authenticated owned session is required' }, 401)
    try {
      const client = await applicationDatabase()
      const session = await createProjectSessionRepository(client).getSessionById(sessionId)
      // Internal Pi calls have no browser cookie, but ownership still comes
      // from the durable PocketBase session record, never from process-local
      // session state or a caller-supplied userId.
      if (!session || (authenticatedUser && session.userId !== authenticatedUser.id)) return json({ ok: false, decision: 'deny', message: 'Session not found' }, 404)
      const userId = session.userId
      const requestedOverride = requestedPermissionOverride(input.permissionOverride)
      if (requestedOverride === null) return json({ ok: false, decision: 'deny', message: 'Invalid permission override' }, 400)
      const context = await resolveToolSessionContext(client, userId, sessionId, typeof input.agentName === 'string' ? input.agentName : undefined)
      if (requestedOverride !== undefined && requestedOverride !== context.permissionOverride) {
        return json({ ok: false, decision: 'deny', message: 'Permission override does not match the persisted session policy' }, 403)
      }
      const result = await authorizePiToolCall(client, {
        userId,
        agentName: context.agentName,
        sessionId,
        toolName: typeof input.toolName === 'string' ? input.toolName : '',
        input: input.input ?? {},
        permissionOverride: context.permissionOverride,
      })
      if (result.decision !== 'approval') return json(result)

      broadcastSse({
        type: 'permission.asked',
        directory: typeof input.cwd === 'string' ? input.cwd : undefined,
          properties: permissionAskedProperties({ id: result.approvalId ?? '', sessionId, toolId: mapToolId(input.toolName), input: input.input ?? {}, reason: result.message ?? 'Tool approval required' }),
      }, userId)
      return json({ ok: false, decision: 'approval', approvalId: result.approvalId, message: result.message }, 202)
    } catch (error) {
      console.warn(`Tool authorization failed: ${redactedDiagnostic(error)}`)
      return json({ ok: false, decision: 'deny', message: 'Tool authorization failed' }, 503)
    }
  }

  if (path[1] === 'subpolar-cli' && path[2] === 'tools' && request.method === 'POST') {
    const input = await body(request)
    const userId = authenticatedUser?.id ?? gatewayCredential?.ownerId
      ?? (internalRequest && typeof input.userId === 'string' ? input.userId : undefined)
      ?? (internalRequest && path[3] === 'register' ? 'system' : undefined)
    if (!userId) return json({ error: 'A user identity is required' }, 401)
    try {
      const client = await applicationDatabase()
      if (userId !== 'system') await ensureUserMetadata(userId)
      const agentName = typeof input.agentName === 'string' ? input.agentName : 'master'

      if (path[3] === 'register') {
        if (gatewayCredential) assertGatewayAccess(gatewayCredential, 'add', { agentName, ...(typeof input.projectId === 'string' ? { projectId: input.projectId } : {}) })
        else if (!internalRequest) return json({ error: { code: 'GATEWAY_PERMISSION_DENIED', message: 'Tool registration requires an authorized gateway credential' } }, 403)
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

      if (path[3] === 'list') {
        if (gatewayCredential) assertGatewayAccess(gatewayCredential, 'list', { agentName })
        return json({ tools: await listToolsForAgent(client, userId, agentName) })
      }
      if (path[3] === 'search') {
        if (gatewayCredential) assertGatewayAccess(gatewayCredential, 'query', { agentName })
        if (typeof input.query !== 'string' || !input.query.trim()) return json({ error: 'A non-empty query is required' }, 400)
        const tools = await searchToolsForAgent(client, userId, agentName, input.query)
        return json({ tools, columns: ['tool', 'description', 'usage'] })
      }
      if (path[3] === 'describe' && typeof input.toolId === 'string') {
        if (gatewayCredential) assertGatewayAccess(gatewayCredential, 'describe', { agentName })
        return json({ tool: await describeToolForAgent(client, userId, agentName, input.toolId) })
      }
      if (path[3] === 'call' && typeof input.toolId === 'string') {
        const sessionId = typeof input.sessionId === 'string' && input.sessionId.trim() ? input.sessionId : undefined
        if (gatewayCredential) assertGatewayAccess(gatewayCredential, 'call', { agentName, ...(sessionId ? { sessionId } : {}) })
        if (!sessionId || userId === 'system') return json({ error: 'A valid sessionId is required for tool execution' }, 400)
        const persistedSession = await createProjectSessionRepository(client).getSessionById(sessionId)
        if (!persistedSession || persistedSession.userId !== userId) return json({ error: 'Session not found' }, 404)
        if (gatewayCredential) assertGatewayAccess(gatewayCredential, 'call', { agentName, sessionId, ...(persistedSession.projectId ? { projectId: persistedSession.projectId } : {}) })
        const executionUserId = persistedSession.userId
        if (authenticatedUser && authenticatedUser.id !== executionUserId) return json({ error: 'Session not found' }, 404)
        if (typeof input.userId === 'string' && input.userId !== executionUserId) return json({ error: 'Identity assertion does not match the session owner' }, 403)
        const requestedOverride = requestedPermissionOverride(input.permissionOverride)
        if (requestedOverride === null) return json({ error: 'Invalid permission override' }, 400)
        const context = await resolveToolSessionContext(client, executionUserId, sessionId, typeof input.agentName === 'string' ? input.agentName : undefined)
        if (requestedOverride !== undefined && requestedOverride !== context.permissionOverride) return json({ error: 'Permission override does not match the persisted session policy' }, 403)
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
                properties: permissionAskedProperties({ id: approval.id, sessionId: approval.session_id, toolId: approval.tool_id, input: approval.input, reason: approval.reason }),
              }, context.identity.userId)
            },
          },
        )
         return json(redactSensitive(result), result.ok || !('approvalRequired' in result) ? 200 : 202)
      }
      if (path[3] === 'continue' && typeof input.approvalId === 'string') {
        if (gatewayCredential) assertGatewayAccess(gatewayCredential, 'approvals', { ...(typeof input.sessionId === 'string' ? { sessionId: input.sessionId } : {}) })
        if (userId === 'system') return json({ error: 'An authenticated user is required' }, 401)
        const sessionId = typeof input.sessionId === 'string' ? input.sessionId : undefined
        const session = sessionId ? await createProjectSessionRepository(client).getSessionById(sessionId) : null
        if (session && session.userId !== userId) return json({ error: 'Session not found' }, 404)
        if (!sessionId || !session) return json({ error: 'An owned session is required' }, 404)
        const result = await continueApprovedTool(client, session.userId, input.approvalId, { sessionId: session.id, cwd: session.directory, callId: typeof input.callId === 'string' ? input.callId : crypto.randomUUID() })
         return json(redactSensitive(result), 'approvalRequired' in result && result.approvalRequired ? 202 : 200)
      }
      return json({ error: 'Unknown tool gateway operation' }, 404)
    } catch (error) {
      if (error instanceof GatewayAuthError) return json({ error: { code: error.code, message: error.message } }, error.code === 'GATEWAY_PERMISSION_DENIED' || error.code === 'GATEWAY_SCOPE_DENIED' ? 403 : 401)
      console.warn(`Tool gateway request failed: ${redactedDiagnostic(error)}`)
      return json({ error: 'Tool gateway unavailable' }, 503)
    }
  }

  if (path[1] === 'question' && request.method === 'GET') {
    // Questions are delivered through the session SSE stream. Keep the
    // legacy polling endpoint for clients that use it during startup.
    return json([])
  }

  if (path[1] === 'permission' && request.method === 'GET') {
    if (gatewayCredential) {
      const denied = (() => { try { assertGatewayAccess(gatewayCredential!, 'approvals', { ...(url.searchParams.get('sessionId') ? { sessionId: url.searchParams.get('sessionId')! } : {}) }); return null } catch (error) { return gatewayErrorResponse(error) } })()
      if (denied) return denied
    }
    const permissionUserId = authenticatedUser?.id ?? gatewayCredential?.ownerId
    if (!permissionUserId) return json({ message: 'Unauthorized' }, 401)
    try {
      const approvals = await listPendingApprovals(await applicationDatabase(), permissionUserId, url.searchParams.get('sessionId') ?? undefined)
      return json(approvals.map((approval) => permissionAskedProperties({ id: approval.id, sessionId: approval.session_id, toolId: approval.tool_id, input: approval.input, reason: approval.reason })))
    } catch (error) { console.warn(`Approval store request failed: ${redactedDiagnostic(error)}`); return json({ message: 'Approval store unavailable' }, 503) }
  }

  if (path[1] === 'session' && path[3] === 'permissions' && path[4] && request.method === 'POST') {
    if (gatewayCredential) {
      const denied = gatewayErrorResponse((() => { try { assertGatewayAccess(gatewayCredential!, 'approvals', { sessionId: decodeURIComponent(path[2] ?? '') }); return null } catch (error) { return error } })())
      if (denied) return denied
    }
    const permissionUserId = authenticatedUser?.id ?? gatewayCredential?.ownerId
    if (!permissionUserId) return json({ message: 'Unauthorized' }, 401)
    const input = await body(request)
    const responseValue = input.response
    if (responseValue !== 'approve' && responseValue !== 'approved' && responseValue !== 'once' && responseValue !== 'always' && responseValue !== 'reject' && responseValue !== 'rejected' && responseValue !== true && responseValue !== false) {
      return json({ message: 'Approval response must be approve or reject' }, 400)
    }
    const decision = responseValue === 'once' || responseValue === 'always' ? 'approve' : responseValue
    const approved = decision === true || decision === 'approve' || decision === 'approved'
    const sessionId = decodeURIComponent(path[2] ?? '')
    if (!sessionId) return json({ message: 'Session not found' }, 404)
    const client = await applicationDatabase()
    const approval = await respondToApproval(client, permissionUserId, decodeURIComponent(path[4]), decision, sessionId)
    if (!approval) return json({ message: 'Approval not found' }, 404)
    if (!approved) return json({ ok: true, approval })
    const session = await createProjectSessionRepository(client).getSession(permissionUserId, sessionId)
    if (!session) return json({ ok: true, approval, result: { ok: false, error: { code: 'SESSION_NOT_FOUND', message: 'Session not found' } } }, 404)
    const result = await continueApprovedTool(client, permissionUserId, approval.id, { sessionId: session.id, cwd: session.directory, callId: crypto.randomUUID() })
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
      console.warn(`Agent policy request failed: ${redactedDiagnostic(error)}`)
      return json({ message: 'Agent policy store unavailable' }, 503)
    }
  }

  // Settings are intentionally served by the local bridge as well as the full
  // server.  Keeping these routes here prevents a Vite/bridge-only install
  // from turning the settings page into a stream of 404s.
  if (path[1] === 'settings' && path.length === 2 && request.method === 'GET') {
    if (!authenticatedUser) return json({ message: 'Unauthorized' }, 401)
    try {
      const record = await getUserPreferences(await applicationDatabase(), authenticatedUser.id)
      const preferences = { ...DEFAULT_SETTINGS, ...(record?.preferences ?? {}) }
      if (preferences.tts) preferences.tts = { enabled: Boolean((preferences.tts as Record<string, unknown>).enabled), ...redactVoiceSettings(preferences.tts) }
      if (preferences.stt) preferences.stt = { enabled: Boolean((preferences.stt as Record<string, unknown>).enabled), ...redactVoiceSettings(preferences.stt) }
      return json({ preferences, updatedAt: record?.updated_at ?? Date.now() })
    } catch (error) { console.warn(`Settings read failed: ${redactedDiagnostic(error)}`); return json({ message: 'Settings store unavailable' }, 503) }
  }
  if (path[1] === 'settings' && path.length === 2 && request.method === 'PATCH') {
    if (!authenticatedUser) return json({ message: 'Unauthorized' }, 401)
    const input = await body(request)
       const preferences = object(input.preferences)
       if (preferences.tts && typeof preferences.tts === 'object') preferences.tts = { ...redactVoiceSettings(preferences.tts), apiKeyRef: typeof (preferences.tts as Record<string, unknown>).apiKeyRef === 'string' ? (preferences.tts as Record<string, unknown>).apiKeyRef : undefined }
       if (preferences.stt && typeof preferences.stt === 'object') preferences.stt = { ...redactVoiceSettings(preferences.stt), apiKeyRef: typeof (preferences.stt as Record<string, unknown>).apiKeyRef === 'string' ? (preferences.stt as Record<string, unknown>).apiKeyRef : undefined }
       try {
         const client = await applicationDatabase()
         const existing = await getUserPreferences(client, authenticatedUser.id)
         const existingPreferences = { ...(existing?.preferences ?? {}) }
         if (existingPreferences.tts) existingPreferences.tts = redactVoiceSettings(existingPreferences.tts)
         if (existingPreferences.stt) existingPreferences.stt = redactVoiceSettings(existingPreferences.stt)
         const saved = await saveUserPreferences(client, authenticatedUser.id, { ...DEFAULT_SETTINGS, ...existingPreferences, ...preferences })
       const safePreferences = { ...(saved.preferences ?? {}) }
       if (safePreferences.tts) safePreferences.tts = { enabled: Boolean((safePreferences.tts as Record<string, unknown>).enabled), ...redactVoiceSettings(safePreferences.tts) }
       if (safePreferences.stt) safePreferences.stt = { enabled: Boolean((safePreferences.stt as Record<string, unknown>).enabled), ...redactVoiceSettings(safePreferences.stt) }
       return json({ preferences: safePreferences, updatedAt: saved.updated_at ?? Date.now() })
    } catch (error) { console.warn(`Settings update failed: ${redactedDiagnostic(error)}`); return json({ message: 'Settings store unavailable' }, 503) }
  }
  if (path[1] === 'settings' && path.length === 2 && request.method === 'DELETE') {
    if (!authenticatedUser) return json({ message: 'Unauthorized' }, 401)
    try {
      const client = await applicationDatabase()
      const existing = await getUserPreferences(client, authenticatedUser.id)
      if (existing) await client.collection('user_preferences').delete(existing.id)
      return json({ preferences: DEFAULT_SETTINGS, updatedAt: Date.now() })
    } catch (error) { console.warn(`Settings reset failed: ${redactedDiagnostic(error)}`); return json({ message: 'Settings store unavailable' }, 503) }
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
    const requestedDirectory = url.searchParams.get('directory')
    let directory: string | undefined
    const repoId = url.searchParams.get('repoId')
    if (requestedDirectory) {
      try { directory = safeProjectPath(requestedDirectory) } catch { return json({ error: 'Project not found' }, 404) }
      const ownedPaths = (await createProjectSessionRepository(await applicationDatabase()).listProjects(authenticatedUser!.id)).flatMap((project) => {
        try { return [safeProjectPath(project.path)] } catch { return [] }
      })
      if (!ownedPaths.includes(directory) && directory !== safeProjectPath(generalChatRoot)) return json({ error: 'Project not found' }, 404)
    }
    try {
      const skills = readSkills(directory).filter((skill) => !repoId || String(skill.repoId ?? '') === repoId)
      return json(skills)
    } catch {
      return json({ error: 'Project skill path is outside the configured workspace' }, 400)
    }
  }
  if (path[1] === 'settings' && path[2] === 'skills' && request.method === 'POST') {
    const input = await body(request)
    if (typeof input.name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.name)) return json({ error: 'Valid skill name is required' }, 400)
    const scope = input.scope === 'project' ? 'project' : 'global'
    let base = join(homedir(), '.config', 'subpolar', 'skills')
    let projectDirectory: string | undefined
    if (scope === 'project') {
      try { projectDirectory = safeProjectPath(typeof input.directory === 'string' ? input.directory : generalChatRoot) } catch { return json({ error: 'Project not found' }, 404) }
      const owned = (await createProjectSessionRepository(await applicationDatabase()).listProjects(authenticatedUser!.id)).some((project) => {
        try { return safeProjectPath(project.path) === projectDirectory } catch { return false }
      })
      if (!owned && projectDirectory !== safeProjectPath(generalChatRoot)) return json({ error: 'Project not found' }, 404)
    }
    let file: string
    try {
      if (scope === 'project') {
        base = assertPathWithinWorkspace(base, projectsRoot)
        file = assertPathWithinWorkspace(join(base, input.name, 'SKILL.md'), projectsRoot)
      } else {
        file = join(base, input.name, 'SKILL.md')
      }
      mkdirSync(dirname(file), { recursive: true })
      if (scope === 'project') file = assertPathWithinWorkspace(file, projectsRoot)
      writeFileSync(file, `# ${input.name}\n\n${typeof input.description === 'string' ? input.description : ''}\n\n${typeof input.body === 'string' ? input.body : ''}\n`, 'utf8')
      const saved = readSkills(scope === 'project' ? projectDirectory : undefined).find((skill) => skill.name === input.name)
      return json(saved ?? { name: input.name, scope, body: input.body ?? '' }, 201)
    } catch {
      return json({ error: 'Project skill path is outside the configured workspace' }, 400)
    }
  }

  if (path[1] === 'sessions' && path.length === 2 && request.method === 'GET') {
    const client = await applicationDatabase()
    const requestedCursor = url.searchParams.get('cursor')
    const cursor = requestedCursor ? decodeSessionCursor(requestedCursor) : null
    if (requestedCursor && !cursor) return json({ error: 'Invalid session cursor' }, 400)
    const project = cursor?.project ?? url.searchParams.get('project') ?? undefined
    const requestedDirectory = cursor?.directory ?? url.searchParams.get('directory') ?? undefined
    const search = (cursor?.search ?? url.searchParams.get('search')?.trim().toLocaleLowerCase() ?? '').slice(0, SESSION_SEARCH_MAX_LENGTH)
    const order = cursor?.order ?? (url.searchParams.get('order') === 'asc' ? 'asc' : 'desc')
    const limit = cursor ? sessionPageLimit(String(cursor.limit)) : sessionPageLimit(url.searchParams.get('limit'))
    const repository = createProjectSessionRepository(client)
    const userProjects = await repository.listProjects(authenticatedUser!.id)
    const owned = await repository.listSessions(authenticatedUser!.id, { project, includeArchived: true })
    const records = owned.map((session) => {
      const local = sessions.find((item) => item.id === session.id && item.userId === authenticatedUser!.id)
      const record = localSessionRecord(session)
      if (local) Object.assign(local, record)
      return record
    }).filter((session) => {
      if (!requestedDirectory) return true
      const project = session.project === 'General Chat' ? generalChatProject() : userProjects.find((candidate) => candidate.name === session.project)
      return (session.directory ?? project?.path) === resolve(requestedDirectory)
    }).map((record) => storedSessionResponse(record, userProjects)).filter((session) => {
      if (!search) return true
      return [session.id, session.title, session.project, session.directory].some((value) => String(value ?? '').toLocaleLowerCase().includes(search))
    }).sort((a, b) => {
      const updated = a.updatedAt - b.updatedAt
      if (updated !== 0) return order === 'asc' ? updated : -updated
      const id = a.id.localeCompare(b.id)
      return order === 'asc' ? id : -id
    })
    const start = cursor
      ? records.findIndex((session) => order === 'asc'
        ? session.updatedAt > cursor.updatedAt || (session.updatedAt === cursor.updatedAt && session.id > cursor.id)
        : session.updatedAt < cursor.updatedAt || (session.updatedAt === cursor.updatedAt && session.id < cursor.id))
      : 0
    const pageItems = records.slice(start < 0 ? records.length : start, (start < 0 ? records.length : start) + limit)
    const last = pageItems[pageItems.length - 1]
    const nextCursor = last && (start < 0 ? 0 : start) + pageItems.length < records.length
      ? encodeSessionCursor({ updatedAt: last.updatedAt, id: last.id, order, limit, search, ...(project ? { project } : {}), ...(requestedDirectory ? { directory: requestedDirectory } : {}) })
      : undefined
    return json({
      sessions: pageItems,
      ...(nextCursor ? { nextCursor } : {}),
      page: { limit, order, hasNext: Boolean(nextCursor), ...(nextCursor ? { nextCursor } : {}) },
    })
  }

  if (path[1] === 'sessions' && path.length === 2 && request.method === 'POST') {
    const input = await body(request)
    const client = await applicationDatabase()
    const repository = createProjectSessionRepository(client)
    const ownedProjects = await repository.listProjects(authenticatedUser!.id)
    const agentCandidates = await listAgents(client, authenticatedUser!.id)
    const requestedProjectId = typeof input.project === 'number'
      ? input.project
      : typeof input.project === 'string' && /^\d+$/.test(input.project) ? Number(input.project) : undefined
    const requestedProjectName = typeof input.project === 'string' && !/^\d+$/.test(input.project) ? input.project : undefined
    const selectedProject = requestedProjectId !== undefined
      ? requestedProjectId === 0 ? generalChatProject() : ownedProjects[requestedProjectId - 1]
      : requestedProjectName
        ? requestedProjectName === 'General Chat' ? generalChatProject() : ownedProjects.find((item) => item.name === requestedProjectName)
        : typeof input.directory === 'string'
          ? ownedProjects.find((item) => resolve(item.path) === resolve(input.directory as string)) ?? generalChatProject()
          : generalChatProject()
    if (!selectedProject) return json({ error: 'Project not found', code: 'NEW_SESSION_PROJECT_NOT_FOUND' }, 404)
    const projectCandidates = [
      { id: 0, ...generalChatProject() },
      ...ownedProjects.map((item, index) => ({
        id: index + 1,
        name: item.name,
        path: item.path,
        agentNames: item.agentNames,
        hasAgentOverride: item.hasAgentOverride,
      })),
    ]
    const resolved = (() => {
      try {
        return resolveNewSessionRoute({
          projectName: selectedProject.name,
          agentName: typeof input.agent === 'string' ? input.agent : undefined,
          projects: projectCandidates,
          agents: agentCandidates,
        })
      } catch (error) {
        if (error instanceof NewSessionRouteError) return error
        throw error
      }
    })()
    if (resolved instanceof NewSessionRouteError) {
      const status = resolved.code === 'NEW_SESSION_PROJECT_NOT_FOUND' || resolved.code === 'NEW_SESSION_AGENT_NOT_FOUND' ? 404 : 409
      return json({ error: resolved.message, code: resolved.code }, status)
    }
    const project: Project = resolved.project
    const thinking = input.thinking === undefined ? undefined
      : input.thinking === 'off' || input.thinking === 'minimal' || input.thinking === 'low' || input.thinking === 'medium' || input.thinking === 'high' || input.thinking === 'xhigh'
        ? input.thinking
        : null
    if (thinking === null) return json({ error: 'Invalid thinking level', code: 'NEW_SESSION_INVALID_THINKING' }, 400)
    const requestedPermission = input.permission === undefined ? 'ask'
      : input.permission === 'ask' || input.permission === 'none' || input.permission === 'allow_all' ? input.permission : null
    if (requestedPermission === null) return json({ error: 'Invalid permission override', code: 'NEW_SESSION_INVALID_PERMISSION' }, 400)
    const requestedModel = typeof input.model === 'string' && input.model.trim() ? input.model.trim() : undefined
    const model = requestedModel && thinking && !requestedModel.endsWith(`:${thinking}`) ? `${requestedModel}:${thinking}` : requestedModel
    const selectedModel = modelSelection(model)
    try {
      await validateModelSelection(authenticatedUser!.id, selectedModel)
    } catch (error) {
      if (error instanceof ModelUnavailableError) return json({ error: error.message, code: error.code }, 409)
      throw error
    }
    const now = Date.now()
    const id = crypto.randomUUID()
    const directory = project.name === 'General Chat' ? sessionWorkspace(id) : project.path
    mkdirSync(directory, { recursive: true })
    await ensureUserMetadata(authenticatedUser!.id)
    const stored = await createProjectSessionRepository(client).createSession(authenticatedUser!.id, {
      id,
      project: project.name,
      ...(typeof project.id === 'string' ? { projectId: project.id } : {}),
      title: typeof input.title === 'string' && input.title.trim() ? input.title.trim() : 'Untitled session',
      createdAt: now,
      updatedAt: now,
      directory,
      profile: resolved.agent.name,
      ...(selectedModel ? { model: selectedModel.value } : {}),
      permissionOverride: requestedPermission,
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
    rpcSession(record.id, record.userId!, record, project, record.profile ?? 'master', record.permissionOverride ?? 'ask')
    return json({ session: storedSessionResponse(record, ownedProjects) }, 201)
  }

  if (path[1] === 'sessions' && path.length >= 3) {
    const id = decodeURIComponent(path[2] ?? '')
    try {
      const ownershipClient = await applicationDatabase()
      const ownedRecord = internalRequest
        ? await ownedSessionRecord(ownershipClient, (await createProjectSessionRepository(ownershipClient).getSessionById(id))?.userId ?? '', id)
        : await ownedSessionRecord(ownershipClient, authenticatedUser!.id, id)
      if (!ownedRecord) return json({ error: 'Session not found' }, 404)
      const ownerId = ownedRecord.userId
      if (!ownerId) return json({ error: 'Session not found' }, 404)
      if (path.length === 3 && request.method === 'GET') return json(storedSessionResponse(ownedRecord, await createProjectSessionRepository(ownershipClient).listProjects(ownerId)))
      if (path.length === 3 && request.method === 'PATCH') {
        const input = await body(request)
        const title = typeof input.title === 'string' ? input.title.trim() : ''
        const client = ownershipClient
        const record = ownedRecord
        if (title) {
          await sendRpc(id, { type: 'set_session_name', name: title }, ownedRecord)
          record.title = title
        }
        if (typeof input.archived === 'boolean') record.archived = input.archived
        const updated = await createProjectSessionRepository(client).updateSession(ownerId, id, {
          ...(title ? { title } : {}),
          ...(typeof input.archived === 'boolean' ? { archived: input.archived } : {}),
        })
        if (updated) {
          record.updatedAt = updated.updatedAt
          record.title = updated.title
        }
        await saveState()
        return json({ session: storedSessionResponse(record, await createProjectSessionRepository(client).listProjects(ownerId)) })
      }
      if (path.length === 3 && request.method === 'DELETE') {
        const client = ownershipClient
        await createProjectSessionRepository(client).deleteSession(ownerId, id)
        active.get(activeKey(ownerId, id))?.close()
        active.delete(activeKey(ownerId, id))
        sessions = sessions.filter((session) => session.id !== id || session.userId !== ownerId)
        await saveState()
        return json({ ok: true })
      }
      if (path.length === 4 && path[3] === 'messages' && request.method === 'GET') {
        const record = ownedRecord
        const history = await transcriptHistory(id, record)
        return json({ messages: history.messages })
      }
      if (path.length === 5 && path[3] === 'tool-calls' && request.method === 'GET') {
        const callID = decodeURIComponent(path[4] ?? '')
        const payload = entriesPayload(await sendRpc(id, { type: 'get_entries' }, ownedRecord))
        for (const entry of payload.entries) {
          const message = object(object(entry).message)
          if (message.role === 'toolResult' && message.toolCallId === callID) {
            return json({ callID, tool: message.toolName ?? null, input: redactSensitive(object(message.input)), output: redactSensitiveText(sessionMessageText(message)), details: redactSensitive(object(message.details)), error: message.isError ? redactSensitiveText(sessionMessageText(message)) : null })
          }
        }
        return json({ callID, output: '', details: {}, error: null }, 404)
      }
      if (path.length === 4 && path[3] === 'messages' && request.method === 'POST') {
        const input = await body(request)
        const metadata = object(input.metadata)
        const record = ownedRecord
        const content = typeof input.content === 'string' ? input.content : ''
        const ownerId = record.userId
        if (!ownerId) return json({ error: 'Session owner is unavailable' }, 400)
        const requestedAgent = typeof metadata.agent === 'string' && metadata.agent.trim() ? metadata.agent.trim() : undefined
        const requestedPermission = requestedMetadataPermission(metadata)
        if (requestedPermission === null) return json({ error: 'Invalid permission override' }, 400)
        let context
        try {
          context = await resolveToolSessionContext(ownershipClient, ownerId, id, requestedAgent, requestedPermission)
        } catch (error) {
          const failure = sessionContextFailure(error)
          if (failure) return failure
          throw error
        }
        const requestedMessageID = messageDeliveryId(input.messageID)
        const messageID = requestedMessageID ?? crypto.randomUUID()
        let reservation: ReturnType<typeof reserveMessageDelivery>
        try {
          reservation = reserveMessageDelivery(database, ownerId, id, messageID, content, metadata)
        } catch (error) {
          if (error instanceof MessageDeliveryConflictError) return json({ error: error.message, code: error.code }, 409)
          throw error
        }
        if (!reservation.created) return json(replayMessageDeliveryResponse(reservation.delivery), 200)
        const updated = await createProjectSessionRepository(ownershipClient).updateSession(ownerId, id, {
          profile: context.agentName,
          ...(requestedPermission === undefined ? {} : { permissionOverride: context.permissionOverride }),
        })
        if (!updated) throw new Error('Session was not found')
        record.profile = context.agentName
        record.permissionOverride = updated.permissionOverride
        await saveState()
        return json(messageDeliveryResponse(reservation.delivery), 201)
      }
      if (path.length === 4 && path[3] === 'steer' && request.method === 'POST') {
        const input = await body(request)
        const content = typeof input.content === 'string' ? input.content.trim() : typeof input.message === 'string' ? input.message.trim() : ''
        if (!content) return json({ error: 'Steering content is required' }, 400)
        const clientId = queueClientId(input.clientId ?? input.messageID)
        let reservation
        try { reservation = reserveQueueEntry(database, ownerId, id, clientId, content, 'steering') }
        catch (error) {
          if (error instanceof QueueEntryConflictError) return json({ error: error.message, code: error.code }, 409)
          throw error
        }
        if (!reservation.created) return json({ entry: reservation.entry }, 200)
        try {
          await sendRpc(id, { type: 'steer', message: content, id: clientId }, ownedRecord)
          const entry = updateQueueEntry(database, ownerId, id, clientId, 'delivered')
          broadcastSse({ type: 'message.queue.updated', properties: { sessionID: id } }, ownerId)
          return json({ entry }, 201)
        } catch (error) {
          const entry = updateQueueEntry(database, ownerId, id, clientId, 'failed', error instanceof Error ? error.message : 'Steering failed')
          broadcastSse({ type: 'message.queue.updated', properties: { sessionID: id } }, ownerId)
          return json({ entry }, 200)
        }
      }
      if (path.length === 4 && path[3] === 'queue' && request.method === 'GET') {
        return json({ entries: listQueueEntries(database, ownerId, id) })
      }
      if (path.length === 4 && path[3] === 'queue' && request.method === 'POST') {
        const input = await body(request)
        const content = typeof input.content === 'string' ? input.content.trim() : typeof input.message === 'string' ? input.message.trim() : ''
        if (!content) return json({ error: 'Queue content is required' }, 400)
        const clientId = queueClientId(input.clientId ?? input.messageID)
        let reservation
        try { reservation = reserveQueueEntry(database, ownerId, id, clientId, content, 'follow_up') }
        catch (error) {
          if (error instanceof QueueEntryConflictError) return json({ error: error.message, code: error.code }, 409)
          throw error
        }
        broadcastSse({ type: 'message.queue.updated', properties: { sessionID: id } }, ownerId)
        return json({ entry: reservation.entry }, reservation.created ? 201 : 200)
      }
      if (path.length === 5 && path[3] === 'queue') {
        const clientId = decodeURIComponent(path[4] ?? '')
        if (clientId === 'clear' && request.method === 'POST') {
          clearQueue(database, ownerId, id)
          broadcastSse({ type: 'message.queue.updated', properties: { sessionID: id } }, ownerId)
          return json({ entries: listQueueEntries(database, ownerId, id) })
        }
        if (request.method === 'DELETE') {
          let entry
          try { entry = updateQueueEntry(database, ownerId, id, clientId, 'cancelled') }
          catch (error) {
            if (error instanceof QueueEntryTransitionError) return json({ error: error.message, code: error.code }, 409)
            throw error
          }
          broadcastSse({ type: 'message.queue.updated', properties: { sessionID: id } }, ownerId)
          return entry ? json({ entry }) : json({ error: 'Queue entry not found' }, 404)
        }
        if (request.method === 'POST') {
          let entry
          try { entry = updateQueueEntry(database, ownerId, id, clientId, 'enqueued') }
          catch (error) {
            if (error instanceof QueueEntryTransitionError) return json({ error: error.message, code: error.code }, 409)
            throw error
          }
          if (entry?.kind === 'steering') {
            try {
              entry = updateQueueEntry(database, ownerId, id, clientId, 'steering')
              if (!entry) return json({ error: 'Queue entry not found' }, 404)
              await sendRpc(id, { type: 'steer', message: entry.content, id: entry.clientId }, ownedRecord)
              entry = updateQueueEntry(database, ownerId, id, clientId, 'delivered')
            } catch (error) {
              entry = updateQueueEntry(database, ownerId, id, clientId, 'failed', error instanceof Error ? error.message : 'Steering failed')
            }
          }
          broadcastSse({ type: 'message.queue.updated', properties: { sessionID: id } }, ownerId)
          return entry ? json({ entry }) : json({ error: 'Queue entry not found' }, 404)
        }
        if (request.method === 'PATCH') {
          const input = await body(request)
          if (typeof input.position !== 'number' || !Number.isFinite(input.position)) return json({ error: 'Queue position is required' }, 400)
          const entry = reorderQueueEntry(database, ownerId, id, clientId, input.position)
          broadcastSse({ type: 'message.queue.updated', properties: { sessionID: id } }, ownerId)
          return entry ? json({ entry }) : json({ error: 'Queue entry not found' }, 404)
        }
      }
      if (path.length === 4 && path[3] === 'runs' && request.method === 'POST') {
        const input = await body(request)
        const ownerId = ownedRecord.userId ?? authenticatedUser!.id
        const requestedMessageID = messageDeliveryId(input.messageID)
        const delivery = requestedMessageID
          ? getMessageDelivery(ownerId, id, requestedMessageID)
          : getLatestMessageDelivery(ownerId, id)
        if (!delivery) return json({ error: 'Message delivery not found', code: 'MESSAGE_DELIVERY_NOT_FOUND' }, 409)
        if (!delivery.content.trim()) return json({ error: 'Prompt content is required' }, 400)
        if (delivery.state !== 'pending') return json(replayMessageDeliveryResponse(delivery), 200)
        const claimedDelivery = claimMessageDelivery(delivery)
        if (!claimedDelivery) {
          const current = getMessageDelivery(ownerId, id, delivery.messageId)
          return current ? json(messageDeliveryResponse(current), 200) : json({ error: 'Message delivery not found', code: 'MESSAGE_DELIVERY_NOT_FOUND' }, 409)
        }
        try {
          const metadata = JSON.parse(claimedDelivery.metadata) as Record<string, unknown>
          const selectedModel = modelSelection(metadata.model)
          if (selectedModel) {
            await sendRpc(id, { type: 'set_model', provider: selectedModel.providerID, modelId: selectedModel.modelID }, ownedRecord)
            await persistSessionModel(ownershipClient, ownerId, id, ownedRecord, selectedModel)
          }
          // The session runtime was selected from PocketBase when the Pi session
          // was created; filesystem `/profile` commands are intentionally gone.
          const response = await sendRpc(id, { type: 'prompt', message: claimedDelivery.content }, ownedRecord)
          completeMessageDelivery(claimedDelivery, response)
          return json(withDeliveryMetadata(response, messageDeliveryResponse({ ...claimedDelivery, state: 'completed' })))
        } catch (error) {
          interruptMessageDelivery(claimedDelivery)
          console.warn(`Message delivery interrupted: ${redactedDiagnostic(error)}`)
          return json(messageDeliveryResponse({ ...claimedDelivery, state: 'interrupted' }), 200)
        }
      }
      if (path.length === 4 && path[3] === 'state' && request.method === 'GET') return json(rpcData(await sendRpc(id, { type: 'get_state' }, ownedRecord)))
      if (path.length === 4 && path[3] === 'stats' && request.method === 'GET') return json(rpcData(await sendRpc(id, { type: 'get_session_stats' }, ownedRecord)))
      if (path.length === 4 && path[3] === 'rpc' && request.method === 'POST') {
        const input = await body(request)
        if (typeof input.type !== 'string') return json({ error: 'RPC type is required' }, 400)
        return json(await sendRpc(id, input as RpcCommand, ownedRecord))
      }
      if (path.length === 4 && path[3] === 'prompt' && request.method === 'POST') {
        const input = await body(request)
        if (typeof input.message !== 'string' || !input.message.trim()) return json({ error: 'Prompt message is required' }, 400)
        return json(await sendRpc(id, { type: 'prompt', message: input.message, ...(typeof input.streamingBehavior === 'string' ? { streamingBehavior: input.streamingBehavior } : {}) }, ownedRecord))
      }
      if (path.length === 4 && path[3] === 'abort' && request.method === 'POST') return json(await sendRpc(id, { type: 'abort' }, ownedRecord))
      return json({ error: 'Not found' }, 404)
    } catch (error) {
      console.warn(`Session request failed: ${redactedDiagnostic(error)}`)
      return json({ error: 'Session request failed' }, 400)
    }
  }

  if (path[1] === 'extensions' && path[2] === 'projects') {
    const client = await applicationDatabase()
    if (request.method === 'GET') return json({ projects: await ownedProjectResponses(authenticatedUser!.id, client) })
    if (request.method === 'POST') {
      const input = await body(request)
      if (typeof input.sessionId !== 'string' || typeof input.project !== 'string') return json({ error: 'sessionId and project are required' }, 400)
      const session = await ownedSessionRecord(client, authenticatedUser!.id, input.sessionId)
      if (!session) return json({ error: 'Session not found' }, 404)
      if (input.project !== 'General Chat' && !(await createProjectSessionRepository(client).findProjectByName(authenticatedUser!.id, input.project))) return json({ error: 'Project not found' }, 404)
      return json(await sendRpc(input.sessionId, { type: 'prompt', message: `/project ${input.project}` }, session))
    }
  }

  if (path[1] === 'extensions' && (path[2] === 'profiles' || path[2] === 'agent-profiles') && request.method === 'GET') {
    try {
      const agents = await listAgents(await applicationDatabase(), authenticatedUser!.id)
      return json({ profiles: Object.fromEntries(agents.map((agent) => [agent.name, { systemPrompt: agent.system_prompt, tools: [] }])) })
    } catch (error) {
      console.warn(`Agent profile request failed: ${redactedDiagnostic(error)}`)
      return json({ error: 'Agent store unavailable' }, 503)
    }
  }

  if (path[1] === 'extensions' && (path[2] === 'profiles' || path[2] === 'agent-profiles') && path[3] === 'activate' && request.method === 'POST') {
    const input = await body(request)
    if (typeof input.sessionId !== 'string' || typeof input.profile !== 'string' || !input.profile.trim()) return json({ error: 'sessionId and profile are required' }, 400)
    const client = await applicationDatabase()
    const session = await ownedSessionRecord(client, authenticatedUser!.id, input.sessionId)
    if (!session) return json({ error: 'Session not found' }, 404)
    const requestedPermission = requestedMetadataPermission(input)
    if (requestedPermission === null) return json({ error: 'Invalid permission override' }, 400)
    let context
    try {
      context = await resolveToolSessionContext(client, authenticatedUser!.id, input.sessionId, input.profile.trim(), requestedPermission)
    } catch (error) {
      const failure = sessionContextFailure(error)
      if (failure) return failure
      throw error
    }
    const updated = await createProjectSessionRepository(client).updateSession(authenticatedUser!.id, input.sessionId, {
      profile: context.agentName,
      ...(requestedPermission === undefined ? {} : { permissionOverride: context.permissionOverride }),
    })
    if (!updated) return json({ error: 'Session not found' }, 404)
    session.profile = context.agentName
    session.permissionOverride = updated.permissionOverride
    await saveState()
    return json(await sendRpc(input.sessionId, { type: 'prompt', message: `/profile ${context.agentName}` }, session))
  }

  if (path[1] === 'extensions' && (path[2] === 'tools' || path[2] === 'list-tools') && request.method === 'GET') {
    if (!authenticatedUser) return json({ message: 'Unauthorized' }, 401)
    try {
      const client = await applicationDatabase()
      const sessionId = url.searchParams.get('sessionId')
      const session = sessionId ? await ownedSessionRecord(client, authenticatedUser.id, sessionId) : null
      if (sessionId && !session) return json({ message: 'Session not found' }, 404)
      const agentName = sessionId && session
        ? (await resolveToolSessionContext(client, authenticatedUser.id, sessionId)).agentName
        : 'master'
      const tools = await listToolsForAgent(client, authenticatedUser.id, agentName)
      return json({ tools, ...(sessionId && session ? { commands: await sendRpc(sessionId, { type: 'get_commands' }, session) } : {}) })
    } catch (error) { console.warn(`Tool registry request failed: ${redactedDiagnostic(error)}`); return json({ message: 'Tool registry unavailable' }, 503) }
  }

  if (path[1] === 'extensions' && path[2] === 'commands' && request.method === 'GET') {
    const sessionId = url.searchParams.get('sessionId')
    if (!sessionId) return json({ commands: [] })
    const session = await ownedSessionRecord(await applicationDatabase(), authenticatedUser!.id, sessionId)
    if (!session) return json({ error: 'Session not found' }, 404)
    return json(await sendRpc(sessionId, { type: 'get_commands' }, session))
  }

  if (path[1] === 'extensions' && path[2] === 'command' && path[3] && request.method === 'POST') {
    const input = await body(request)
    if (typeof input.sessionId !== 'string') return json({ error: 'sessionId is required' }, 400)
    const session = await ownedSessionRecord(await applicationDatabase(), authenticatedUser!.id, input.sessionId)
    if (!session) return json({ error: 'Session not found' }, 404)
    const args = typeof input.args === 'string' && input.args.trim() ? ` ${input.args.trim()}` : ''
    return json(await sendRpc(input.sessionId, { type: 'prompt', message: `/${decodeURIComponent(path[3])}${args}` }, session))
  }

  if (path[1] === 'extensions' && (path[2] === 'session-search' || path[2] === 'session-history-search') && request.method === 'GET') {
    const query = (url.searchParams.get('q') ?? '').toLocaleLowerCase().trim()
    if (!query) return json({ sessions: [] })
    const matches = []
    const ownedSessions = (await createProjectSessionRepository(await applicationDatabase()).listSessions(authenticatedUser!.id, { includeArchived: true }))
    for (const stored of ownedSessions) {
      const record = sessions.find((candidate) => candidate.id === stored.id && candidate.userId === authenticatedUser!.id) ?? {
        id: stored.id, project: stored.project, title: stored.title, createdAt: stored.createdAt, updatedAt: stored.updatedAt, userId: stored.userId,
      }
      try {
        const response = await sendRpc(record.id, { type: 'get_messages' }, record) as RpcMessage
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
    const ownedSessions = await createProjectSessionRepository(await applicationDatabase()).listSessions(authenticatedUser!.id, { includeArchived: true })
    for (const stored of ownedSessions) {
      const record = sessions.find((candidate) => candidate.id === stored.id && candidate.userId === authenticatedUser!.id) ?? {
        id: stored.id, project: stored.project, title: stored.title, createdAt: stored.createdAt, updatedAt: stored.updatedAt, userId: stored.userId,
      }
      try {
        const response = await sendRpc(record.id, { type: 'get_session_stats' }, record) as RpcMessage
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
      const record = sessionId ? await ownedSessionRecord(await applicationDatabase(), authenticatedUser!.id, sessionId) : null
      return json({ title: record?.title ?? null })
    }
    if (request.method === 'POST') {
      const input = await body(request)
      if (typeof input.sessionId !== 'string' || typeof input.title !== 'string' || !input.title.trim()) return json({ error: 'sessionId and title are required' }, 400)
      const owned = await ownedSessionRecord(await applicationDatabase(), authenticatedUser!.id, input.sessionId)
      if (!owned) return json({ error: 'Session not found' }, 404)
      const response = await sendRpc(input.sessionId, { type: 'set_session_name', name: input.title.trim() }, owned)
      const record = owned
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
  const id = requestId(request)
  const pathname = new URL(request.url).pathname
  if (origin && !isAllowedOrigin(request, { allowLoopbackDev: true })) {
    const response = pathname.startsWith('/api/v1/')
      ? context.json(errorEnvelope('ORIGIN_NOT_ALLOWED', 'Origin not allowed', undefined, id), 403)
      : context.json({ error: 'Origin not allowed', requestId: id }, 403)
    response.headers.set('x-request-id', id)
    return response
  }
  try {
    assertSafeBrowserMutation(request, { allowLoopbackDev: true })
    const mutation = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)
     const bucketName = pathname.includes('/auth/') ? 'auth' : mutation ? 'mutation' : 'read'
     const kind = bucketName === 'auth' ? REQUEST_LIMITS.auth : mutation ? REQUEST_LIMITS.mutation : REQUEST_LIMITS.read
     // Cookie headers are mutable and are not a client identity. Use the
     // authenticated PocketBase user when available; unauthenticated auth
     // attempts intentionally fall back to a route bucket.
     const rateUser = await authenticateRequest(request).catch(() => null)
     const rateKey = rateLimitKey(bucketName, pathname, rateUser?.id)
    const limited = requestRateLimiter.consume(rateKey, kind.limit, kind.windowMs)
    if (!limited.allowed) {
      const response = pathname.startsWith('/api/v1/')
        ? context.json(errorEnvelope('RATE_LIMITED', 'Too many requests', undefined, id), 429)
        : context.json({ error: 'Too many requests', requestId: id }, 429)
      response.headers.set('retry-after', String(Math.ceil(limited.retryAfterMs / 1000)))
      response.headers.set('x-request-id', id)
      return response
    }
      const response = pathname.startsWith('/proxy/')
        ? await handleProxy(request)
       : await handle(request, id)
    response.headers.set('x-request-id', id)
    response.headers.set('access-control-allow-methods', 'GET,POST,PATCH,DELETE,OPTIONS')
    response.headers.set('access-control-allow-headers', 'content-type, authorization, x-request-id')
    if (request.url.includes('/proxy/')) response.headers.set('access-control-allow-origin', '*')
    else if (origin) response.headers.set('access-control-allow-origin', origin)
    return response
  } catch (error) {
    const status = error instanceof RequestSecurityError ? error.status : 400
    if (!(error instanceof RequestSecurityError)) console.warn(`Unhandled bridge request failure: ${redactedDiagnostic(error)}`)
    const response = pathname.startsWith('/api/v1/')
      ? json(errorEnvelope(error instanceof RequestSecurityError ? error.code : 'REQUEST_FAILED', error instanceof RequestSecurityError ? error.message : 'Request failed', undefined, id), status)
      : json({ error: error instanceof RequestSecurityError ? error.message : 'Request failed', requestId: id }, status)
    response.headers.set('x-request-id', id)
    return response
  }
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
        const id = requestId(request)
        if (!isAllowedOrigin(request, { allowLoopbackDev: true })) {
          const response = json({ error: 'Origin not allowed', requestId: id }, 403)
          response.headers.set('x-request-id', id)
          return response
        }
        const user = await authenticateRequest(request)
        if (!user) return json({ message: 'Unauthorized' }, 401)
        const sessionId = decodeURIComponent(match[1] ?? '')
        const limited = requestRateLimiter.consume(rateLimitKey('websocket', url.pathname, user.id), REQUEST_LIMITS.read.limit, REQUEST_LIMITS.read.windowMs)
        if (!limited.allowed) {
          const response = json({ error: 'Too many requests', requestId: id }, 429)
          response.headers.set('retry-after', String(Math.ceil(limited.retryAfterMs / 1000)))
          response.headers.set('x-request-id', id)
          return response
        }
        const client = await applicationDatabase()
        const record = await ownedSessionRecord(client, user.id, sessionId)
        const project = record ? await ownedSessionProject(client, user.id, record) : null
        if (!record || !project) return json({ error: 'Session not found' }, 404)
        try {
          await resolveToolSessionContext(client, user.id, sessionId)
        } catch {
          return json({ error: 'Session agent is unavailable' }, 400)
        }
        if (server.upgrade(request, { data: { sessionId, userId: user.id, record, project } })) return undefined
        return json({ error: 'WebSocket upgrade failed' }, 400)
    }
    return app.fetch(request)
  },
  websocket: {
    open(socket) {
      try {
        const session = rpcSession(
          socket.data.sessionId,
          socket.data.userId,
          socket.data.record,
          socket.data.project,
          socket.data.record.profile ?? 'master',
          socket.data.record.permissionOverride ?? 'ask',
        )
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
      void handleSocketMessage(socket, raw, rpcSession(
        socket.data.sessionId,
        socket.data.userId,
        socket.data.record,
        socket.data.project,
        socket.data.record.profile ?? 'master',
        socket.data.record.permissionOverride ?? 'ask',
      ))
    },
  },
})

startAutomationScheduler()

void _server
