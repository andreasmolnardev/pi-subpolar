import type { paths } from './opencode-types'
import { FetchError, fetchWrapper, fetchWrapperVoid } from './fetchWrapper'

type SessionListResponse = paths['/session']['get']['responses']['200']['content']['application/json']
type SessionResponse = paths['/session/{sessionID}']['get']['responses']['200']['content']['application/json']
type SessionListParams = NonNullable<paths['/session']['get']['parameters']['query']> & {
  roots?: boolean
}
type CreateSessionRequest = NonNullable<paths['/session']['post']['requestBody']>['content']['application/json']
type NewSessionCreateRequest = Omit<CreateSessionRequest, 'permission'> & {
  agent?: string
  model?: string
  thinking?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
  permission?: 'ask' | 'none' | 'allow_all'
}
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

type LegacySession = SessionListResponse[number] & {
  profile?: string
  model?: string
  permissionOverride?: 'ask' | 'none' | 'allow_all'
  revert?: SessionResponse['revert']
}

type SessionPageParams = { limit?: number; order?: 'asc' | 'desc'; search?: string; cursor?: string }
type SessionPage = { items: LegacySession[]; nextCursor?: string; page?: { limit: number; order: 'asc' | 'desc'; hasNext: boolean; nextCursor?: string } }

export type { SendPromptResponse, SendCommandResponse, LspStatus }

export type QueueEntry = {
  clientId: string
  sessionId: string
  content: string
  kind: 'steering' | 'follow_up'
  state: 'steering' | 'enqueued' | 'delivered' | 'failed' | 'cancelled'
  position: number
  createdAt: number
  updatedAt: number
  error?: string
}

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

  private toLegacySession(session: { id: string; title?: string | null; directory?: string | null; createdAt?: number; updatedAt?: number; projectId?: number | null; archived?: boolean; profile?: string; model?: string; permissionOverride?: 'ask' | 'none' | 'allow_all'; revert?: SessionResponse['revert'] }) {
    const created = session.createdAt ?? Date.now()
    const updated = session.updatedAt ?? created
    return {
      id: session.id,
      projectID: session.projectId ? String(session.projectId) : 'default',
      directory: session.directory ?? this.directory ?? '',
      title: session.title || 'Untitled Session',
      version: 'pi',
      time: { created, updated },
      archived: session.archived ?? false,
      ...(session.profile ? { profile: session.profile } : {}),
      ...(session.model ? { model: session.model } : {}),
      ...(session.permissionOverride ? { permissionOverride: session.permissionOverride } : {}),
      ...(session.revert ? { revert: session.revert } : {}),
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
    const response = await fetchWrapper<{ sessions: Array<{ id: string; title?: string | null; directory?: string | null; createdAt?: number; updatedAt?: number; projectId?: number | null }>; nextCursor?: string; page?: SessionPage['page'] }>(`${this.nativeBaseURL}/sessions`, { params: queryParams })
    return {
      items: response.sessions.map((item) => this.toLegacySession(item)),
      nextCursor: response.nextCursor ?? response.page?.nextCursor,
      page: response.page,
    }
  }

  async getSession(sessionID: string): Promise<LegacySession> {
    const session = await fetchWrapper<{ id: string; title?: string | null; directory?: string | null; createdAt?: number; updatedAt?: number; projectId?: number | null; profile?: string; model?: string; permissionOverride?: 'ask' | 'none' | 'allow_all'; revert?: SessionResponse['revert'] }>(`${this.nativeBaseURL}/sessions/${sessionID}`, { params: this.getParams() })
    return this.toLegacySession(session)
  }

  async createSession(data: NewSessionCreateRequest): Promise<LegacySession> {
    const response = await fetchWrapper<{ session: { id: string; runtime: string; runtimeSessionId: string | null; title?: string; directory?: string; profile?: string; model?: string; permissionOverride?: 'ask' | 'none' | 'allow_all' } }>(`${this.nativeBaseURL}/sessions`, {
      method: 'POST',
      params: this.getParams(),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...data, directory: this.directory, runtime: 'pi' }),
    })
    return this.toLegacySession({ ...response.session, title: response.session.title ?? 'Untitled Session', directory: response.session.directory ?? this.directory })
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

  async archiveSession(sessionID: string, archived: boolean) {
    return fetchWrapper(`${this.nativeBaseURL}/sessions/${sessionID}`, {
      method: 'PATCH',
      params: this.getParams(),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ archived }),
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
    const response = await fetchWrapper<{ messages: Array<{ id?: string; role?: string; content?: string; createdAt?: number; metadata?: Record<string, unknown>; info?: MessageListResponse[number]['info']; parts?: MessageListResponse[number]['parts'] }> }>(`${this.nativeBaseURL}/sessions/${sessionID}/messages`, { params: this.getParams() })
    if (response.messages.every((message) => message.info && Array.isArray(message.parts))) {
      return response.messages.map((message) => ({ info: message.info!, parts: message.parts! })) as MessageListResponse
    }
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
      const parts = (assistantParts.length > 0
         ? assistantParts.flatMap((part, index): any[] => {
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
        ) as MessageListResponse[number]['parts']
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
    const delivery = await this.createNativeMessageAndRun(sessionID, data)
    return delivery as unknown as SendPromptResponse
  }

  async sendPromptAsync(sessionID: string, data: SendPromptAsyncRequest): Promise<void> {
    await this.createNativeMessageAndRun(sessionID, data)
  }

  async steer(sessionID: string, data: { content: string; clientId: string }) {
    return fetchWrapper<{ entry: QueueEntry }>(`${this.nativeBaseURL}/sessions/${sessionID}/steer`, {
      method: 'POST', params: this.getParams(), headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data), timeout: 0,
    })
  }

  async listQueue(sessionID: string) {
    const response = await fetchWrapper<{ entries: QueueEntry[] }>(`${this.nativeBaseURL}/sessions/${sessionID}/queue`, { params: this.getParams() })
    return response.entries
  }

  async enqueueFollowUp(sessionID: string, data: { content: string; clientId: string }) {
    return fetchWrapper<{ entry: QueueEntry }>(`${this.nativeBaseURL}/sessions/${sessionID}/queue`, {
      method: 'POST', params: this.getParams(), headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data), timeout: 0,
    })
  }

  async removeQueueEntry(sessionID: string, clientId: string) {
    return fetchWrapper<{ entry: QueueEntry }>(`${this.nativeBaseURL}/sessions/${sessionID}/queue/${encodeURIComponent(clientId)}`, { method: 'DELETE', params: this.getParams() })
  }

  async retryQueueEntry(sessionID: string, clientId: string) {
    return fetchWrapper<{ entry: QueueEntry }>(`${this.nativeBaseURL}/sessions/${sessionID}/queue/${encodeURIComponent(clientId)}`, { method: 'POST', params: this.getParams() })
  }

  async reorderQueueEntry(sessionID: string, clientId: string, position: number) {
    return fetchWrapper<{ entry: QueueEntry }>(`${this.nativeBaseURL}/sessions/${sessionID}/queue/${encodeURIComponent(clientId)}`, {
      method: 'PATCH', params: this.getParams(), headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ position }),
    })
  }

  async clearQueue(sessionID: string) {
    return fetchWrapper<{ entries: QueueEntry[] }>(`${this.nativeBaseURL}/sessions/${sessionID}/queue/clear`, { method: 'POST', params: this.getParams() })
  }

  private async createNativeMessageAndRun(sessionID: string, data: SendPromptRequest | SendPromptAsyncRequest): Promise<{ messageID: string; state: string }> {
    const requestedAt = Date.now()
    const prompt = typeof data === 'object' && data && 'parts' in data && Array.isArray(data.parts)
      ? data.parts.map((part) => 'text' in part && typeof part.text === 'string' ? part.text : '').join('\n')
      : typeof data === 'object' && data && 'text' in data
      ? String(data.text ?? '')
      : ''
    const model = typeof data === 'object' && data && 'model' in data ? data.model : undefined
    const agent = typeof data === 'object' && data && 'agent' in data ? data.agent : undefined
    const permission = typeof data === 'object' && data && 'permission' in data ? data.permission : undefined
    const messageID = typeof data === 'object' && data && 'messageID' in data ? data.messageID : undefined
    const message = await fetchWrapper<{ messageID?: string; state?: string }>(`${this.nativeBaseURL}/sessions/${sessionID}/messages`, {
      method: 'POST',
      params: this.getParams(),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        role: 'user',
        content: prompt,
        createdAt: requestedAt,
        ...(messageID ? { messageID } : {}),
        metadata: {
          ...(agent ? { agent } : {}),
          ...(model ? { model } : {}),
          ...(permission ? { permission } : {}),
        },
      }),
      timeout: 0,
    })
    const serverMessageID = message.messageID ?? (typeof data === 'object' && data && 'messageID' in data && typeof data.messageID === 'string' ? data.messageID : undefined)
    const deliveryMessageID = serverMessageID ?? `native_${Date.now()}_${Math.random()}`
    const delivery = await fetchWrapper<Record<string, unknown>>(`${this.nativeBaseURL}/sessions/${sessionID}/runs`, {
      method: 'POST',
      params: this.getParams(),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        runtime: 'pi',
        agentId: agent ?? 'default',
        model,
        permissionOverride: permission,
        messageID: deliveryMessageID,
        requestedAt,
      }),
      timeout: 0,
    })
    const metadata = isRecord(delivery.delivery) ? delivery.delivery : delivery
    const state = typeof metadata.state === 'string' ? metadata.state : 'completed'
    if (state === 'interrupted' || state === 'unknown') {
      const error = isRecord(metadata.error) ? metadata.error : {}
      const message = typeof error.message === 'string'
        ? error.message
        : 'This delivery did not complete. It was not retried automatically. Resend the prompt to try again.'
      throw new FetchError(
        message,
        409,
        typeof error.code === 'string' ? error.code : `DELIVERY_${state.toUpperCase()}`,
        undefined,
        { delivery: metadata, recoverable: true },
      )
    }
    return { messageID: typeof metadata.messageID === 'string' ? metadata.messageID : deliveryMessageID, state }
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
    try {
      return await fetchWrapper<QuestionListResponse>(`${this.nativeBaseURL}/question`, {
        params: this.getParams(),
      })
    } catch (error) {
      // The bridge receives questions over SSE; older bridge versions do not
      // expose the optional polling endpoint used for initial reconciliation.
      if (error instanceof FetchError && error.statusCode === 404) return []
      throw error
    }
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
