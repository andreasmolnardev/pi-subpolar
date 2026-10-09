export type AutomationTrigger =
  | { type: 'manual' }
  | { type: 'schedule'; cron: string; timezone: string }
  | { type: 'webhook'; credentialRef: string }
  | { type: 'event'; eventType: string; where?: string }

export type AutomationAction =
  | { id: string; type: 'store'; when?: string }
  | { id: string; type: 'notification'; titleTemplate: string; bodyTemplate: string; when?: string }
  | { id: string; type: 'webhook'; url: string; method?: 'POST' | 'PUT'; credentialRef?: string; bodyTemplate?: string; when?: string }
  | { id: string; type: 'tool'; toolId: string; inputTemplate: string; when?: string }

export interface AutomationDefinition {
  id: string
  ownerId?: string
  name: string
  description?: string
  enabled: boolean
  agentId: string
  promptTemplate: string
  projectId?: string | null
  executionConfig?: Record<string, unknown>
  trigger: AutomationTrigger
  actions: AutomationAction[]
  createdAt: string
  updatedAt: string
  lastExecutionAt?: string | null
  nextExecutionAt?: string | null
  lastStatus?: AutomationExecutionStatus | null
}

export type CreateAutomationInput = Omit<AutomationDefinition,
  'id' | 'ownerId' | 'createdAt' | 'updatedAt' | 'lastExecutionAt' | 'nextExecutionAt' | 'lastStatus'>
export type UpdateAutomationInput = Partial<CreateAutomationInput>

export type AutomationExecutionStatus =
  | 'pending'
  | 'running'
  | 'waiting_approval'
  | 'processing_output'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | 'unknown'

export interface AutomationActionExecution {
  id: string
  actionId: string
  type: string
  status: 'pending' | 'running' | 'completed' | 'failed' | 'unknown' | 'skipped'
  result?: unknown
  error?: { code: string; message: string } | string | null
  startedAt?: string | null
  finishedAt?: string | null
}

export interface AutomationExecution {
  id: string
  automationId: string
  ownerId?: string
  agentId: string
  triggerOccurrenceId?: string
  trigger?: unknown
  resolvedInput?: unknown
  canonicalRunId?: string | null
  canonicalSessionId?: string | null
  projectId?: number | string | null
  status: AutomationExecutionStatus
  output?: { text?: string; structured?: unknown } | null
  error?: { code: string; message: string } | string | null
  actions?: AutomationActionExecution[]
  createdAt: string
  startedAt?: string | null
  finishedAt?: string | null
}

export interface AutomationListResponse { automations: AutomationDefinition[] }
export interface ManagedWebhookCredential {
  credentialRef: string
  url: string
  /** Returned only when generated or explicitly rotated; never persisted by the client. */
  secret: string
}
export interface AutomationResponse { automation: AutomationDefinition; webhook?: ManagedWebhookCredential }
export interface WebhookSecretResponse { webhook: ManagedWebhookCredential }
export interface AutomationExecutionListResponse { executions: AutomationExecution[] }
export interface AutomationExecutionResponse { execution: AutomationExecution }

export class SubpolarClientError extends Error {
  readonly status: number
  readonly code?: string

  constructor(message: string, status: number, code?: string) {
    super(message)
    this.name = 'SubpolarClientError'
    this.status = status
    this.code = code
  }
}

export interface SubpolarClientOptions {
  fetch?: typeof fetch
  apiPrefix?: string
}

/** Typed client for Subpolar's authenticated public API. */
export class SubpolarClient {
  private readonly baseUrl: string
  private readonly requestFetch: typeof fetch
  private readonly apiPrefix: string

  constructor(baseUrl = '', options: SubpolarClientOptions = {}) {
    this.baseUrl = baseUrl
    this.requestFetch = options.fetch ?? globalThis.fetch.bind(globalThis)
    this.apiPrefix = (options.apiPrefix ?? '/api/v1').replace(/\/$/, '')
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await this.requestFetch(`${this.baseUrl.replace(/\/$/, '')}${this.apiPrefix}${path}`, {
      credentials: 'include',
      ...init,
      headers: {
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...init?.headers,
      },
    })
    const text = await response.text()
    let data: unknown
    try { data = text ? JSON.parse(text) : undefined } catch { data = undefined }
    if (!response.ok) {
      const error = data && typeof data === 'object' ? data as Record<string, unknown> : {}
      throw new SubpolarClientError(
        typeof error.error === 'string' ? error.error : typeof error.message === 'string' ? error.message : `Request failed (${response.status})`,
        response.status,
        typeof error.code === 'string' ? error.code : undefined,
      )
    }
    return data as T
  }

  listAutomations(): Promise<AutomationListResponse> {
    return this.request('/automations')
  }

  getAutomation(id: string): Promise<AutomationResponse> {
    return this.request(`/automations/${encodeURIComponent(id)}`)
  }

  createAutomation(input: CreateAutomationInput): Promise<AutomationResponse> {
    return this.request('/automations', { method: 'POST', body: JSON.stringify(input) })
  }

  updateAutomation(id: string, input: UpdateAutomationInput): Promise<AutomationResponse> {
    return this.request(`/automations/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(input) })
  }

  deleteAutomation(id: string): Promise<void> {
    return this.request(`/automations/${encodeURIComponent(id)}`, { method: 'DELETE' })
  }

  enableAutomation(id: string): Promise<AutomationResponse> {
    return this.request(`/automations/${encodeURIComponent(id)}/enable`, { method: 'POST' })
  }

  disableAutomation(id: string): Promise<AutomationResponse> {
    return this.request(`/automations/${encodeURIComponent(id)}/disable`, { method: 'POST' })
  }

  rotateWebhookSecret(id: string): Promise<WebhookSecretResponse> {
    return this.request(`/automations/${encodeURIComponent(id)}/webhook-secret`, { method: 'POST' })
  }

  runAutomation(id: string, input?: { payload?: unknown; idempotencyKey?: string }): Promise<AutomationExecutionResponse> {
    return this.request(`/automations/${encodeURIComponent(id)}/run`, {
      method: 'POST',
      body: JSON.stringify(input ?? {}),
    })
  }

  listExecutions(id: string, params: { limit?: number } = {}): Promise<AutomationExecutionListResponse> {
    const query = new URLSearchParams()
    if (params.limit !== undefined) query.set('limit', String(params.limit))
    const suffix = query.size ? `?${query.toString()}` : ''
    return this.request(`/automations/${encodeURIComponent(id)}/executions${suffix}`)
  }

  getExecution(automationId: string, id: string): Promise<AutomationExecutionResponse> {
    return this.request(`/automations/${encodeURIComponent(automationId)}/executions/${encodeURIComponent(id)}`)
  }

  cancelExecution(automationId: string, id: string): Promise<AutomationExecutionResponse> {
    return this.request(`/automations/${encodeURIComponent(automationId)}/executions/${encodeURIComponent(id)}/cancel`, { method: 'POST' })
  }
}
