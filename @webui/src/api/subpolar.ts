import type { paths } from './opencode-types'
import { fetchWrapper, fetchWrapperVoid } from './fetchWrapper'

type SessionListResponse = paths['/session']['get']['responses']['200']['content']['application/json']
type SessionResponse = paths['/session/{sessionID}']['get']['responses']['200']['content']['application/json']
type SessionListParams = NonNullable<paths['/session']['get']['parameters']['query']> & {
  roots?: boolean
}
type CreateSessionRequest = NonNullable<paths['/session']['post']['requestBody']>['content']['application/json']
type MessageListResponse = paths['/session/{sessionID}/message']['get']['responses']['200']['content']['application/json']
type SendPromptRequest = NonNullable<paths['/session/{sessionID}/message']['post']['requestBody']>['content']['application/json']
type SendPromptAsyncRequest = NonNullable<paths['/session/{sessionID}/prompt_async']['post']['requestBody']>['content']['application/json']
type ConfigResponse = paths['/config']['get']['responses']['200']['content']['application/json']
type CommandListResponse = paths['/command']['get']['responses']['200']['content']['application/json']
type CommandRequest = NonNullable<paths['/session/{sessionID}/command']['post']['requestBody']>['content']['application/json']
type SendCommandResponse = paths['/session/{sessionID}/command']['post']['responses']['200']['content']['application/json']
type ShellRequest = NonNullable<paths['/session/{sessionID}/shell']['post']['requestBody']>['content']['application/json']
type AgentListResponse = paths['/agent']['get']['responses']['200']['content']['application/json']
type PermissionListResponse = paths['/permission']['get']['responses']['200']['content']['application/json']
type QuestionListResponse = paths['/question']['get']['responses']['200']['content']['application/json']
type SendPromptResponse = paths['/session/{sessionID}/message']['post']['responses']['200']['content']['application/json']
type LspStatusResponse = paths['/lsp']['get']['responses']['200']['content']['application/json']
type LspStatus = LspStatusResponse[number]

type LegacySession = SessionListResponse[number]

type SessionPageParams = { limit?: number; order?: 'asc' | 'desc'; search?: string; cursor?: string }
type SessionPage = { items: LegacySession[]; nextCursor?: string }

export type { SendPromptResponse, SendCommandResponse, LspStatus }

function getUserMessageMetadata(metadata: Record<string, unknown> | undefined) {
  const model = metadata?.model && typeof metadata.model === 'object'
    ? metadata.model as { providerID?: unknown; modelID?: unknown }
    : undefined
  return {
    ...(typeof metadata?.agent === 'string' ? { agent: metadata.agent } : {}),
    ...(model && typeof model.providerID === 'string' && typeof model.modelID === 'string'
      ? { model: { providerID: model.providerID, modelID: model.modelID } }
      : {}),
    ...(typeof metadata?.permission === 'string' ? { permission: metadata.permission } : {}),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export class SubpolarClient {
  private baseURL: string
  private directory?: string

  constructor(baseURL: string, directory?: string) {
    this.baseURL = baseURL
    this.directory = directory
  }

  setDirectory(directory: string) {
    this.directory = directory
  }

  private getParams(params?: Record<string, string | number | boolean | undefined>) {
    if (!this.directory) return params
    return { ...params, directory: this.directory }
  }

  private get nativeBaseURL() {
    return this.baseURL.replace(/\/api\/opencode$/, '/api')
  }

  private toLegacySession(session: { id: string; title?: string | null; directory?: string | null; createdAt?: number; updatedAt?: number; projectId?: number | null }) {
    const created = session.createdAt ?? Date.now()
    const updated = session.updatedAt ?? created
    return {
      id: session.id,
      projectID: session.projectId ? String(session.projectId) : 'default',
      directory: session.directory ?? this.directory ?? '',
      title: session.title || 'Untitled Session',
      version: 'pi',
      time: { created, updated },
    } as LegacySession
  }

  async listSessions(params?: SessionListParams) {
    const response = await fetchWrapper<{ sessions: Array<{ id: string; title?: string | null; directory?: string | null; createdAt?: number; updatedAt?: number; projectId?: number | null }> }>(`${this.nativeBaseURL}/sessions`, { params: this.getParams(params) })
    return response.sessions.map(session => this.toLegacySession(session)) as SessionListResponse
  }

  async listSessionsPage(params?: SessionPageParams): Promise<SessionPage> {
    const isCursorRequest = params?.cursor !== undefined
    const queryParams = isCursorRequest
      ? this.getParams({ cursor: params.cursor })
      : this.getParams({
          ...(params?.limit !== undefined && { limit: params.limit }),
          ...(params?.order !== undefined && { order: params.order }),
          ...(params?.search !== undefined && { search: params.search }),
        })
    const response = await fetchWrapper<{ sessions: Array<{ id: string; title?: string | null; directory?: string | null; createdAt?: number; updatedAt?: number; projectId?: number | null }> }>(`${this.nativeBaseURL}/sessions`, { params: queryParams })
    return {
      items: response.sessions.map((item) => this.toLegacySession(item)),
    }
  }

  async getSession(sessionID: string) {
    const session = await fetchWrapper<{ id: string; title?: string | null; directory?: string | null; createdAt?: number; updatedAt?: number; projectId?: number | null }>(`${this.nativeBaseURL}/sessions/${sessionID}`, { params: this.getParams() })
    return this.toLegacySession(session) as SessionResponse
  }

  async createSession(data: CreateSessionRequest) {
    const response = await fetchWrapper<{ session: { id: string; runtime: string; runtimeSessionId: string | null } }>(`${this.nativeBaseURL}/sessions`, {
      method: 'POST',
      params: this.getParams(),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...data, directory: this.directory, runtime: 'pi' }),
    })
    return this.toLegacySession({ id: response.session.id, title: 'Untitled Session', directory: this.directory }) as SessionResponse
  }

  async deleteSession(sessionID: string) {
    return fetchWrapperVoid(`${this.nativeBaseURL}/sessions/${sessionID}`, {
      method: 'DELETE',
      params: this.getParams(),
    })
  }

  async deleteWorkspace(workspaceID: string) {
    return fetchWrapperVoid(`${this.baseURL}/experimental/workspace/${workspaceID}`, {
      method: 'DELETE',
      params: this.getParams(),
    })
  }

  async updateSession(sessionID: string, data: { title?: string }) {
    return fetchWrapper(`${this.nativeBaseURL}/sessions/${sessionID}`, {
      method: 'PATCH',
      params: this.getParams(),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
  }

  async forkSession(sessionID: string, messageID?: string) {
    return fetchWrapper<SessionResponse>(`${this.baseURL}/session/${sessionID}/fork`, {
      method: 'POST',
      params: this.getParams(),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageID }),
    })
  }

  async abortSession(sessionID: string) {
    return fetchWrapper(`${this.nativeBaseURL}/runs/${sessionID}/cancel`, {
      method: 'POST',
      params: this.getParams(),
    })
  }

  async listMessages(sessionID: string) {
    const response = await fetchWrapper<{ messages: Array<{ id: string; role: string; content: string; createdAt: number; metadata?: Record<string, unknown> }> }>(`${this.nativeBaseURL}/sessions/${sessionID}/messages`, { params: this.getParams() })
    return response.messages.map(message => {
      const userMetadata = message.role === 'user' ? getUserMessageMetadata(message.metadata) : {}
      const reasoning = typeof message.metadata?.reasoning === 'string' ? message.metadata.reasoning : ''
      const completedAt = typeof message.metadata?.completedAt === 'number' ? message.metadata.completedAt : undefined
      const modelID = typeof message.metadata?.modelID === 'string' ? message.metadata.modelID : undefined
      const finishReason = typeof message.metadata?.finishReason === 'string' ? message.metadata.finishReason : 'stop'
      const usage = message.metadata?.usage && typeof message.metadata.usage === 'object' ? message.metadata.usage as {
        input?: number
        output?: number
        reasoning?: number
        cacheRead?: number
        cacheWrite?: number
        cost?: { total?: number }
      } : undefined
      const assistantParts = Array.isArray(message.metadata?.assistantParts)
        ? message.metadata.assistantParts.filter(isRecord)
        : []
      const tools = Array.isArray(message.metadata?.tools) ? message.metadata.tools : []
      const parts = assistantParts.length > 0
        ? assistantParts.flatMap((part, index) => {
            const partType = part.type
            if (partType === 'text' && typeof part.text === 'string') {
              return [{
                id: typeof part.id === 'string' ? part.id : `${message.id}-text-${index}`,
                sessionID,
                messageID: message.id,
                type: 'text' as const,
                text: part.text,
              }]
            }
            if (partType === 'reasoning' && typeof part.text === 'string') {
              const time = isRecord(part.time) && typeof part.time.start === 'number'
                ? { start: part.time.start }
                : { start: message.createdAt }
              return [{
                id: typeof part.id === 'string' ? part.id : `${message.id}-reasoning-${index}`,
                sessionID,
                messageID: message.id,
                type: 'reasoning' as const,
                text: part.text,
                time,
              }]
            }
            if (partType === 'tool') {
              const state = isRecord(part.state)
                ? part.state
                : { status: 'error', input: {}, error: 'Tool state unavailable', time: { start: message.createdAt, end: message.createdAt } }
              return [{
                id: typeof part.id === 'string' ? part.id : `${message.id}-tool-${index}`,
                sessionID,
                messageID: message.id,
                type: 'tool' as const,
                callID: typeof part.callID === 'string' ? part.callID : `tool-${index}`,
                tool: typeof part.tool === 'string' ? part.tool : 'unknown',
                state,
              }]
            }
            return []
          })
        : [
            ...(reasoning ? [{ id: `${message.id}-reasoning`, sessionID, messageID: message.id, type: 'reasoning' as const, text: reasoning, time: { start: message.createdAt } }] : []),
            ...(message.content ? [{ id: `${message.id}-text`, sessionID, messageID: message.id, type: 'text' as const, text: message.content }] : []),
            ...tools.map((tool, index) => {
              const item = tool && typeof tool === 'object' ? tool as Record<string, unknown> : {}
              const callID = typeof item.callID === 'string' ? item.callID : `tool-${index}`
              return {
                id: `${message.id}-tool-${callID}`,
                sessionID,
                messageID: message.id,
                type: 'tool' as const,
                callID,
                tool: typeof item.tool === 'string' ? item.tool : 'unknown',
                state: item.state && typeof item.state === 'object' ? item.state : { status: 'error', input: {}, error: 'Tool state unavailable', time: { start: message.createdAt, end: message.createdAt } },
              }
            }),
          ]
      return {
        info: {
        id: message.id,
        sessionID,
        role: message.role,
        time: completedAt ? { created: message.createdAt, completed: completedAt } : { created: message.createdAt },
        ...userMetadata,
        ...(modelID ? { modelID } : {}),
      },
        parts: [
          ...parts,
          ...(message.role === 'assistant' && completedAt ? [{
            id: `${message.id}-step-finish`,
            sessionID,
            messageID: message.id,
            type: 'step-finish',
            reason: finishReason,
            cost: usage?.cost?.total ?? 0,
            tokens: {
              input: usage?.input ?? 0,
              output: usage?.output ?? 0,
              reasoning: usage?.reasoning ?? 0,
              cache: {
                read: usage?.cacheRead ?? 0,
                write: usage?.cacheWrite ?? 0,
              },
            },
          }] : []),
        ],
      }
    }) as MessageListResponse
  }

  async sendPrompt(sessionID: string, data: SendPromptRequest): Promise<SendPromptResponse> {
    await this.createNativeMessageAndRun(sessionID, data)
    return { parts: [] } as unknown as SendPromptResponse
  }

  async sendPromptAsync(sessionID: string, data: SendPromptAsyncRequest): Promise<void> {
    await this.createNativeMessageAndRun(sessionID, data)
  }

  private async createNativeMessageAndRun(sessionID: string, data: SendPromptRequest | SendPromptAsyncRequest): Promise<void> {
    const requestedAt = Date.now()
    const prompt = typeof data === 'object' && data && 'parts' in data && Array.isArray(data.parts)
      ? data.parts.map((part) => 'text' in part && typeof part.text === 'string' ? part.text : '').join('\n')
      : typeof data === 'object' && data && 'text' in data
      ? String(data.text ?? '')
      : ''
    const model = typeof data === 'object' && data && 'model' in data ? data.model : undefined
    const agent = typeof data === 'object' && data && 'agent' in data ? data.agent : undefined
    const permission = typeof data === 'object' && data && 'permission' in data ? data.permission : undefined
    await fetchWrapper(`${this.nativeBaseURL}/sessions/${sessionID}/messages`, {
      method: 'POST',
      params: this.getParams(),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        role: 'user',
        content: prompt,
        createdAt: requestedAt,
        metadata: {
          ...(agent ? { agent } : {}),
          ...(model ? { model } : {}),
          ...(permission ? { permission } : {}),
        },
      }),
      timeout: 0,
    })
    await fetchWrapper(`${this.nativeBaseURL}/sessions/${sessionID}/runs`, {
      method: 'POST',
      params: this.getParams(),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        runtime: 'pi',
        agentId: agent ?? 'default',
        model,
        permissionOverride: permission,
        requestedAt,
      }),
      timeout: 0,
    })
  }

  async summarizeSession(sessionID: string, providerID: string, modelID: string) {
    return fetchWrapper(`${this.baseURL}/session/${sessionID}/summarize`, {
      method: 'POST',
      params: this.getParams(),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerID, modelID }),
    })
  }

  async getConfig() {
    return fetchWrapper<ConfigResponse>(`${this.nativeBaseURL}/config`, {
      params: this.getParams(),
    })
  }

  async getLSPStatus() {
    return fetchWrapper<LspStatusResponse>(`${this.nativeBaseURL}/lsp`, {
      params: this.getParams(),
    })
  }

  async updateConfig(config: Partial<ConfigResponse>) {
    return fetchWrapper<ConfigResponse>(`${this.nativeBaseURL}/config`, {
      method: 'PATCH',
      params: this.getParams(),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    })
  }

  async getProviders() {
    return fetchWrapper(`${this.nativeBaseURL}/provider`, {
      params: this.getParams(),
    })
  }

  async getConfigProviders() {
    return fetchWrapper(`${this.nativeBaseURL}/config/providers`, {
      params: this.getParams(),
    })
  }

  async listCommands() {
    return fetchWrapper<CommandListResponse>(`${this.nativeBaseURL}/command`, {
      params: this.getParams(),
    })
  }

  async sendCommand(sessionID: string, data: CommandRequest): Promise<SendCommandResponse> {
    return fetchWrapper<SendCommandResponse>(`${this.baseURL}/session/${sessionID}/command`, {
      method: 'POST',
      params: this.getParams(),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
      timeout: 0,
    })
  }

  async sendShell(sessionID: string, data: ShellRequest) {
    return fetchWrapper(`${this.baseURL}/session/${sessionID}/shell`, {
      method: 'POST',
      params: this.getParams(),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
  }

  async respondToPermission(sessionID: string, permissionID: string, response: 'once' | 'always' | 'reject') {
    return fetchWrapper(`${this.baseURL}/session/${sessionID}/permissions/${permissionID}`, {
      method: 'POST',
      params: this.getParams(),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ response }),
    })
  }

  async listPendingPermissions() {
    return fetchWrapper<PermissionListResponse>(`${this.nativeBaseURL}/permission`, {
      params: this.getParams(),
    })
  }

  async replyToQuestion(requestID: string, answers: string[][]) {
    return fetchWrapper(`${this.baseURL}/question/${requestID}/reply`, {
      method: 'POST',
      params: this.getParams(),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answers }),
    })
  }

  async rejectQuestion(requestID: string) {
    return fetchWrapper(`${this.baseURL}/question/${requestID}/reject`, {
      method: 'POST',
      params: this.getParams(),
    })
  }

  async listPendingQuestions() {
    return fetchWrapper<QuestionListResponse>(`${this.nativeBaseURL}/question`, {
      params: this.getParams(),
    })
  }

  async listAgents() {
    return fetchWrapper<AgentListResponse>(`${this.nativeBaseURL}/agent`, {
      params: this.getParams(),
    })
  }

  async revertMessage(sessionID: string, data: { messageID: string, partID?: string }) {
    return fetchWrapper(`${this.baseURL}/session/${sessionID}/revert`, {
      method: 'POST',
      params: this.getParams(),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
  }

  async unrevertSession(sessionID: string) {
    return fetchWrapper(`${this.baseURL}/session/${sessionID}/unrevert`, {
      method: 'POST',
      params: this.getParams(),
    })
  }

  async getSessionStatuses() {
    return fetchWrapper<Record<string, { type: 'idle' } | { type: 'busy' } | { type: 'retry'; attempt: number; message: string; next: number }>>(`${this.nativeBaseURL}/sessions/status`, {
      params: this.getParams(),
    })
  }

  async listRunEvents(runID: string) {
    return fetchWrapper<{ events: Array<{ id: string; type: string; payload: unknown; createdAt: number }> }>(`${this.nativeBaseURL}/runs/${encodeURIComponent(runID)}/events`, {
      params: this.getParams(),
    })
  }

  getRunEventStreamURL(runID: string) {
    const base = this.nativeBaseURL.startsWith('http')
      ? this.nativeBaseURL
      : `${window.location.origin}${this.nativeBaseURL}`
    const url = new URL(`${base}/runs/${encodeURIComponent(runID)}/events/stream`)
    if (this.directory) {
      url.searchParams.set('directory', this.directory)
    }
    return url.toString()
  }

  getEventSourceURL() {
    const base = this.nativeBaseURL.startsWith('http')
      ? this.nativeBaseURL
      : `${window.location.origin}${this.nativeBaseURL}`
    const url = new URL(`${base}/sse`)
    if (this.directory) {
      url.searchParams.set('directory', this.directory)
    }
    return url.toString()
  }
}

export const createSubpolarClient = (baseURL: string, directory?: string) => {
  return new SubpolarClient(baseURL, directory)
}
