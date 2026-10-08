import { API_BASE_URL } from "@/config"
import type { components, operations } from "./opencode-types"
import { fetchWrapper, FetchError } from "./fetchWrapper"

export type ProviderLoginType = 'api_key' | 'oauth'

export type ProviderLoginPrompt =
  | { type: 'text'; message: string; placeholder?: string }
  | { type: 'secret'; message: string; placeholder?: string }
  | {
      type: 'select'
      message: string
      options: readonly { id: string; label: string; description?: string }[]
    }
  | { type: 'manual_code'; message: string; placeholder?: string }

export type ProviderLoginEvent =
  | { sequence: number; timestamp: number; type: 'prompt'; promptId: string; prompt: ProviderLoginPrompt }
  | { sequence: number; timestamp: number; type: 'info'; message: string; links?: readonly { url: string; label?: string }[] }
  | { sequence: number; timestamp: number; type: 'auth_url'; url: string; instructions?: string }
  | { sequence: number; timestamp: number; type: 'device_code'; userCode: string; verificationUri: string; intervalSeconds?: number; expiresInSeconds?: number }
  | { sequence: number; timestamp: number; type: 'progress'; message: string }

export type ProviderLoginPhase = 'pending' | 'completed' | 'failed' | 'cancelled' | 'expired'

export interface ProviderLoginFlowStatus {
  flowId: string
  providerInstanceId: string
  runtimeProviderId: string
  type: ProviderLoginType
  phase: ProviderLoginPhase
  createdAt: number
  updatedAt: number
  expiresAt: number
  currentPrompt?: { promptId: string; prompt: ProviderLoginPrompt }
  result?: {
    flowId: string
    providerInstanceId: string
    runtimeProviderId: string
    type: ProviderLoginType
    credentialType: ProviderLoginType
    completedAt: number
  }
  error?: { code: 'LOGIN_FAILED'; message: 'Provider login failed.' }
}

export interface ProviderLoginFlowEvents {
  flowId: string
  events: readonly ProviderLoginEvent[]
  nextSequence: number
}

export interface StartProviderLoginInput {
  providerInstanceId: string
  type: ProviderLoginType
  /** Optional account label; the server may use it when creating a new instance. */
  displayName?: string
}

function handleApiError(error: unknown, context: string): never {
  if (error instanceof FetchError) {
    throw new Error(`${context}: ${error.message}`)
  }
  throw error
}

function unwrap<T>(response: T | { flow: T } | { status: T }): T {
  if (typeof response === 'object' && response !== null) {
    if ('flow' in response) return response.flow
    if ('status' in response) return response.status
  }
  return response as T
}

const loginFlowPath = (flowId: string) => `${API_BASE_URL}/api/providers/login-flows/${encodeURIComponent(flowId)}`

/** Native Pi provider login interaction API for both API keys and OAuth/subscriptions. */
export const providerLoginFlowApi = {
  start: async (input: StartProviderLoginInput): Promise<ProviderLoginFlowStatus> => {
    try {
      const response = await fetchWrapper<ProviderLoginFlowStatus | { flow: ProviderLoginFlowStatus }>(`${API_BASE_URL}/api/providers/login-flows`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      })
      return unwrap(response)
    } catch (error) {
      handleApiError(error, 'Provider login could not start')
    }
  },

  status: async (flowId: string): Promise<ProviderLoginFlowStatus> => {
    try {
      const response = await fetchWrapper<ProviderLoginFlowStatus | { status: ProviderLoginFlowStatus }>(loginFlowPath(flowId))
      return unwrap(response)
    } catch (error) {
      handleApiError(error, 'Could not read provider login status')
    }
  },

  events: async (flowId: string, after = 0, limit = 100): Promise<ProviderLoginFlowEvents> => {
    try {
      return await fetchWrapper<ProviderLoginFlowEvents>(`${loginFlowPath(flowId)}/events`, { params: { after, limit } })
    } catch (error) {
      handleApiError(error, 'Could not read provider login events')
    }
  },

  respond: async (flowId: string, promptId: string, value: string): Promise<ProviderLoginFlowStatus> => {
    try {
      const response = await fetchWrapper<ProviderLoginFlowStatus | { status: ProviderLoginFlowStatus }>(`${loginFlowPath(flowId)}/respond`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ promptId, value }),
      })
      return unwrap(response)
    } catch (error) {
      handleApiError(error, 'Provider login prompt failed')
    }
  },

  cancel: async (flowId: string): Promise<ProviderLoginFlowStatus> => {
    try {
      const response = await fetchWrapper<ProviderLoginFlowStatus | { status: ProviderLoginFlowStatus }>(`${loginFlowPath(flowId)}/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
      return unwrap(response)
    } catch (error) {
      handleApiError(error, 'Provider login cancellation failed')
    }
  },
}

export const providerLoginApi = providerLoginFlowApi

// Kept as a compatibility adapter for the old dialogs. New UI uses providerLoginFlowApi.
type OpenCodeAuthorizeRequest = NonNullable<operations["provider.oauth.authorize"]["requestBody"]>["content"]["application/json"]
export type OAuthAuthorizeResponse = components["schemas"]["ProviderAuthAuthorization"]
export type OAuthCallbackRequest = NonNullable<operations["provider.oauth.callback"]["requestBody"]>["content"]["application/json"]
export type ProviderAuthMethod = components["schemas"]["ProviderAuthMethod"]

export interface ProviderAuthMethods {
  [providerId: string]: ProviderAuthMethod[]
}

export const oauthApi = {
  authorize: async (providerId: string, method: number, inputs?: OpenCodeAuthorizeRequest["inputs"]): Promise<OAuthAuthorizeResponse> => {
    try {
      return await fetchWrapper(`${API_BASE_URL}/api/oauth/${encodeURIComponent(providerId)}/oauth/authorize`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, inputs }),
      })
    } catch (error) { handleApiError(error, "OAuth authorization failed") }
  },

  callback: async (providerId: string, request: OAuthCallbackRequest): Promise<boolean> => {
    try {
      return await fetchWrapper(`${API_BASE_URL}/api/oauth/${encodeURIComponent(providerId)}/oauth/callback`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request),
      })
    } catch (error) { handleApiError(error, "OAuth callback failed") }
  },

  getAuthMethods: async (): Promise<ProviderAuthMethods> => {
    try {
      const { providers, ...rest } = await fetchWrapper<{ providers?: ProviderAuthMethods } & ProviderAuthMethods>(`${API_BASE_URL}/api/oauth/auth-methods`)
      return providers || rest
    } catch (error) { handleApiError(error, "Failed to get provider auth methods") }
  },
}
