import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
} from '@earendil-works/pi-coding-agent'
import type {
  AgentSession,
  AgentSessionEvent,
  ExtensionFactory,
} from '@earendil-works/pi-coding-agent'
import type { ProviderRuntime } from './provider-runtime.ts'
import type { AgentRuntime } from './agent-runtime.ts'
import type { Approval } from './tools.ts'
import type { PermissionOverride } from '../persistence/project-store.ts'
import type { ToolGateway } from './tool-gateway.ts'
import type { createToolRoutingExtension } from '../../subpolar/extensions/tool-routing.ts'

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
  permissionOverride: PermissionOverride
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
  createToolGateway: (client: TClient) => ToolGateway
  listTools: (client: TClient, userId: string, agentName: string, project?: string) => Promise<unknown>
  searchTools: (client: TClient, userId: string, agentName: string, query: string) => Promise<unknown>
  describeTool: (client: TClient, userId: string, agentName: string, toolId: string) => Promise<unknown>
  onApproval: (record: SessionRecord, approval: Approval, directory: string) => void
  extensionFactories: readonly ExtensionFactory[]
  baseUrl: string
  internalToken: string
  getNativeSessionsDir: () => string
  parseModelSelection: (value: string | undefined) => SessionModelSelection | undefined
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

export class PiSdkSession<TClient = unknown> {
  private readonly listeners = new Set<(message: RpcMessage) => void>()
  private readonly pendingQueueReceipts = new Map<string, PendingQueueReceipt>()
  private readonly ready: Promise<void>
  private runtimeAgentName: string
  private runtimePermissionOverride: PermissionOverride
  private session!: AgentSession
  private modelRuntime!: ProviderRuntime

  constructor(
    readonly record: SessionRecord,
    readonly project: Project,
    private readonly options: {
      host: PiSdkSessionHost<TClient>
      capabilities?: readonly string[]
    },
  ) {
    this.runtimeAgentName = record.profile ?? 'master'
    this.runtimePermissionOverride = record.permissionOverride ?? 'ask'
    this.ready = this.initialize()
  }

  private async initialize(): Promise<void> {
    const { host } = this.options
    const client = await host.getClient()
    const userId = this.record.userId
    if (!userId) throw new Error('Session has no authenticated owner')
    await host.prepareUser(client, userId)
    const context = await host.resolveContext(client, userId, this.record.id)
    this.runtimeAgentName = context.agentName
    this.runtimePermissionOverride = context.permissionOverride
    this.record.profile = context.agentName
    if (context.session?.permissionOverride !== undefined) this.record.permissionOverride = context.session.permissionOverride
    const runtime = await host.loadRuntime(client, userId, context)
    const sessionManager = await this.openOrCreateSession()
    const sessionCwd = this.record.directory ?? this.project.path
    const resourceLoader = new DefaultResourceLoader({
      cwd: this.project.path,
      agentDir: getAgentDir(),
      systemPrompt: runtime.systemPrompt,
      extensionFactories: [
        ...host.extensionFactories,
        host.createRoutingExtension({
          baseUrl: host.baseUrl,
          internalToken: host.internalToken,
          gateway: host.createToolGateway(client),
          userId,
          agentName: runtime.agent.name,
          sessionId: this.record.id,
          cwd: sessionCwd,
          permissionOverride: this.runtimePermissionOverride,
          capabilities: this.options.capabilities,
          onApproval: (approval: Approval) => this.options.host.onApproval(this.record, approval, sessionCwd),
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
    const sessionsDir = this.options.host.getNativeSessionsDir()
    const infos = await SessionManager.list(cwd, sessionsDir)
    const existing = infos.find((info) => info.id === this.record.id)
    return existing ? SessionManager.open(existing.path, sessionsDir, cwd) : SessionManager.create(cwd, sessionsDir, { id: this.record.id })
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
    if (event.type === 'agent_start' || event.type === 'turn_start') this.options.host.publishStatus(this.record, 'busy')
    if (event.type === 'agent_end' || event.type === 'agent_settled') this.options.host.publishStatus(this.record, 'idle')
    if (event.type === 'agent_settled') this.options.host.onAgentSettled(this)
    if (event.type !== 'agent_settled') {
      for (const listener of this.listeners) listener(message)
      this.options.host.publishEvent(this.record, { ...message, sessionID })
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
    await this.options.host.saveState(this.record)
    return { type: 'response', id: String(command.id ?? ''), success: true, data }
  }

  get entries() { return this.session.sessionManager.getEntries() }
  get leafId() { return this.session.sessionManager.getLeafId() }
  get agentName() { return this.runtimeAgentName }
  get permissionOverride() { return this.runtimePermissionOverride }
  getLastAssistantText() { return this.session.getLastAssistantText() }

  close(): void {
    this.session?.dispose()
  }
}
