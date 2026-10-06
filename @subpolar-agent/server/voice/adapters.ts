import { spawn } from 'node:child_process'
import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { VoiceBackendError, type STTBackend, type STTRequest, type STTResult, type TTSBackend, type TTSRequest, type VoiceBackendCapabilities, type VoiceBackendStatus, unavailableStatus } from './contracts.ts'

export type STTLibrary = (request: STTRequest) => Promise<STTResult>
export type TTSLibrary = (request: TTSRequest) => AsyncIterable<Uint8Array> | Promise<Uint8Array | AsyncIterable<Uint8Array>>

export type LocalVoiceConfiguration = {
  sttExecutable?: string
  ttsExecutable?: string
  sttLibrary?: STTLibrary
  ttsLibrary?: TTSLibrary
  sttModels?: readonly string[]
  ttsModels?: readonly string[]
  ttsVoices?: readonly string[]
}

export class CallbackSTTBackend implements STTBackend {
  constructor(private readonly callback: STTLibrary, private readonly label = 'local-callback', private readonly configuredCapabilities: VoiceBackendCapabilities = {}) {}
  status(): VoiceBackendStatus { return { available: true, kind: 'local', name: this.label } }
  capabilities(): VoiceBackendCapabilities { return this.configuredCapabilities }
  transcribe(request: STTRequest): Promise<STTResult> { return this.callback(request) }
}

export class CallbackTTSBackend implements TTSBackend {
  constructor(private readonly callback: TTSLibrary, private readonly label = 'local-callback', private readonly configuredCapabilities: VoiceBackendCapabilities = {}) {}
  status(): VoiceBackendStatus { return { available: true, kind: 'local', name: this.label } }
  capabilities(): VoiceBackendCapabilities { return this.configuredCapabilities }
  synthesize(request: TTSRequest) { return this.callback(request) }
}

class UnavailableSTTBackend implements STTBackend {
  status() { return unavailableStatus('local', 'local-stt') }
  capabilities(): VoiceBackendCapabilities { return {} }
  async transcribe(_request: STTRequest): Promise<STTResult> { throw new VoiceBackendError('UNAVAILABLE', 'Speech-to-text backend is unavailable') }
}

class UnavailableTTSBackend implements TTSBackend {
  status() { return unavailableStatus('local', 'local-tts') }
  capabilities(): VoiceBackendCapabilities { return {} }
  async synthesize(_request: TTSRequest): Promise<Uint8Array> { throw new VoiceBackendError('UNAVAILABLE', 'Text-to-speech backend is unavailable') }
}

export const LOCAL_VOICE_LIMITS = { audioBytes: 10 * 1024 * 1024, textChars: 32_000, sttOutputBytes: 256 * 1024, ttsOutputBytes: 32 * 1024 * 1024, timeoutMs: 30_000, killGraceMs: 1_000 } as const

function processStatus(command: string): VoiceBackendStatus {
  const candidates = command.includes('/') ? [command] : (process.env.PATH ?? '').split(delimiter).map((directory) => join(directory, command))
  const available = Boolean(command) && candidates.some((path) => {
    try { accessSync(path, constants.X_OK); return statSync(path).isFile() } catch { return false }
  })
  return { available, kind: 'local', name: 'local-process', ...(!available && { detail: 'Local executable is unavailable' }) }
}

/** No shell; failures never expose executable paths, stderr, or speech content. */
async function* processOutput(command: string, args: string[], input: Uint8Array | string, signal: AbortSignal, outputLimit: number, env?: NodeJS.ProcessEnv): AsyncIterable<Uint8Array> {
  if (signal.aborted) throw new VoiceBackendError('CANCELED', 'Voice request canceled')
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'ignore'], env })
  let closed = false
  let killTimer: ReturnType<typeof setTimeout> | undefined
  const stop = () => {
    if (closed || killTimer) return
    child.kill('SIGTERM')
    killTimer = setTimeout(() => { if (!closed) child.kill('SIGKILL') }, LOCAL_VOICE_LIMITS.killGraceMs)
    killTimer.unref()
  }
  let fail!: (error: VoiceBackendError) => void
  const failure = new Promise<never>((_resolve, reject) => { fail = reject })
  // A failure may arrive while the consumer is paused between chunks.
  void failure.catch(() => undefined)
  const completion = new Promise<void>((resolve) => {
    child.once('close', (code) => {
      closed = true
      if (killTimer) clearTimeout(killTimer)
      if (code !== 0) fail(new VoiceBackendError('UNAVAILABLE', 'Local voice backend failed'))
      resolve()
    })
  })
  child.once('error', () => fail(new VoiceBackendError('UNAVAILABLE', 'Local voice backend unavailable')))
  child.stdin.on('error', () => { fail(new VoiceBackendError('UNAVAILABLE', 'Local voice backend input failed')); stop() })
  const abort = () => { fail(new VoiceBackendError('CANCELED', 'Voice request canceled')); stop() }
  signal.addEventListener('abort', abort, { once: true })
  const timeout = setTimeout(() => { fail(new VoiceBackendError('TIMEOUT', 'Local voice backend timed out')); stop() }, LOCAL_VOICE_LIMITS.timeoutMs)
  child.stdin.end(input)
  const iterator = child.stdout[Symbol.asyncIterator]()
  let size = 0
  try {
    while (true) {
      const next = await Promise.race([iterator.next(), failure])
      if (next.done) break
      size += next.value.byteLength
      if (size > outputLimit) throw new VoiceBackendError('INVALID', 'Local voice output exceeds size limit')
      yield new Uint8Array(next.value)
    }
    await Promise.race([completion, failure])
    if (size === 0) throw new VoiceBackendError('INVALID', 'Local voice backend returned empty output')
  } catch (error) {
    if (error instanceof VoiceBackendError) throw error
    throw new VoiceBackendError('UNAVAILABLE', 'Local voice backend failed')
  } finally {
    clearTimeout(timeout)
    signal.removeEventListener('abort', abort)
    stop()
    child.stdin.destroy()
    child.stdout.destroy()
  }
}

/** Runs an explicitly configured local executable. Its stdout is JSON, never logged. */
export class ProcessSTTBackend implements STTBackend {
  constructor(private readonly command: string, private readonly args: string[] = [], private readonly label = 'local-process', private readonly configuredCapabilities: VoiceBackendCapabilities = {}) {}
  status(): VoiceBackendStatus { return { ...processStatus(this.command), name: this.label } }
  capabilities(): VoiceBackendCapabilities { return this.configuredCapabilities }
  async transcribe(request: STTRequest): Promise<STTResult> {
    if (!this.command) throw new VoiceBackendError('UNAVAILABLE', 'Speech-to-text backend is unavailable')
    if (request.audio.byteLength > LOCAL_VOICE_LIMITS.audioBytes) throw new VoiceBackendError('INVALID', 'Audio exceeds size limit')
    const chunks: Uint8Array[] = []
    const env = { ...process.env, SUBPOLAR_VOICE_AUDIO_MIME_TYPE: request.mimeType, SUBPOLAR_VOICE_AUDIO_LANGUAGE: request.language ?? '' }
    for await (const chunk of processOutput(this.command, this.args, request.audio, request.signal, LOCAL_VOICE_LIMITS.sttOutputBytes, env)) chunks.push(chunk)
    try {
      const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid result')
      const result = value as { partial?: unknown; final?: unknown; text?: unknown }
      const final = typeof result.final === 'string' ? result.final : result.text
      if (typeof final !== 'string' || (result.partial !== undefined && typeof result.partial !== 'string')) throw new Error('Invalid transcript')
      return { final, partial: result.partial as string | undefined }
    } catch { throw new VoiceBackendError('INVALID', 'Speech-to-text backend returned invalid output') }
  }
}

/** Sends JSON request metadata on stdin and streams executable stdout as audio. */
export class ProcessTTSBackend implements TTSBackend {
  constructor(private readonly command: string, private readonly args: string[] = [], private readonly label = 'local-process', private readonly configuredCapabilities: VoiceBackendCapabilities = {}) {}
  status(): VoiceBackendStatus { return { ...processStatus(this.command), name: this.label } }
  capabilities(): VoiceBackendCapabilities { return this.configuredCapabilities }
  synthesize(request: TTSRequest): AsyncIterable<Uint8Array> {
    if (!this.command) throw new VoiceBackendError('UNAVAILABLE', 'Text-to-speech backend is unavailable')
    if (!request.text.trim() || request.text.length > LOCAL_VOICE_LIMITS.textChars) throw new VoiceBackendError('INVALID', 'Text exceeds size limit')
    return processOutput(this.command, this.args, JSON.stringify({ text: request.text, voice: request.voice, model: request.model, speed: request.speed }), request.signal, LOCAL_VOICE_LIMITS.ttsOutputBytes)
  }
}

export function localVoiceBackends(configuration: LocalVoiceConfiguration = {}): { stt: STTBackend; tts: TTSBackend } {
  const sttCapabilities = { models: configuration.sttModels }
  const ttsCapabilities = { models: configuration.ttsModels, voices: configuration.ttsVoices }
  return {
    stt: configuration.sttLibrary ? new CallbackSTTBackend(configuration.sttLibrary, 'local-callback', sttCapabilities) : configuration.sttExecutable ? new ProcessSTTBackend(configuration.sttExecutable, [], 'local-process', sttCapabilities) : new UnavailableSTTBackend(),
    tts: configuration.ttsLibrary ? new CallbackTTSBackend(configuration.ttsLibrary, 'local-callback', ttsCapabilities) : configuration.ttsExecutable ? new ProcessTTSBackend(configuration.ttsExecutable, [], 'local-process', ttsCapabilities) : new UnavailableTTSBackend(),
  }
}

export function unavailableVoiceBackends() { return localVoiceBackends() }
