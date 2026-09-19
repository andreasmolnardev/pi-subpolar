import { API_BASE_URL } from '@/config'
import { fetchWrapper, fetchWrapperBlob } from './fetchWrapper'
import type { VoiceProvider } from './voice'
import { getVoiceRequestHeaders } from './stt'

export interface TTSModelsResponse {
  models: string[]
  cached: boolean
  state?: 'available' | 'unconfigured'
  available?: boolean
  kind?: VoiceProvider
  name?: string
  detail?: string
}

export interface TTSVoicesResponse {
  voices: string[]
  cached: boolean
  state?: 'available' | 'unconfigured'
  available?: boolean
  kind?: VoiceProvider
  name?: string
  detail?: string
}

export interface TTSStatusResponse {
  enabled: boolean
  configured: boolean
  cache: {
    count: number
    sizeBytes: number
    sizeMB: number
    maxSizeMB: number
    ttlHours: number
  }
  available?: boolean
  kind?: VoiceProvider
  name?: string
  detail?: string
}

export const ttsApi = {
  getModels: async (userId = 'default', forceRefresh = false): Promise<TTSModelsResponse> => {
    return fetchWrapper(`${API_BASE_URL}/api/tts/models`, {
      params: { userId, ...(forceRefresh && { refresh: 'true' }) },
      headers: getVoiceRequestHeaders(),
    })
  },

  getVoices: async (userId = 'default', forceRefresh = false): Promise<TTSVoicesResponse> => {
    return fetchWrapper(`${API_BASE_URL}/api/tts/voices`, {
      params: { userId, ...(forceRefresh && { refresh: 'true' }) },
      headers: getVoiceRequestHeaders(),
    })
  },

  getStatus: async (userId = 'default'): Promise<TTSStatusResponse> => {
    return fetchWrapper(`${API_BASE_URL}/api/tts/status`, {
      params: { userId },
      headers: getVoiceRequestHeaders(),
    })
  },

  synthesize: async (text: string, userId = 'default', signal?: AbortSignal): Promise<Blob> => {
    return fetchWrapperBlob(`${API_BASE_URL}/api/tts/synthesize`, {
      method: 'POST',
      params: { userId },
      headers: getVoiceRequestHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ text }),
      signal,
    })
  },
}
