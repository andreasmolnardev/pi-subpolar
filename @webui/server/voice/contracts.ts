export type VoiceBackendKind = 'local' | 'browser' | 'cloud'

export type VoiceBackendStatus = {
  available: boolean
  kind: VoiceBackendKind
  name: string
  detail?: string
}

export type VoiceBackendCapabilities = {
  models?: readonly string[]
  voices?: readonly string[]
}

export type STTRequest = {
  audio: Uint8Array
  mimeType: string
  language?: string
  signal: AbortSignal
}

export type STTResult = {
  partial?: string
  final: string
}

export interface STTBackend {
  status(): VoiceBackendStatus
  capabilities?(): VoiceBackendCapabilities
  transcribe(request: STTRequest): Promise<STTResult>
}

export type TTSRequest = {
  text: string
  voice?: string
  model?: string
  speed?: number
  signal: AbortSignal
}

export interface TTSBackend {
  status(): VoiceBackendStatus
  capabilities?(): VoiceBackendCapabilities
  synthesize(request: TTSRequest): AsyncIterable<Uint8Array> | Promise<Uint8Array | AsyncIterable<Uint8Array>>
}

export type VoiceBackends = {
  stt: STTBackend
  tts: TTSBackend
}

export type VoiceAuthorization = {
  userId: string
  sessionId: string
  projectId?: string
  agentName: string
  authorize: () => void | Promise<void>
}

export class VoiceBackendError extends Error {
  constructor(readonly code: 'UNAVAILABLE' | 'TIMEOUT' | 'CANCELED' | 'INVALID', message: string) {
    super(message)
    this.name = 'VoiceBackendError'
  }
}

export class VoiceAuthorizationError extends Error {
  readonly code = 'FORBIDDEN' as const
  constructor(message = 'Voice access is not permitted') {
    super(message)
    this.name = 'VoiceAuthorizationError'
  }
}

export function unavailableStatus(kind: VoiceBackendKind, name: string, detail = 'No backend is configured'): VoiceBackendStatus {
  return { available: false, kind, name, detail }
}

export function redactVoiceSettings(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const input = value as Record<string, unknown>
  const output: Record<string, unknown> = { ...input }
  delete output.apiKey
  delete output.token
  delete output.secret
  if (typeof output.apiKeyRef !== 'string' || !output.apiKeyRef.trim()) delete output.apiKeyRef
  return output
}
