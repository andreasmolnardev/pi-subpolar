import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync, statSync } from 'node:fs'

import { homedir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { join, resolve } from 'node:path'
import {
  ModelRuntime,
  parseSessionEntries,
  SessionManager,
} from '@earendil-works/pi-coding-agent'
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent'


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

  ensureTaskCollections,
  TaskRepository,
  TaskControlError,

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
  createOwnerBoundSkillStore,
  PocketBaseRuntimeStore,
  PocketBaseProxyCredentialStore,
  hashProxySecret,
  proxyCredentialResponse,

} from './server/index.ts'
import { SkillConflictError, SkillNotFoundError, SkillValidationError } from '../packages/subpolar-contracts/src/index.ts'
import { createSkillContextAudit, effectiveAgentConfiguration } from './server/application/tools.ts'
import {
  NewSessionRouteError,
  resolveNewSessionRoute,
} from './server/application/new-session-route.ts'
import {
  routeSessionRequest,
  parseRoutingModelSelection,
  type SessionRoutingCandidate,
} from './server/application/session-routing.ts'
import {
  assertSafeBrowserMutation,
  isAllowedOrigin,
  InProcessRateLimiter,
  readJsonBody,
  requestId,
  REQUEST_LIMITS,
  RequestSecurityError,
  rateLimitKey,
} from './server/core/request-security.ts'
import { fetchWithNetworkPolicy, networkPolicyFromMetadata, readBoundedResponse } from './server/core/network-policy.ts'
import { redactSensitive, redactSensitiveText } from './server/core/security-redaction.ts'
import { handleVoiceRoute, localVoiceBackends, type VoiceBackends, redactVoiceSettings, VoiceAuthorizationError } from './server/voice/index.ts'
import { permissionAskedProperties } from './server/application/approval-event.ts'
import { escapeFilter } from './server/persistence/pocketbase.ts'
import { proposeTools, registerToolDraft } from './server/application/tools-teach.ts'
import { InvalidSessionTagsError, normalizeSessionTags } from './server/persistence/project-store.ts'
import { createSuggestionService, type SuggestionProvider } from './server/application/suggestions.ts'
import { createBridgeRequestHandler } from './server/bridge-request-handler.ts'

import {
  PiSdkSession,
  sessionMessageText,
  type PendingQueueReceipt,
  type PiSdkSessionHost,
  type Project,
  type RpcCommand,
  type RpcMessage,
  type SessionRecord,
} from './server/application/pi-sdk-session.ts'

import { assertPathWithinWorkspace, canonicalProjectPath, configuredWorkspaceRoot, isPathWithin } from './server/core/project-filesystem.ts'
import { GitPathPolicy } from './server/git/policy.ts'
import { GitReadService } from './server/git/service.ts'
import { GitServiceError } from './server/git/contracts.ts'
import {
  createCapabilitiesPayload,
  createHealthPayload,
  createLegacyHealthPayload,
  type DiagnosticComponents,
  errorEnvelope,
} from './server/core/contracts.ts'
import {
  MessageDeliveryConflictError,
  messageDeliveryResponse,
  replayMessageDeliveryResponse,
  withDeliveryMetadata,
} from './server/persistence/message-delivery.ts'
import {
  QueueEntryConflictError,
  QueueEntryTransitionError,
} from './server/persistence/message-queue.ts'



type SocketData = { sessionId: string; userId: string; record: SessionRecord; project: Project; unsubscribe?: () => void; history?: TranscriptMessage[]; leafId?: string | null; historyReady?: boolean; buffered?: RpcMessage[] }
type SseClient = { userId: string; enqueue: (chunk: Uint8Array) => void; close: () => void }

const root = resolve(import.meta.dir, '..')
const webuiDir = import.meta.dir
const subpolarDataDir = join(homedir(), '.subpolar')
const projectsRoot = configuredWorkspaceRoot()

const legacyStatePath = join(webuiDir, '.sessions.json')

const legacyProjectStatePath = join(subpolarDataDir, 'projects.json')
const generalChatRoot = join(projectsRoot, 'general-chat')

const port = Number(process.env.WEBUI_PORT ?? 4173)
const internalToken = process.env.SUBPOLAR_INTERNAL_TOKEN || randomBytes(32).toString('hex')
process.env.SUBPOLAR_INTERNAL_TOKEN = internalToken
let applicationDatabasePromise: ReturnType<typeof getPocketBaseAdmin> | undefined
let runtimeStorePromise: Promise<PocketBaseRuntimeStore> | undefined
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
const nativeSessionMetadataUsers = new Set<string>()
const requestRateLimiter = new InProcessRateLimiter()
const suggestionProviderModule = process.env.SUBPOLAR_SUGGESTION_PROVIDER_MODULE?.trim()
let suggestionServicePromise: Promise<ReturnType<typeof createSuggestionService>> | undefined

async function configuredSuggestionService() {
  if (!suggestionServicePromise) {
    suggestionServicePromise = (async () => {
      if (!suggestionProviderModule) return createSuggestionService()
      const loaded = await import(suggestionProviderModule) as { default?: SuggestionProvider; provider?: SuggestionProvider }
      const provider = loaded.default ?? loaded.provider
      return createSuggestionService(typeof provider === 'function' ? provider : undefined)
    })().catch((error) => {
      suggestionServicePromise = undefined
      console.warn(`Suggestion provider unavailable: ${redactedDiagnostic(error)}`)
      return createSuggestionService()
    })
  }
  return suggestionServicePromise
}
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

async function runtimeStore(): Promise<PocketBaseRuntimeStore> {
  if (!runtimeStorePromise) {
    runtimeStorePromise = applicationDatabase().then((client) => new PocketBaseRuntimeStore(client)).catch((error) => {
      runtimeStorePromise = undefined
      throw error
    })
  }
  return runtimeStorePromise
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
  await (await runtimeStore()).reconcileStartup()
  console.log('PocketBase application collections ready')
}).catch((error) => {
  console.warn(`PocketBase is not ready: ${redactedDiagnostic(error)}`)
})

mkdirSync(projectsRoot, { recursive: true })
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
  if (!existsSync(legacyProjectStatePath)) return []
  try {
    const value = JSON.parse(readFileSync(legacyProjectStatePath, 'utf8')) as unknown
    if (!Array.isArray(value)) return []
    return value.flatMap((item) => {
      const entry = object(item)
      if (typeof entry.name !== 'string' || typeof entry.path !== 'string') return []
      try { return [{ name: entry.name, path: assertPathWithinWorkspace(entry.path, projectsRoot) }] }
      catch { return [] }
    })
  } catch {
    return []
  }
}

function sessionWorkspace(id: string): string {
  return join(generalChatRoot, id)
}

function loadLegacySessions(): SessionRecord[] {
  if (!existsSync(legacyStatePath)) return []
  try {
    const value = JSON.parse(readFileSync(legacyStatePath, 'utf8')) as unknown
    return Array.isArray(value) ? value.flatMap((item) => {
      if (!isSessionRecord(item)) return []
      try { return [{ ...item, tags: normalizeSessionTags(item.tags) }] }
      catch { return [] }
    }) : []
  } catch {
    return []
  }
}

function isSessionRecord(value: unknown): value is SessionRecord {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<SessionRecord>
  return typeof item.id === 'string' && typeof item.project === 'string' && typeof item.title === 'string'
    && typeof item.createdAt === 'number' && typeof item.updatedAt === 'number'
    && (item.tags === undefined || Array.isArray(item.tags))
}

let sessions: SessionRecord[] = []
const sseClients = new Set<SseClient>()
const encoder = new TextEncoder()

function messageDeliveryId(input: unknown): string | undefined {
  if (input === undefined) return undefined
  if (typeof input !== 'string' || input.trim() === '' || input.length > 256) throw new Error('Invalid messageID')
  return input.trim()
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
  void runtimeStore().then((store) => store.appendEvent(userId, sessionId, safeValue)).then((event) => {
    const chunk = encoder.encode(`id: ${event.id}\ndata: ${JSON.stringify(event.payload)}\n\n`)
    for (const client of sseClients) {
      if (client.userId !== userId) continue
      try { client.enqueue(chunk) } catch { client.close(); sseClients.delete(client) }
    }
  }).catch((error) => console.warn(`Unable to persist SSE event: ${redactedDiagnostic(error)}`))
}

async function saveState(record?: SessionRecord): Promise<void> {
  const candidate = record ?? undefined
  if (!candidate?.userId) return
  const client = await applicationDatabase()
  const repository = createProjectSessionRepository(client)
  const existing = await repository.getSession(candidate.userId, candidate.id)
  if (!existing) return
  await repository.updateSession(candidate.userId, candidate.id, {
    title: candidate.title,
    createdAt: candidate.createdAt,
    updatedAt: candidate.updatedAt,
    archived: candidate.archived,
    profile: candidate.profile,
    model: candidate.model,
    directory: candidate.directory,
    permissionOverride: candidate.permissionOverride,
    tags: candidate.tags,
  })
}

async function ensureUserMetadata(userId: string): Promise<void> {
  if (!userId || migratedUsers.has(userId)) return
  const client = await applicationDatabase()
  const repository = createProjectSessionRepository(client)
  await repository.ensureCollections()
  const migrationName = 'legacy_metadata_v1'
  const marker = await client.collection('metadata_migrations').getFirstListItem(`user_id = "${escapeFilter(userId)}" && migration_name = "${migrationName}"`).catch(() => null)
  if (!marker) {
    await repository.migrateLegacyMetadata(userId, {
      projects: loadProjectDefinitions(),
      sessions: loadLegacySessions(),
    })
    await client.collection('metadata_migrations').create({ user_id: userId, migration_name: migrationName, migrated_at: Date.now(), result: {} })
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
      tags: [],
    }
  } catch {
    return undefined
  }
}

function nativeSessionRecords(knownProjects: Project[] = projects()): SessionRecord[] {
  const directory = nativeSessionsDir()
  if (!existsSync(directory)) return []

  try {
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

async function ensureNativeSessionMetadata(client: Awaited<ReturnType<typeof applicationDatabase>>, userId: string): Promise<void> {
  if (nativeSessionMetadataUsers.has(userId)) return
  const repository = createProjectSessionRepository(client)
  const [ownedProjects, storedSessions] = await Promise.all([
    repository.listProjects(userId),
    repository.listSessions(userId, { includeArchived: true }),
  ])
  const knownProjects: Project[] = [generalChatProject(), ...ownedProjects.map((project) => ({ name: project.name, path: project.path }))]
  const storedIds = new Set(storedSessions.map((session) => session.id))
  for (const native of nativeSessionRecords(knownProjects)) {
    if (storedIds.has(native.id) || !native.directory) continue
    const project = native.project === 'General Chat' ? undefined : ownedProjects.find((candidate) => candidate.name === native.project)
    if (native.project !== 'General Chat' && !project) continue
    await repository.createSession(userId, {
      id: native.id,
      project: native.project,
      ...(project ? { projectId: project.id } : {}),
      title: native.title,
      createdAt: native.createdAt,
      updatedAt: native.updatedAt,
      directory: native.directory,
      tags: native.tags,
    }).catch(() => undefined)
  }
  nativeSessionMetadataUsers.add(userId)
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
  tags: string[]
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
    tags: stored.tags,
  }
}

function projectFor(name: string | undefined): Project {
  if (!name || name === '0' || name.toLocaleLowerCase() === 'general chat') return generalChatProject()
  const value = projects().find((project) => project.name === name)
  if (!value) throw new Error(`Unknown project: ${name}`)
  return value
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

function preferenceModel(preferences: unknown, key: 'conversation' | 'routing'): string | undefined {
  const values = object(preferences)
  if (key === 'conversation') return typeof values.defaultModel === 'string' && values.defaultModel.trim() ? values.defaultModel.trim() : undefined
  const defaults = object(values.defaultModels)
  return typeof defaults.routing === 'string' && defaults.routing.trim() ? defaults.routing.trim() : undefined
}

async function sessionRoutingCandidates(
  client: Awaited<ReturnType<typeof applicationDatabase>>,
  userId: string,
  projectName: string,
): Promise<SessionRoutingCandidate[]> {
  const repository = createProjectSessionRepository(client)
  const [agents, projects] = await Promise.all([
    listAgents(client, userId),
    repository.listProjects(userId),
  ])
  const candidates: SessionRoutingCandidate[] = []
  const seen = new Set<string>()
  const add = (candidate: SessionRoutingCandidate) => {
    if (seen.has(candidate.id)) return
    seen.add(candidate.id)
    candidates.push(candidate)
  }

  const scopedProject = projectName === 'General Chat' ? undefined : projects.find((project) => project.name === projectName)
  for (const agent of agents) {
    if (agent.enabled === false || agent.mode === 'subagent') continue
    if (scopedProject) {
      if (scopedProject.hasAgentOverride && !scopedProject.agentNames?.includes(agent.name)) continue
      add({ id: `${scopedProject.name}/${agent.name}`, agentName: agent.name, projectName: scopedProject.name, description: agent.description })
      continue
    }
    add({ id: agent.id || agent.name, agentName: agent.name, description: agent.description })
    for (const project of projects) {
      if (project.hasAgentOverride && !project.agentNames?.includes(agent.name)) continue
      add({
        id: `${project.name}/${agent.name}`,
        agentName: agent.name,
        projectName: project.name,
        description: agent.description,
      })
    }
  }
  return candidates
}

async function routeFirstSessionRequest(
  client: Awaited<ReturnType<typeof applicationDatabase>>,
  userId: string,
  projectName: string,
  request: string,
): Promise<SessionRoutingCandidate | null> {
  const preferences = await getUserPreferences(client, userId)
  const selection = parseRoutingModelSelection(
    preferenceModel(preferences?.preferences, 'routing') ?? preferenceModel(preferences?.preferences, 'conversation'),
  )
  if (!selection) return null

  const runtime = await userProviderRuntime(userId)
  const model = runtime.getModel(selection.providerID, selection.modelID)
  if (!model) throw new ModelUnavailableError({ providerID: selection.providerID, modelID: selection.modelID })
  return routeSessionRequest({
    runtime,
    model,
    request,
    candidates: await sessionRoutingCandidates(client, userId, projectName),
  })
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

type BridgeClient = Awaited<ReturnType<typeof applicationDatabase>>

function acknowledgePiQueueReceipt(
  record: SessionRecord,
  event: AgentSessionEvent,
  pending: Map<string, PendingQueueReceipt>,
): string | undefined {
  if (event.type !== 'message_start' || event.message.role !== 'user' || !record.userId) return undefined
  const content = sessionMessageText(event.message).trim()
  if (!content) return undefined

  for (const [clientId, receipt] of pending) {
    if (receipt.content !== content) continue
    pending.delete(clientId)
    void runtimeStore().then((store) => store.updateQueueEntry(record.userId!, record.id, clientId, 'delivered')).then((entry) => {
      if (entry) broadcastSse({ type: 'message.queue.updated', properties: { sessionID: record.id } }, record.userId)
    }).catch((error) => console.warn(`Unable to acknowledge queued message ${clientId}: ${redactedDiagnostic(error)}`))
    return clientId
  }
  return undefined
}

const piSdkSessionHost: PiSdkSessionHost<BridgeClient> = {
  getClient: applicationDatabase,
  prepareUser: async (client, userId) => {
    await ensureUserMetadata(userId)
    await ensureUserDefaults(client, userId)
  },
  resolveContext: async (client, userId, sessionId) => {
    const context = await resolveToolSessionContext(client, userId, sessionId)
    return {
      agentName: context.agentName,
      permissionOverride: context.permissionOverride,
      session: context.session
        ? { project: context.session.project, permissionOverride: context.session.permissionOverride }
        : undefined,
    }
  },
  loadRuntime: (client, userId, context) => loadAgentRuntime(client, userId, context.agentName, context.session?.project, {
    skillRepository: createOwnerBoundSkillStore(client, userId),
    skillAudit: createSkillContextAudit(client),
  }),
  getProviderRuntime: userProviderRuntime,
  createRoutingExtension: (context) => createToolRoutingExtension(context),
  createToolGateway: (client) => inProcessToolGateway ?? createToolGatewayFromCallTool(client, callTool),
  listTools: (client, userId, agentName, project) => listToolsForAgent(client, userId, agentName, project),
  searchTools: (client, userId, agentName, query) => searchToolsForAgent(client, userId, agentName, query),
  describeTool: (client, userId, agentName, toolId) => describeToolForAgent(client, userId, agentName, toolId),
  onApproval: (record, approval, directory) => {
    broadcastSse({
      type: 'permission.asked',
      directory,
      properties: permissionAskedProperties({ id: approval.id, sessionId: approval.session_id, toolId: approval.tool_id, input: approval.input, reason: approval.reason }),
    }, record.userId)
  },
  extensionFactories: applicationExtensionFactories,
  baseUrl: `http://127.0.0.1:${port}`,
  internalToken,
  getNativeSessionsDir: nativeSessionsDir,
  parseModelSelection,
  acknowledgeQueueReceipt: acknowledgePiQueueReceipt,
  saveState,
  redactEvent: (value) => redactSensitive(value) as RpcMessage,
  publishStatus: (record, status) => broadcastSse({ type: 'session.status', properties: { sessionID: record.id, status: { type: status } } }, record.userId),
  publishEvent: (record, message) => broadcastSse(message, record.userId),
  onAgentSettled: (session) => { void deliverNextQueuedFollowUp(session) },
}

function createPiSession(record: SessionRecord, project: Project, capabilities?: readonly string[]): PiSdkSession<BridgeClient> {
  return new PiSdkSession(record, project, { host: piSdkSessionHost, capabilities })
}

async function executeSubagentHost(input: { task: import('./server/application/task-control-plane.ts').TaskRecord; signal: AbortSignal; capabilities: readonly string[]; cwd?: string }): Promise<unknown> {
  const taskInput = object(input.task.input)
  const cwd = input.cwd ?? configuredWorkspaceRoot()
  let worktree: Awaited<ReturnType<WorktreeController['create']>> | undefined
  if (taskInput.coding !== false && input.task.project_id && subagentWorktrees) {
    worktree = await subagentWorktrees.create({ ownerId: input.task.owner_id, projectId: input.task.project_id, repository: cwd, baseRef: 'HEAD', taskId: input.task.id })
    await (await applicationDatabase()).collection('tasks').update(input.task.id, { worktree_id: worktree.id, base_ref: worktree.baseRef, updated_at: Date.now() })
  }
  const record: SessionRecord = { id: `subagent-${input.task.id}`, project: 'Subagent', title: input.task.title, createdAt: Date.now(), updatedAt: Date.now(), userId: input.task.owner_id, profile: input.task.subagent_id, directory: worktree?.path ?? cwd, tags: [] }
  const project: Project = { name: 'Subagent', path: worktree?.path ?? cwd }
  const session = createPiSession(record, project, input.capabilities)
  const abort = () => { void session.send({ type: 'abort' }) }
  input.signal.addEventListener('abort', abort, { once: true })
  try {
    await session.send({ type: 'prompt', message: typeof taskInput.prompt === 'string' ? taskInput.prompt : input.task.title })
    return { text: session.getLastAssistantText(), sessionId: record.id, worktreeId: worktree?.id }
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
    return { text: session.getLastAssistantText(), sessionId }
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



async function deliverNextQueuedFollowUp(session: PiSdkSession<BridgeClient>): Promise<void> {
  const ownerId = session.record.userId
  if (!ownerId) return
  const store = await runtimeStore()
  const entry = (await store.listQueueEntries(ownerId, session.record.id)).find((item) => item.kind === 'follow_up' && item.state === 'enqueued')
  if (!entry) return
  const claimed = await store.claimQueueEntry(ownerId, session.record.id, entry.clientId)
  if (!claimed) return
  try {
    await session.send({ type: 'follow_up', message: entry.content, id: entry.clientId })
  } catch (error) {
    await store.updateQueueEntry(ownerId, session.record.id, entry.clientId, 'failed', error instanceof Error ? error.message : 'Follow-up delivery failed')
  }
  broadcastSse({ type: 'message.queue.updated', properties: { sessionID: session.record.id } }, ownerId)
}

const active = new Map<string, PiSdkSession<BridgeClient>>()

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
  await ensureNativeSessionMetadata(client, userId)
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
): PiSdkSession<BridgeClient> {
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
  const session = createPiSession(record, project)
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
  await saveState(record)
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
  const authorization = request.headers.get('authorization') ?? ''
  const secret = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : ''
  if (!await new PocketBaseProxyCredentialStore(await applicationDatabase()).authenticate(secret)) {
    return proxyJson({ error: { message: 'Valid bearer credentials are required', type: 'authentication_error' } }, 401)
  }

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

async function loadSocketHistory(socket: TranscriptSocket, session: PiSdkSession<BridgeClient>, request: { type?: string; before?: string; limit?: number; leafId?: string }): Promise<void> {
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

async function handleSocketMessage(socket: TranscriptSocket, raw: unknown, session: PiSdkSession<BridgeClient>): Promise<void> {
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

const bridgeRequestDependencies = {
  applicationDatabase, runtimeStore, createLegacyHealthPayload, createCapabilitiesPayload, createHealthPayload,
  diagnosticsComponents, internalToken, requestId, authenticateGatewayCredential, GatewayAuthError, json,
  authenticateRequest, voiceAuthorization, voiceBackends, handleVoiceRoute, authConfig, signOut, clearAuthCookie,
  body, signIn, signUp, changePassword, ownedSessionRecord, configuredSuggestionService, gatewayErrorResponse,
  listGatewayCredentials, publicGatewayCredential, createGatewayCredential, rotateGatewayCredential,
  revokeGatewayCredential, AutomationRepository, automationWorkerFor, ownedProjectIdForRoute, routeError,
  routeLimit, listAgents, validateTriggerKey, InboxRepository, NotificationRepository, getUserPreferences,
  notificationPreferenceValue, saveUserPreferences, ensureUserDefaults, TaskRepository, TaskRequestError,
  TaskControlError, subagentController, BrowserSessionService, BrowserRuntimeError, createCustomProviderService,
  customProviderDiscoveryUrl, networkPolicyFromMetadata, fetchWithNetworkPolicy, readBoundedResponse,
  CustomProviderValidationError, providerAccountService, modelRuntimePromise, providerLoginFlowController,
  parseProviderRuntimeId, ownedProviderAccount, ProviderLoginFlowError, providerLoginFlowStorageError,
  PocketBaseProxyCredentialStore, hashProxySecret, proxyCredentialResponse, ownedProjectResponses,
  GitReadService, GitPathPolicy, GitServiceError, createProjectSessionRepository, ProjectPathConflictError, canonicalProjectPath,
  safeProjectPath, generalChatProject, mkdirSync, readdirSync, writeFileSync, statSync, projectsRoot,
  generalChatRoot, resolve, isPathWithin, resolveNewSessionRoute, NewSessionRouteError, preferenceModel,
  validateModelSelection, modelSelection, normalizeSessionTags, InvalidSessionTagsError, sessionWorkspace,
  saveState, sessions, rpcSession, sendRpc, storedSessionResponse, parseModelSelection,
  parseRoutingModelSelection, routeFirstSessionRequest, localSessionRecord, sessionMessageText, entriesPayload,
  transcriptHistory, messageDeliveryId, queueClientId, MessageDeliveryConflictError,
  replayMessageDeliveryResponse, messageDeliveryResponse, QueueEntryConflictError, QueueEntryTransitionError,
  withDeliveryMetadata, redactSensitive, redactSensitiveText, ownedSessionProject, resolveToolSessionContext,
  requestedPermissionOverride, requestedMetadataPermission, sessionContextFailure, mapToolId,
  permissionAskedProperties, authorizePiToolCall, upsertRegisteredTool, listToolsForAgent, searchToolsForAgent,
  describeToolForAgent, inProcessToolGateway, createToolGatewayFromCallTool, callTool, continueApprovedTool,
  respondToApproval, listPendingApprovals, escapeFilter, DEFAULT_SETTINGS, applicationExtensionPaths,
  homedir, root, openApiProviders, dailyUsage, runtimeProviders, active, activeKey, sseClients, encoder,
  handleProxy, redactedDiagnostic, broadcastSse, persistSessionModel, rpcData, projectEntries,
  projectResponse, encodeSessionCursor, decodeSessionCursor, sessionPageLimit, ensureNativeSessionMetadata,
  ensureUserMetadata, object, providerAccountInstance, providerCatalogAccount, userProviderRuntime,
  createOwnerBoundSkillStore, createProviderCatalogAsync, effectiveAgentConfiguration, proposeTools,
  registerToolDraft, redactVoiceSettings, readJsonBody, assertGatewayAccess, assertPathWithinWorkspace,
  randomBytes, SESSION_SEARCH_MAX_LENGTH, TRIGGER_KEY_ERROR, RequestSecurityError,
  SkillConflictError, SkillNotFoundError, SkillValidationError,
}
const handle = createBridgeRequestHandler(bridgeRequestDependencies)

export type BridgeRuntime = Record<string, any>

export const bridgeRuntime: BridgeRuntime = {
  port, handle, handleProxy, startAutomationScheduler,
  requestId, isAllowedOrigin, errorEnvelope, assertSafeBrowserMutation, REQUEST_LIMITS,
  authenticateRequest, rateLimitKey, requestRateLimiter, json, redactedDiagnostic, RequestSecurityError,
  applicationDatabase, ownedSessionRecord, ownedSessionProject, resolveToolSessionContext, rpcSession,
  handleSocketMessage,
}
