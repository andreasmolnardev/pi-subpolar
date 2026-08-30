import { API_BASE_URL } from "@/config"
import type { components, operations } from "./opencode-types"
import { fetchWrapper, FetchError } from "./fetchWrapper"

type OpenCodeAuthorizeRequest = NonNullable<operations["provider.oauth.authorize"]["requestBody"]>["content"]["application/json"]

export type OAuthAuthorizeResponse = components["schemas"]["ProviderAuthAuthorization"]

export type OAuthCallbackRequest = NonNullable<operations["provider.oauth.callback"]["requestBody"]>["content"]["application/json"]

export type ProviderAuthMethod = components["schemas"]["ProviderAuthMethod"]

export interface ProviderAuthMethods {
  [providerId: string]: ProviderAuthMethod[]
}

function handleApiError(error: unknown, context: string): never {
  if (error instanceof FetchError) {
    throw new Error(`${context}: ${error.message}`)
  }
  throw error
}

export const oauthApi = {
  authorize: async (providerId: string, method: number, inputs?: OpenCodeAuthorizeRequest["inputs"]): Promise<OAuthAuthorizeResponse> => {
    try {
      return await fetchWrapper(`${API_BASE_URL}/api/oauth/${providerId}/oauth/authorize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method, inputs }),
      })
    } catch (error) {
      handleApiError(error, "OAuth authorization failed")
    }
  },

  callback: async (providerId: string, request: OAuthCallbackRequest): Promise<boolean> => {
    try {
      return await fetchWrapper(`${API_BASE_URL}/api/oauth/${providerId}/oauth/callback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      })
    } catch (error) {
      handleApiError(error, "OAuth callback failed")
    }
  },

  getAuthMethods: async (): Promise<ProviderAuthMethods> => {
    try {
      const { providers, ...rest } = await fetchWrapper<{ providers?: ProviderAuthMethods } & ProviderAuthMethods>(
        `${API_BASE_URL}/api/oauth/auth-methods`
      )
      return providers || rest
    } catch (error) {
      handleApiError(error, "Failed to get provider auth methods")
    }
  },
}
