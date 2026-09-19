import { spawn } from 'node:child_process'
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

/** Runs an explicitly configured local executable. Its stdout is JSON, never logged. */
export class ProcessSTTBackend implements STTBackend {
  constructor(private readonly command: string, private readonly args: string[] = [], private readonly label = 'local-process', private readonly configuredCapabilities: VoiceBackendCapabilities = {}) {}
  status(): VoiceBackendStatus { return { available: Boolean(this.command), kind: 'local', name: this.label } }
  capabilities(): VoiceBackendCapabilities { return this.configuredCapabilities }
  transcribe(request: STTRequest): Promise<STTResult> {
    if (!this.command) return Promise.reject(new VoiceBackendError('UNAVAILABLE', 'Speech-to-text backend is unavailable'))
    return new Promise((resolve, reject) => {
      const child = spawn(this.command, this.args, { stdio: ['pipe', 'pipe', 'ignore'] })
      const chunks: Uint8Array[] = []
      child.stdout.on('data', (chunk: Uint8Array) => chunks.push(chunk))
      child.once('error', () => reject(new VoiceBackendError('UNAVAILABLE', 'Speech-to-text backend is unavailable')))
      child.once('close', (code) => {
        if (code !== 0) return reject(new VoiceBackendError('UNAVAILABLE', 'Speech-to-text backend failed'))
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { partial?: unknown; final?: unknown; text?: unknown }
          const final = typeof value.final === 'string' ? value.final : typeof value.text === 'string' ? value.text : ''
          resolve({ partial: typeof value.partial === 'string' ? value.partial : undefined, final })
        } catch { reject(new VoiceBackendError('UNAVAILABLE', 'Speech-to-text backend returned invalid output')) }
      })
      const cancel = () => { child.kill('SIGTERM'); reject(new VoiceBackendError('CANCELED', 'Speech-to-text canceled')) }
      if (request.signal.aborted) cancel()
      else request.signal.addEventListener('abort', cancel, { once: true })
      child.stdin.end(Buffer.from(request.audio))
    })
  }
}

/** Sends JSON request metadata on stdin and streams executable stdout as audio. */
export class ProcessTTSBackend implements TTSBackend {
  constructor(private readonly command: string, private readonly args: string[] = [], private readonly label = 'local-process', private readonly configuredCapabilities: VoiceBackendCapabilities = {}) {}
  status(): VoiceBackendStatus { return { available: Boolean(this.command), kind: 'local', name: this.label } }
  capabilities(): VoiceBackendCapabilities { return this.configuredCapabilities }
  synthesize(request: TTSRequest): AsyncIterable<Uint8Array> {
    if (!this.command) throw new VoiceBackendError('UNAVAILABLE', 'Text-to-speech backend is unavailable')
    const command = this.command
    const args = this.args
    return (async function* () {
      const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'ignore'] })
      let canceled = false
      const cancel = () => { canceled = true; child.kill('SIGTERM') }
      if (request.signal.aborted) cancel()
      else request.signal.addEventListener('abort', cancel, { once: true })
      child.stdin.end(JSON.stringify({ text: request.text, voice: request.voice, model: request.model, speed: request.speed }))
      try {
        for await (const chunk of child.stdout) {
          if (canceled) throw new VoiceBackendError('CANCELED', 'Text-to-speech canceled')
          yield new Uint8Array(chunk)
        }
        const code = await new Promise<number | null>((resolve) => child.once('close', resolve))
        if (canceled) throw new VoiceBackendError('CANCELED', 'Text-to-speech canceled')
        if (code !== 0) throw new VoiceBackendError('UNAVAILABLE', 'Text-to-speech backend failed')
      } finally {
        request.signal.removeEventListener('abort', cancel)
        if (!child.killed) child.kill('SIGTERM')
      }
    })()
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
