import { API_BASE_URL } from '@/config'
import { fetchWrapper, FetchError } from './fetchWrapper'
import { requestVoiceBytes, VOICE_CLIENT_LIMITS, type VoiceProvider } from './voice'

export function getActiveSessionId(): string | undefined {
  if (typeof window === 'undefined') return undefined

  const match = window.location.pathname.match(/\/sessions\/([^/]+)/)
  try { return match?.[1] ? decodeURIComponent(match[1]) : undefined }
  catch { return undefined }
}

export function getVoiceRequestHeaders(headers: HeadersInit = {}): Headers {
  const requestHeaders = new Headers(headers)
  const sessionId = getActiveSessionId()
  if (sessionId) requestHeaders.set('x-session-id', sessionId)
  return requestHeaders
}

export interface STTModelsResponse {
  models: string[]
  cached: boolean
  state?: 'available' | 'unconfigured'
  available?: boolean
  kind?: VoiceProvider
  name?: string
  detail?: string
}

export interface STTStatusResponse {
  enabled: boolean
  configured: boolean
  provider?: VoiceProvider
  kind?: VoiceProvider
  model?: string
  available?: boolean
  name?: string
  detail?: string
}

export interface STTTranscribeResponse {
  text: string
  partial?: string
}

export interface STTErrorResponse {
  error: string
  details?: string
}

export const sttApi = {
  getModels: async (userId = 'default', forceRefresh = false): Promise<STTModelsResponse> => {
    return fetchWrapper(`${API_BASE_URL}/api/stt/models`, {
      params: { userId, ...(forceRefresh && { refresh: 'true' }) },
      headers: getVoiceRequestHeaders(),
    })
  },

  getStatus: async (userId = 'default'): Promise<STTStatusResponse> => {
    return fetchWrapper(`${API_BASE_URL}/api/stt/status`, {
      params: { userId },
      headers: getVoiceRequestHeaders(),
    })
  },

  transcribe: async (
    audioBlob: Blob,
    userId = 'default',
    signal?: AbortSignal
  ): Promise<STTTranscribeResponse> => {
    if (audioBlob.size > VOICE_CLIENT_LIMITS.audioBytes) throw new FetchError('Audio exceeds size limit', 413, 'SIZE_LIMIT')
    const formData = new FormData()

    const type = audioBlob.type
    const extension =
      type.includes('wav') ? 'wav' :
      type.includes('webm') ? 'webm' :
      type.includes('ogg') ? 'ogg' :
      type.includes('mp4') ? 'm4a' : 'wav'
    formData.append('audio', audioBlob, `recording.${extension}`)

    const urlObj = new URL(`${API_BASE_URL}/api/stt/transcribe`, window.location.origin)
    urlObj.searchParams.set('userId', userId)

    const { bytes } = await requestVoiceBytes(urlObj.toString(), {
      method: 'POST', body: formData, headers: getVoiceRequestHeaders(), signal,
    }, VOICE_CLIENT_LIMITS.sttOutputBytes, VOICE_CLIENT_LIMITS.sttTimeoutMs)
    try {
      const result: unknown = JSON.parse(new TextDecoder().decode(bytes))
      if (!result || typeof result !== 'object' || !('text' in result) || typeof result.text !== 'string' || ('partial' in result && result.partial !== undefined && typeof result.partial !== 'string')) throw new Error('Invalid transcript')
      return result as STTTranscribeResponse
    } catch { throw new FetchError('Invalid transcription response', 200, 'INVALID_JSON') }
  },
}
