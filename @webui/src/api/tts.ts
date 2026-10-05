import { API_BASE_URL } from '@/config'
import { fetchWrapper, FetchError } from './fetchWrapper'
import { requestVoiceBytes, VOICE_CLIENT_LIMITS, type VoiceProvider } from './voice'
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
    if (!text.trim() || text.trim().length > VOICE_CLIENT_LIMITS.textChars) throw new FetchError('Text exceeds size limit', 413, 'SIZE_LIMIT')
    const url = new URL(`${API_BASE_URL}/api/tts/synthesize`, window.location.origin)
    url.searchParams.set('userId', userId)
    const { bytes, mimeType } = await requestVoiceBytes(url.toString(), {
      method: 'POST',
      headers: getVoiceRequestHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ text: text.trim() }),
      signal,
    }, VOICE_CLIENT_LIMITS.ttsOutputBytes, VOICE_CLIENT_LIMITS.ttsTimeoutMs)
    return new Blob([new Uint8Array(bytes)], { type: mimeType })
  },
}
