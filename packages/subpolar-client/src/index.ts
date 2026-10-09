export type JsonRecord = Record<string, unknown>

export interface SubpolarClientOptions {
  baseUrl: string
  /** Optional bearer credential. Cookie authentication is also supported via credentials. */
  token?: string
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  credentials?: RequestCredentials
  headers?: HeadersInit
}

export interface ApiErrorBody {
  error?: { code?: string; message?: string; details?: JsonRecord } | string
  code?: string
  details?: JsonRecord
  message?: string
  requestId?: string
}

export class SubpolarApiError extends Error {
  readonly status: number
  readonly code?: string
  readonly requestId?: string
  readonly details?: JsonRecord

  constructor(status: number, body: ApiErrorBody, fallback: string) {
    const error = typeof body.error === 'object' ? body.error : undefined
    super(error?.message ?? (typeof body.error === 'string' ? body.error : undefined) ?? body.message ?? fallback)
    this.name = 'SubpolarApiError'
    this.status = status
    this.code = error?.code ?? body.code
    this.requestId = body.requestId
    this.details = error?.details ?? body.details
  }
}

export type CapabilityState = 'available' | 'unconfigured' | 'unknown'
export interface CapabilityDescriptor {
  id: string
  version: string
  state: CapabilityState
  routes?: readonly string[]
}
export interface Capabilities {
  contract: { id: 'subpolar-api.v1'; version: 'v1' }
  compatibility: JsonRecord
  correlation: { fields: readonly string[] }
  events: { id: string; version: string; envelope: string; requiredFields: readonly string[]; correlationFields: readonly string[] }
  capabilities: readonly CapabilityDescriptor[]
  requestId: string
}
export interface Health {
  contract: { id: 'subpolar-api.v1'; version: 'v1' }
  status: 'healthy' | 'degraded' | 'unknown'
  timestamp: string
  components: Record<string, { state: string; reason?: string; details?: JsonRecord }>
  requestId: string
}
export interface User { id: string; email?: string; name?: string; [key: string]: unknown }
export interface AuthConfig { registrationEnabled: boolean; isFirstUser?: boolean; [key: string]: unknown }
export interface AuthSession { user: User | null; token: string | null }
export interface SignInResponse { user: User; token: string }

export interface Project {
  id: number
  name: string
  directory?: string
  path?: string
  repositoryId?: string
  agentNames?: string[]
  hasAgentOverride?: boolean
  [key: string]: unknown
}
export interface ProjectInput { name: string; directory?: string; agentNames?: string[] }
export interface Session {
  id: string
  title: string
  project?: string
  directory?: string
  updatedAt: number
  createdAt?: number
  archived?: boolean
  tags?: string[]
  profile?: string
  model?: string
  worktreeId?: string
  [key: string]: unknown
}
export interface SessionList {
  sessions: Session[]
  nextCursor?: string
  page?: { limit: number; order: 'asc' | 'desc'; hasNext: boolean; nextCursor?: string }
}
export interface CreateSessionInput {
  project?: number | string
  repositoryId?: string
  directory?: string
  agent?: string
  title?: string
  tags?: string[]
  model?: string
  thinking?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
  permission?: 'ask' | 'none' | 'allow_all'
  worktreeId?: string
}
export interface MessageDelivery { messageID: string; state: string; runId?: string; [key: string]: unknown }
export interface RunResult { [key: string]: unknown }
export interface Approval {
  id: string
  sessionId?: string
  toolId?: string
  input?: JsonRecord
  reason?: string
  [key: string]: unknown
}
export interface Agent extends JsonRecord {
  id: string
  name: string
  enabled?: boolean
  description?: string
  systemPrompt?: string
}
export interface ProviderModelSelection { providerID: string; modelID: string }
export interface ProviderModelState {
  recent: ProviderModelSelection[]
  favorite: ProviderModelSelection[]
  variant: Record<string, string | undefined>
}
export interface ProviderCatalogModel extends JsonRecord {
  id: string
  instanceId: string
  providerId: string
  modelId: string
  name: string
}
export interface ProviderCatalogProvider extends JsonRecord {
  id: string
  name: string
  models: readonly ProviderCatalogModel[]
}
export interface ProviderCatalog {
  providers: readonly ProviderCatalogProvider[]
  accounts: readonly JsonRecord[]
  models: readonly ProviderCatalogModel[]
}
export interface Tool extends JsonRecord {
  tool_id: string
  namespace: string
  description: string
  input_schema: JsonRecord
  risk: string
  requires_approval: boolean
}
export type ToolPolicyEffect = 'allow' | 'deny' | 'approval'
export interface AgentToolPolicy extends JsonRecord {
  id?: string
  toolId: string
  effect: ToolPolicyEffect
}
export interface Settings {
  preferences: JsonRecord
  updatedAt: number
}
export interface SessionMessage extends JsonRecord {
  id?: string
  role?: string
  content?: string
  createdAt?: number
  metadata?: JsonRecord
  info?: JsonRecord
  parts?: JsonRecord[]
}
export interface RepositoryRead {
  root: string
  gitDir: string
  bare: boolean
  head: string | null
}
export interface RepositoryStatus {
  branch: string | null
  ahead: number
  behind: number
  entries: Array<{ path: string; originalPath?: string; index: string; worktree: string; untracked: boolean; renamed: boolean }>
  omitted: Array<{ path: string; reason: 'PATH_DENIED' }>
  truncated: boolean
}
export interface RepositoryStatusResponse { repository: RepositoryRead; status: RepositoryStatus; requestId: string }
export interface WorktreeSources { repositoryId: string; branches: unknown[]; providerRepository?: unknown; [key: string]: unknown }
export interface Worktree {
  id: string
  path: string
  branch: string
  [key: string]: unknown
}

/** Paths without an implemented server endpoint are intentionally not emulated. */
export const unsupportedFeatures = {
  agentInspection: 'The server exposes owner-scoped GET /api/agents, but no GET /api/agents/{id} route.',
  approvalInspection: 'There is no approval-by-ID route. Lookup is available only by listing pending approvals, optionally scoped to sessionId.',
  nativeTypedPerSessionWebSocket: 'The WebUI uses authenticated WebSocket /api/sessions/{sessionId}/events. This HTTP client exposes the current owner-scoped SSE /api/sse/stream feed instead.',
  remoteRepositoryRefresh: 'POST /api/projects/{projectId}/repository/refresh is present but returns UNSUPPORTED; policy-aware authenticated Git transport is not available.',
  projectSessionBulkDelete: 'No bulk-delete route exists.',
} as const

export interface EventStreamOptions {
  after?: string | number
  sessionId?: string
  signal?: AbortSignal
}
export interface SubpolarEvent {
  id?: string
  event?: string
  data: unknown
  rawData: string
}

export class SubpolarClient {
  readonly baseUrl: string
  private readonly token?: string
  private readonly fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  private readonly credentials: RequestCredentials
  private readonly defaultHeaders: HeadersInit

  constructor(options: SubpolarClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.token = options.token
    this.fetchImpl = options.fetch ?? fetch
    this.credentials = options.credentials ?? 'include'
    this.defaultHeaders = options.headers ?? {}
    if (!this.baseUrl) throw new TypeError('baseUrl is required')
    if (this.token) {
      const target = new URL(this.baseUrl)
      const loopback = target.hostname === 'localhost' || target.hostname.endsWith('.localhost')
        || target.hostname === '127.0.0.1' || target.hostname === '[::1]'
      if (target.protocol !== 'https:' && !loopback) {
        throw new TypeError('Bearer tokens require HTTPS except for loopback development servers')
      }
    }
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(this.defaultHeaders)
    new Headers(init.headers).forEach((value, key) => headers.set(key, value))
    if (this.token) headers.set('authorization', `Bearer ${this.token}`)
    if (init.body !== undefined && !headers.has('content-type')) headers.set('content-type', 'application/json')
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers,
      credentials: init.credentials ?? this.credentials,
    })
    if (!response.ok) {
      let body: ApiErrorBody = {}
      try { body = await response.json() as ApiErrorBody } catch { /* non-JSON errors retain status */ }
      throw new SubpolarApiError(response.status, body, response.statusText || 'Subpolar request failed')
    }
    if (response.status === 204) return undefined as T
    return await response.json() as T
  }

  private json(method: string, body?: unknown): RequestInit {
    return { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }
  }

  capabilities(): Promise<Capabilities> { return this.request('/api/v1/capabilities') }
  health(): Promise<Health> { return this.request('/api/v1/health') }

  authConfig(): Promise<AuthConfig> { return this.request('/api/auth/config') }
  authSession(): Promise<AuthSession> { return this.request('/api/auth/session') }
  signIn(email: string, password: string): Promise<SignInResponse> {
    return this.request('/api/auth/sign-in/email', this.json('POST', { email, password }))
  }
  signUp(name: string, email: string, password: string): Promise<SignInResponse> {
    return this.request('/api/auth/sign-up/email', this.json('POST', { name, email, password }))
  }
  signOut(): Promise<{ success: boolean }> { return this.request('/api/auth/sign-out', this.json('POST')) }
  changePassword(currentPassword: string, newPassword: string): Promise<{ success: boolean }> {
    return this.request('/api/auth/change-password', this.json('PUT', { currentPassword, newPassword }))
  }

  async listAgents(options: { directory?: string } = {}): Promise<Agent[]> {
    const query = new URLSearchParams()
    if (options.directory !== undefined) query.set('directory', options.directory)
    const suffix = query.size ? `?${query}` : ''
    const result = await this.request<{ agents: Agent[] } | Agent[]>(`/api/agents${suffix}`)
    return Array.isArray(result) ? result : result.agents
  }
  async getProviderCatalog(options: { directory?: string; refresh?: boolean; force?: boolean } = {}): Promise<ProviderCatalog> {
    const query = new URLSearchParams()
    if (options.directory !== undefined) query.set('directory', options.directory)
    if (options.refresh !== undefined) query.set('refresh', String(options.refresh))
    if (options.force !== undefined) query.set('force', String(options.force))
    const suffix = query.size ? `?${query}` : ''
    const result = await this.request<{ catalog: ProviderCatalog } | ProviderCatalog>(`/api/providers/catalog${suffix}`)
    return 'catalog' in result ? result.catalog : result
  }
  async listModels(): Promise<ProviderCatalogModel[]> {
    return [...(await this.getProviderCatalog()).models]
  }
  getModelState(): Promise<ProviderModelState> { return this.request('/api/providers/model-state') }
  updateModelState(input: { recent?: ProviderModelSelection; removeRecent?: ProviderModelSelection; favorite?: ProviderModelSelection }): Promise<ProviderModelState> {
    return this.request('/api/providers/model-state', this.json('POST', input))
  }
  addRecentModel(model: ProviderModelSelection): Promise<ProviderModelState> { return this.updateModelState({ recent: model }) }
  removeRecentModel(model: ProviderModelSelection): Promise<ProviderModelState> { return this.updateModelState({ removeRecent: model }) }
  toggleFavoriteModel(model: ProviderModelSelection): Promise<ProviderModelState> { return this.updateModelState({ favorite: model }) }

  async listProjects(): Promise<Project[]> {
    const result = await this.request<{ projects: Project[] }>('/api/projects')
    return result.projects
  }
  async getProject(id: number): Promise<Project> {
    const result = await this.request<{ project: Project }>(`/api/projects/${id}`)
    return result.project
  }
  createProject(input: ProjectInput): Promise<Project> {
    return this.request('/api/projects', this.json('POST', input))
  }
  updateProject(id: number, input: Partial<ProjectInput>): Promise<Project> {
    return this.request(`/api/projects/${id}`, this.json('PATCH', input))
  }
  deleteProject(id: number): Promise<{ ok: boolean }> {
    return this.request(`/api/projects/${id}`, this.json('DELETE'))
  }
  getSettings(): Promise<Settings> { return this.request('/api/settings') }
  updateSettings(preferences: JsonRecord): Promise<Settings> {
    return this.request('/api/settings', this.json('PATCH', { preferences }))
  }
  async listSessions(options: { project?: string; directory?: string; search?: string; order?: 'asc' | 'desc'; limit?: number; cursor?: string } = {}): Promise<SessionList> {
    const query = new URLSearchParams()
    for (const [key, value] of Object.entries(options)) if (value !== undefined) query.set(key, String(value))
    const result = await this.request<SessionList>(`/api/sessions${query.size ? `?${query}` : ''}`)
    return result
  }
  async createSession(input: CreateSessionInput = {}): Promise<Session> {
    const result = await this.request<{ session: Session }>('/api/sessions', this.json('POST', input))
    return result.session
  }
  getSession(id: string): Promise<Session> { return this.request(`/api/sessions/${encodeURIComponent(id)}`) }
  async updateSession(id: string, input: { title?: string; archived?: boolean; tags?: string[]; model?: string }): Promise<Session> {
    const result = await this.request<{ session: Session }>(`/api/sessions/${encodeURIComponent(id)}`, this.json('PATCH', input))
    return result.session
  }
  deleteSession(id: string): Promise<{ ok: boolean }> { return this.request(`/api/sessions/${encodeURIComponent(id)}`, this.json('DELETE')) }
  async messages(id: string): Promise<SessionMessage[]> {
    return (await this.request<{ messages: SessionMessage[] }>(`/api/sessions/${encodeURIComponent(id)}/messages`)).messages
  }
  inspectToolCall(sessionId: string, callId: string): Promise<JsonRecord> {
    return this.request(`/api/sessions/${encodeURIComponent(sessionId)}/tool-calls/${encodeURIComponent(callId)}`)
  }

  sendMessage(id: string, content: string, options: { messageID?: string; metadata?: JsonRecord } = {}): Promise<MessageDelivery> {
    return this.request(`/api/sessions/${encodeURIComponent(id)}/messages`, this.json('POST', { content, ...options }))
  }
  run(id: string, content: string, options: { messageID?: string; metadata?: JsonRecord } = {}): Promise<RunResult> {
    return this.sendMessage(id, content, options).then((delivery) =>
      this.request(`/api/sessions/${encodeURIComponent(id)}/runs`, this.json('POST', { messageID: delivery.messageID })))
  }
  abortRun(id: string): Promise<unknown> { return this.request(`/api/sessions/${encodeURIComponent(id)}/abort`, this.json('POST')) }
  async inspectRun(runId: string): Promise<JsonRecord> {
    const result = await this.request<{ run: JsonRecord }>(`/api/runs/${encodeURIComponent(runId)}`)
    return result.run
  }

  async listTools(): Promise<Tool[]> {
    return (await this.request<{ tools: Tool[] }>('/api/settings/subpolar-tools')).tools
  }
  async listAgentToolPolicies(agentId: string): Promise<AgentToolPolicy[]> {
    return (await this.request<{ policies: AgentToolPolicy[] }>(`/api/settings/agents/${encodeURIComponent(agentId)}/tool-policies`)).policies
  }
  async replaceAgentToolPolicies(agentId: string, policies: Array<Pick<AgentToolPolicy, 'toolId' | 'effect'>>): Promise<AgentToolPolicy[]> {
    return (await this.request<{ policies: AgentToolPolicy[] }>(`/api/settings/agents/${encodeURIComponent(agentId)}/tool-policies`, this.json('PUT', { policies }))).policies
  }
  async approvals(sessionId?: string): Promise<Approval[]> {
    const query = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''
    return this.request(`/api/permission${query}`)
  }
  async inspectApproval(approvalId: string, sessionId?: string): Promise<Approval | undefined> {
    return (await this.approvals(sessionId)).find((approval) => approval.id === approvalId)
  }
  respondToApproval(sessionId: string, approvalId: string, response: 'approve' | 'reject' | 'once' | 'always'): Promise<JsonRecord> {
    return this.request(`/api/session/${encodeURIComponent(sessionId)}/permissions/${encodeURIComponent(approvalId)}`, this.json('POST', { response }))
  }
  worktreeSources(sessionId: string): Promise<WorktreeSources> {
    return this.request(`/api/sessions/${encodeURIComponent(sessionId)}/worktree-sources`)
  }
  createWorktree(projectId: string, input: { approved: true; branch: string; sourceRef: string; expectedSha: string }): Promise<{ worktree: Worktree; repositoryId: string; projectId: number }> {
    return this.request(`/api/projects/${encodeURIComponent(projectId)}/repository/worktrees`, this.json('POST', input))
  }
  taskWorktree(taskId: string): Promise<{ worktree: Worktree }> {
    return this.request(`/api/tasks/${encodeURIComponent(taskId)}/worktree`)
  }
  repository(projectId: string): Promise<JsonRecord> {
    return this.request(`/api/projects/${encodeURIComponent(projectId)}/repository`)
  }
  repositoryStatus(projectId: string): Promise<RepositoryStatusResponse> {
    return this.request(`/api/projects/${encodeURIComponent(projectId)}/repository/status`)
  }

  /** Subscribe to owner-scoped SSE events. The server optionally filters by sessionId. */
  async *events(options: EventStreamOptions = {}): AsyncGenerator<SubpolarEvent> {
    const query = new URLSearchParams()
    if (options.after !== undefined) query.set('after', String(options.after))
    if (options.sessionId) query.set('sessionId', options.sessionId)
    const headers = new Headers(this.defaultHeaders)
    headers.set('accept', 'text/event-stream')
    if (this.token) headers.set('authorization', `Bearer ${this.token}`)
    const response = await this.fetchImpl(`${this.baseUrl}/api/sse/stream${query.size ? `?${query}` : ''}`, {
      method: 'GET', headers, credentials: this.credentials, signal: options.signal,
    })
    if (!response.ok) {
      let body: ApiErrorBody = {}
      try { body = await response.json() as ApiErrorBody } catch { /* leave empty */ }
      throw new SubpolarApiError(response.status, body, response.statusText || 'Event stream failed')
    }
    if (!response.body) throw new Error('Event stream response has no body')
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      while (true) {
        const { value, done } = await reader.read()
        buffer += decoder.decode(value, { stream: !done })
        let boundary: number
        while ((boundary = buffer.search(/\r?\n\r?\n/)) >= 0) {
          const frame = buffer.slice(0, boundary)
          const separator = buffer.slice(boundary).match(/^\r?\n\r?\n/)?.[0] ?? '\n\n'
          buffer = buffer.slice(boundary + separator.length)
          const parsed = parseSseFrame(frame)
          if (parsed) yield parsed
        }
        if (done) break
      }
      if (buffer.trim()) {
        const parsed = parseSseFrame(buffer)
        if (parsed) yield parsed
      }
    } finally {
      await reader.cancel().catch(() => undefined)
      reader.releaseLock()
    }
  }
}

function parseSseFrame(frame: string): SubpolarEvent | undefined {
  if (!frame || frame.startsWith(':')) return undefined
  let id: string | undefined
  let event: string | undefined
  const data: string[] = []
  for (const line of frame.split(/\r?\n/)) {
    if (!line || line.startsWith(':')) continue
    const colon = line.indexOf(':')
    const field = colon < 0 ? line : line.slice(0, colon)
    const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '')
    if (field === 'id') id = value
    else if (field === 'event') event = value
    else if (field === 'data') data.push(value)
  }
  if (!data.length && !event) return undefined
  const rawData = data.join('\n')
  let parsed: unknown = rawData
  if (rawData) {
    try { parsed = JSON.parse(rawData) as unknown } catch { /* SSE permits non-JSON data */ }
  }
  return { ...(id === undefined ? {} : { id }), ...(event === undefined ? {} : { event }), data: parsed, rawData }
}
