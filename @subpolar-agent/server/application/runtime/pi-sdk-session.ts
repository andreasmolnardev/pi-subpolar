import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SettingsManager,
  SessionManager,
  buildContextEntries,
} from '@earendil-works/pi-coding-agent'
import type {
  AgentSession,
  AgentSessionEvent,
  ExtensionFactory,
  SessionEntry,
} from '@earendil-works/pi-coding-agent'
import { assertTenantSession } from './tenant-runtime.ts'
import type { ProviderRuntime } from './provider-runtime.ts'
import type { AgentRuntime } from './agent-runtime.ts'
import type { ApprovalRecord } from '../../../../packages/subpolar-contracts/src/index.ts'
import type { PermissionOverride } from '../../persistence/project-store.ts'
import type { ToolGateway } from '../../../../packages/subpolar-core/src/index.ts'
import type { createToolRoutingExtension } from '../../../subpolar/extensions/tool-routing.ts'

export type Project = {
  id?: string | number
  name: string
  path: string
  agentNames?: readonly string[]
  hasAgentOverride?: boolean
}

export type SessionRecord = {
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
  tags: string[]
}

export type RpcCommand = Record<string, unknown> & { type: string }
export type RpcMessage = Record<string, unknown> & { type?: string; id?: string }
export type PendingQueueReceipt = { content: string; kind: 'steering' | 'follow_up' }
export type SessionModelSelection = { providerID: string; modelID: string }

export type PiSessionContext = {
  agentName: string
  permissionOverride?: PermissionOverride
  session?: {
    project?: string
    permissionOverride?: PermissionOverride
  }
}

export type PiSessionRuntime = Pick<AgentRuntime, 'agent' | 'systemPrompt' | 'pi'>
export type PiRoutingExtensionContext = Parameters<typeof createToolRoutingExtension>[0]

export type PiSdkSessionHost<TClient = unknown> = {
  getClient: () => Promise<TClient>
  prepareUser: (client: TClient, userId: string) => Promise<void>
  resolveContext: (client: TClient, userId: string, sessionId: string) => Promise<PiSessionContext>
  loadRuntime: (client: TClient, userId: string, context: PiSessionContext) => Promise<PiSessionRuntime>
  getProviderRuntime: (userId: string) => Promise<ProviderRuntime>
  createRoutingExtension: (context: PiRoutingExtensionContext) => ExtensionFactory
  createToolGateway: (client: TClient, context?: { userId: string; agentName: string; sessionId: string; cwd: string; permissionOverride?: PermissionOverride; capabilities?: readonly string[] }) => Promise<ToolGateway>
  listTools: (client: TClient, userId: string, agentName: string, project?: string) => Promise<unknown>
  searchTools: (client: TClient, userId: string, agentName: string, query: string) => Promise<unknown>
  describeTool: (client: TClient, userId: string, agentName: string, toolId: string) => Promise<unknown>
  onApproval: (record: SessionRecord, approval: ApprovalRecord, directory: string) => void
  extensionFactories: readonly ExtensionFactory[]
  baseUrl: string
  internalToken: string
  parseModelSelection: (value: string | undefined) => SessionModelSelection | undefined
  loadTranscript: (client: TClient, userId: string, sessionId: string) => Promise<{ entries: unknown[]; leafId: string | null }>
  isWorkspaceAvailable?: (cwd: string) => boolean
  saveTranscript: (client: TClient, userId: string, sessionId: string, entries: readonly unknown[], leafId: string | null) => Promise<void>
  acknowledgeQueueReceipt: (
    record: SessionRecord,
    event: AgentSessionEvent,
    pending: Map<string, PendingQueueReceipt>,
  ) => string | undefined
  saveState: (record?: SessionRecord) => Promise<void>
  redactEvent: (value: unknown) => RpcMessage
  publishStatus: (record: SessionRecord, status: 'busy' | 'idle') => void
  publishEvent: (record: SessionRecord, message: RpcMessage) => void
  onAgentSettled: (session: PiSdkSession<TClient>) => void
}

export function sessionMessageText(message: unknown): string {
  if (!message || typeof message !== 'object') return ''
  const content = (message as { content?: unknown }).content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.flatMap((part) => {
    if (!part || typeof part !== 'object') return []
    const item = part as { text?: unknown; thinking?: unknown }
    return typeof item.text === 'string' ? [item.text] : typeof item.thinking === 'string' ? [item.thinking] : []
  }).join('\n')
}

/** Replay application-owned history into a non-persistent Pi session manager. */
export function hydrateSessionManager(manager: SessionManager, transcript: { entries: unknown[]; leafId: string | null }): void {
  const entries = buildContextEntries(transcript.entries as SessionEntry[], transcript.leafId)
  for (const entry of entries) {
    switch (entry.type) {
      case 'message': manager.appendMessage(entry.message as never); break
      case 'thinking_level_change': manager.appendThinkingLevelChange(entry.thinkingLevel); break
      case 'model_change': manager.appendModelChange(entry.provider, entry.modelId); break
      case 'session_info': if (entry.name) manager.appendSessionInfo(entry.name); break
      case 'custom': manager.appendCustomEntry(entry.customType, entry.data); break
      case 'custom_message': manager.appendCustomMessageEntry(entry.customType, entry.content, entry.display, entry.details); break
      case 'compaction': manager.appendCustomMessageEntry('subpolar.compaction', `Conversation summary:\n${entry.summary}`, false); break
      case 'branch_summary': manager.appendCustomMessageEntry('subpolar.branch-summary', `Abandoned branch summary:\n${entry.summary}`, false); break
      // Labels remain application transcript metadata and do not affect model context.
      default: break
    }
  }
}

export class PiSdkSession<TClient = unknown> {
  private readonly listeners = new Set<(message: RpcMessage) => void>()
  private readonly pendingQueueReceipts = new Map<string, PendingQueueReceipt>()
  private readonly ready: Promise<void>
  private transcriptWrite: Promise<void> = Promise.resolve()
  private runtimeAgentName: string
  private runtimePermissionOverride?: PermissionOverride
  private generationStatus: 'busy' | 'idle' = 'idle'
  private session!: AgentSession
  private sessionManager!: SessionManager
  private modelRuntime!: ProviderRuntime
  private workspaceAvailable = true
  private closed = false

  constructor(
    readonly record: SessionRecord,
    readonly project: Project,
    private readonly options: {
      host: PiSdkSessionHost<TClient>
      capabilities?: readonly string[]
    },
  ) {
    assertTenantSession(record.userId ?? '', record.id, record)
    // Keep mutable metadata local, but never let a caller retarget a live session.
    this.record = { ...record, tags: [...record.tags] }
    Object.defineProperties(this.record, {
      id: { value: record.id, writable: false },
      userId: { value: record.userId, writable: false },
    })
    this.runtimeAgentName = record.profile ?? 'master'
    this.runtimePermissionOverride = record.permissionOverride
    this.ready = this.initialize()
  }

  private async initialize(): Promise<void> {
    const { host } = this.options
    const client = await host.getClient()
    const userId = this.record.userId
    if (!userId) throw new Error('Session has no authenticated owner')
    const sessionDirectory = this.record.directory ?? this.project.path
    const sessionDirectoryAvailable = host.isWorkspaceAvailable?.(sessionDirectory) ?? true
    const sessionCwd = this.project.name === 'General Chat' && !sessionDirectoryAvailable
      ? this.project.path
      : sessionDirectory
    this.workspaceAvailable = sessionCwd === sessionDirectory
      ? sessionDirectoryAvailable
      : host.isWorkspaceAvailable?.(sessionCwd) ?? true
    const persistedTranscript = await host.loadTranscript(client, userId, this.record.id)
    this.sessionManager = SessionManager.inMemory(sessionCwd, { id: this.record.id })
    hydrateSessionManager(this.sessionManager, persistedTranscript)
    if (!this.workspaceAvailable) return
    await host.prepareUser(client, userId)
    const context = await host.resolveContext(client, userId, this.record.id)
    this.runtimeAgentName = context.agentName
    this.runtimePermissionOverride = context.permissionOverride
    this.record.profile = context.agentName
    if (context.session?.permissionOverride !== undefined) this.record.permissionOverride = context.session.permissionOverride
    const runtime = await host.loadRuntime(client, userId, context)
    const sessionManager = this.sessionManager
    const settingsManager = SettingsManager.inMemory()
    const resourceLoader = new DefaultResourceLoader({
      cwd: sessionCwd,
      agentDir: getAgentDir(),
      systemPrompt: runtime.systemPrompt,
      settingsManager,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      appendSystemPromptOverride: () => [],
      // Subpolar Agent owns its extension set. Do not load user/global Pi extension
      // directories because those extensions may reintroduce file-backed state
      // or bypass the Subpolar application boundary.
      noExtensions: true,
      extensionFactories: [
        ...host.extensionFactories,
        host.createRoutingExtension({
          baseUrl: host.baseUrl,
          internalToken: host.internalToken,
          gateway: await host.createToolGateway(client, {
            userId,
            agentName: runtime.agent.name,
            sessionId: this.record.id,
            cwd: sessionCwd,
            permissionOverride: this.runtimePermissionOverride,
            capabilities: this.options.capabilities,
          }),
          userId,
          agentName: runtime.agent.name,
          sessionId: this.record.id,
          cwd: sessionCwd,
          permissionOverride: this.runtimePermissionOverride,
          capabilities: this.options.capabilities,
          onApproval: (approval: ApprovalRecord) => this.options.host.onApproval(this.record, approval, sessionCwd),
          listTools: () => host.listTools(client, userId, runtime.agent.name, context.session?.project),
          searchTools: (query) => host.searchTools(client, userId, runtime.agent.name, query),
          describeTool: (toolId) => host.describeTool(client, userId, runtime.agent.name, toolId),
        }),
      ],
    })
    await resourceLoader.reload()
    this.modelRuntime = await host.getProviderRuntime(userId)
    const selectedModel = this.record.model ? host.parseModelSelection(this.record.model) : undefined
    const model = selectedModel ? this.modelRuntime.getModel(selectedModel.providerID, selectedModel.modelID) : undefined
    if (selectedModel && !model) throw new Error('Selected provider account or model is unavailable')
    const result = await createAgentSession({
      cwd: sessionCwd,
      modelRuntime: this.modelRuntime,
      settingsManager,
      model,
      sessionManager,
      resourceLoader,
      // The routing extension replaces the SDK's same-named built-ins. Keeping
      // the allowlist explicit prevents unrelated SDK tools from appearing.
      tools: [...runtime.pi.allowedToolNames],
      // Disable SDK built-ins, but retain policy-allowed extension tools.
      noTools: 'builtin',
    })
    this.session = result.session
    if (this.closed) {
      this.session.dispose()
      throw new Error('Session is closed')
    }
    this.session.subscribe((event) => this.handle(event))
  }


  private handle(event: AgentSessionEvent): void {
    const sentQueueClientId = this.options.host.acknowledgeQueueReceipt(this.record, event, this.pendingQueueReceipts)
    if (event.type === 'session_info_changed') {
      this.record.title = event.name?.trim() || 'Untitled session'
      this.record.updatedAt = Date.now()
      void this.options.host.saveState(this.record)
    }
    const message = this.options.host.redactEvent({
      ...event,
      sessionID: this.record.id,
      ...(sentQueueClientId ? { queueDelivery: 'sent', queueClientId: sentQueueClientId } : {}),
    })
    const sessionID = this.record.id
    if (event.type === 'agent_start' || event.type === 'turn_start') {
      this.generationStatus = 'busy'
      this.options.host.publishStatus(this.record, 'busy')
    }
    if (event.type === 'agent_end' || event.type === 'agent_settled') {
      this.generationStatus = 'idle'
      this.options.host.publishStatus(this.record, 'idle')
    }
    if (event.type !== 'agent_settled') {
      for (const listener of this.listeners) listener(message)
      this.options.host.publishEvent(this.record, { ...message, sessionID })
    }
    void this.persistTranscript().catch(() => undefined)
    if (event.type === 'agent_settled') this.options.host.onAgentSettled(this)
  }

  onMessage(listener: (message: RpcMessage) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  get readyPromise(): Promise<void> {
    return this.ready
  }

  getStatus(): 'busy' | 'idle' {
    return this.generationStatus
  }

  async send(command: RpcCommand): Promise<unknown> {
    await this.ready
    if (this.closed) throw new Error('Session is closed')
    const type = command.type
    let data: unknown
    if (!this.workspaceAvailable) {
      if (type === 'get_entries' || type === 'get_messages') {
        data = { entries: this.sessionManager.getEntries(), leafId: this.sessionManager.getLeafId() }
      } else if (type === 'get_state') {
        const entries = this.sessionManager.getEntries()
        data = { sessionId: this.record.id, workspaceAvailable: false, isStreaming: false, messages: entries.filter((entry) => entry.type === 'message').map((entry) => entry.message) }
      } else if (type === 'get_last_assistant_text') {
        const messages = this.sessionManager.getEntries().filter((entry) => entry.type === 'message').map((entry) => entry.message)
        const last = [...messages].reverse().find((message) => message.role === 'assistant')
        data = last ? sessionMessageText(last) : ''
      } else if (type === 'get_commands') {
        data = []
      } else {
        throw new Error('Session workspace is missing; transcript is read-only')
      }
      return { type: 'response', id: String(command.id ?? ''), success: true, data }
    }
    switch (type) {
      case 'prompt': await this.session.prompt(String(command.message ?? '')); break
      case 'steer': {
        const clientId = typeof command.id === 'string' && command.id ? command.id : undefined
        if (clientId) this.pendingQueueReceipts.set(clientId, { content: String(command.message ?? ''), kind: 'steering' })
        try { await this.session.steer(String(command.message ?? '')) } catch (error) { if (clientId) this.pendingQueueReceipts.delete(clientId); throw error }
        break
      }
      case 'follow_up': {
        const clientId = typeof command.id === 'string' && command.id ? command.id : undefined
        if (clientId) this.pendingQueueReceipts.set(clientId, { content: String(command.message ?? ''), kind: 'follow_up' })
        try { await this.session.followUp(String(command.message ?? '')) } catch (error) { if (clientId) this.pendingQueueReceipts.delete(clientId); throw error }
        break
      }
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
      case 'get_entries': data = { entries: this.sessionManager.getEntries(), leafId: this.sessionManager.getLeafId() }; break
      case 'get_messages': data = { entries: this.sessionManager.getEntries(), leafId: this.sessionManager.getLeafId() }; break
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
    await this.options.host.saveState(this.record)
    await this.persistTranscript()
    return { type: 'response', id: String(command.id ?? ''), success: true, data }
  }

  private persistTranscript(): Promise<void> {
    const clientPromise = this.options.host.getClient()
    this.transcriptWrite = this.transcriptWrite.then(async () => {
      await this.ready
      const client = await clientPromise
      await this.options.host.saveTranscript(client, this.record.userId!, this.record.id, this.session.sessionManager.getEntries(), this.session.sessionManager.getLeafId())
    })
    return this.transcriptWrite
  }

  get entries() { return this.sessionManager.getEntries() }
  get leafId() { return this.sessionManager.getLeafId() }
  get isWorkspaceAvailable() { return this.workspaceAvailable }
  get agentName() { return this.runtimeAgentName }
  get permissionOverride() { return this.runtimePermissionOverride }
  getLastAssistantText() {
    if (this.workspaceAvailable) return this.session.getLastAssistantText()
    const messages = this.sessionManager.getEntries().filter((entry) => entry.type === 'message').map((entry) => entry.message)
    const last = [...messages].reverse().find((message) => message.role === 'assistant')
    return last ? sessionMessageText(last) : ''
  }

  close(): void {
    this.closed = true
    this.listeners.clear()
    this.session?.dispose()
  }
}
