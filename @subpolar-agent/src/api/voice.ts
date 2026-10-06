import { FetchError } from './fetchWrapper'

export type VoiceProvider = 'local' | 'browser' | 'cloud'

export const VOICE_CLIENT_LIMITS = { audioBytes: 10 * 1024 * 1024, textChars: 32_000, sttOutputBytes: 256 * 1024, ttsOutputBytes: 32 * 1024 * 1024, sttTimeoutMs: 60_000, ttsTimeoutMs: 30_000 } as const

/** Keep cancellation and the deadline active through response-body consumption. */
export async function requestVoiceBytes(url: string, options: RequestInit, outputLimit: number, timeoutMs: number): Promise<{ bytes: Uint8Array; mimeType: string }> {
  const controller = new AbortController()
  let rejectAbort!: (error: FetchError) => void
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject })
  const cancel = () => { rejectAbort(new FetchError('Voice request canceled', 499, 'CANCELED')); controller.abort() }
  if (options.signal?.aborted) throw new FetchError('Voice request canceled', 499, 'CANCELED')
  options.signal?.addEventListener('abort', cancel, { once: true })
  const timeout = setTimeout(() => { rejectAbort(new FetchError('Voice request timed out', 408, 'TIMEOUT')); controller.abort() }, timeoutMs)
  const consume = async () => {
    const response = await fetch(url, { credentials: 'include', ...options, signal: controller.signal })
    const reader = response.body?.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    const limit = response.ok ? outputLimit : VOICE_CLIENT_LIMITS.sttOutputBytes
    const stopReading = () => { if (reader) void reader.cancel().catch(() => undefined) }
    controller.signal.addEventListener('abort', stopReading, { once: true })
    try {
      if (controller.signal.aborted) stopReading()
      if (reader) {
        while (true) {
          const next = await reader.read()
          if (next.done) break
          size += next.value.byteLength
          if (size > limit) {
            stopReading()
            throw new FetchError('Voice response exceeds size limit', response.status, 'SIZE_LIMIT')
          }
          chunks.push(next.value)
        }
      }
    } finally {
      controller.signal.removeEventListener('abort', stopReading)
      reader?.releaseLock()
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    if (!response.ok) {
      let data: Record<string, unknown> = {}
      try {
        const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes))
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed as Record<string, unknown>
      } catch { /* A proxy can return a non-JSON failure. */ }
      throw new FetchError(typeof data.error === 'string' ? data.error : 'Voice request failed', response.status, typeof data.code === 'string' ? data.code : undefined)
    }
    return { bytes, mimeType: response.headers.get('content-type') ?? '' }
  }
  try { return await Promise.race([consume(), aborted]) }
  finally {
    clearTimeout(timeout)
    options.signal?.removeEventListener('abort', cancel)
  }
}

export interface VoiceBackendStatus {
  available: boolean
  kind: VoiceProvider
  name: string
  detail?: string
}

export function isVoiceProviderConfigured(
  provider: VoiceProvider,
  config: { enabled: boolean; apiKey?: string; apiKeyRef?: string },
  browserSupported = true,
): boolean {
  if (!config.enabled) return false
  if (provider === 'browser') return browserSupported
  if (provider === 'cloud') return Boolean(config.apiKey?.trim() || config.apiKeyRef?.trim())
  return true
}

export function redactVoiceSettings(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}

  const input = value as Record<string, unknown>
  const output = { ...input }
  delete output.apiKey
  delete output.token
  delete output.secret

  if (typeof output.apiKeyRef !== 'string' || !output.apiKeyRef.trim()) {
    delete output.apiKeyRef
  }

  return output
}
