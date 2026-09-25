import { describe, expect, it } from 'vitest'
import { CallbackSTTBackend, CallbackTTSBackend, localVoiceBackends } from '../voice/adapters.ts'
import { redactVoiceSettings, type VoiceBackends, VoiceBackendError, type VoiceAuthorization } from '../voice/contracts.ts'
import { handleVoiceRoute, VOICE_LIMITS } from '../voice/routes.ts'

function backends(overrides: Partial<VoiceBackends> = {}): VoiceBackends {
  return {
    stt: new CallbackSTTBackend(async () => ({ partial: 'hel', final: 'hello' })),
    tts: new CallbackTTSBackend(async function* ({ signal }) {
      yield new Uint8Array([1])
      if (signal.aborted) throw new VoiceBackendError('CANCELED', 'canceled')
      yield new Uint8Array([2])
    }),
    ...overrides,
  }
}

const authorization: VoiceAuthorization = { userId: 'owner', sessionId: 'session', agentName: 'master', authorize: () => undefined }

function multipartRequest(form: { get: (name: string) => unknown }, size?: number): Request {
  const request = new Request('http://localhost/api/stt/transcribe', { method: 'POST' })
  Object.defineProperty(request, 'formData', { value: async () => form })
  if (size !== undefined) Object.defineProperty(request, 'headers', { value: new Headers({ 'content-length': String(size) }) })
  return request
}

describe('voice backend seam', () => {
  it('keeps partial and final STT results on the normal response contract', async () => {
    const form = { get: () => ({ size: 1, type: 'audio/webm', arrayBuffer: async () => new Uint8Array([1]).buffer }) }
    const response = await handleVoiceRoute(multipartRequest(form), backends(), authorization)
    expect(await response?.json()).toEqual({ text: 'hello', partial: 'hel' })
  })

  it('allows multipart overhead at the raw audio limit', async () => {
    const form = { get: () => ({ size: VOICE_LIMITS.audioBytes, type: 'audio/wav', arrayBuffer: async () => new ArrayBuffer(VOICE_LIMITS.audioBytes) }) }
    const response = await handleVoiceRoute(multipartRequest(form, VOICE_LIMITS.audioBytes + VOICE_LIMITS.multipartOverheadBytes), backends(), authorization)
    expect(response?.status).toBe(200)
  })

  it('bounds the complete multipart body before parsing', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(VOICE_LIMITS.bodyBytes + 1))
        controller.close()
      },
    })
    const response = await handleVoiceRoute(new Request('http://localhost/api/stt/transcribe', { method: 'POST', body }), backends(), authorization)
    expect(response?.status).toBe(413)
  })

  it('streams TTS chunks and exposes cancellation without leaking details', async () => {
    const response = await handleVoiceRoute(new Request('http://localhost/api/tts/synthesize', { method: 'POST', body: JSON.stringify({ text: 'hello' }), headers: { 'content-type': 'application/json' } }), backends(), authorization)
    expect([...new Uint8Array(await response!.arrayBuffer())]).toEqual([1, 2])
  })

  it('rejects unavailable backends, oversized audio, and oversized text safely', async () => {
    const unavailable = { status: () => ({ available: false, kind: 'local' as const, name: 'fake' }), transcribe: async () => { throw new VoiceBackendError('UNAVAILABLE', 'secret command / token') } }
    const form = { get: () => ({ size: 10 * 1024 * 1024 + 1, type: 'audio/wav', arrayBuffer: async () => new ArrayBuffer(0) }) }
    const tooLarge = await handleVoiceRoute(multipartRequest(form), backends(), authorization)
    expect(tooLarge?.status).toBe(413)
    const failed = await handleVoiceRoute(multipartRequest({ get: () => ({ size: 1, type: 'audio/wav', arrayBuffer: async () => new ArrayBuffer(1) }) }), { ...backends(), stt: unavailable }, authorization)
    expect(failed?.status).toBe(503)
    expect(await failed?.text()).not.toContain('secret')
    const text = await handleVoiceRoute(new Request('http://localhost/api/tts/synthesize', { method: 'POST', body: JSON.stringify({ text: 'x'.repeat(32_001) }) }), backends(), authorization)
    expect(text?.status).toBe(413)
  })

  it('denies an unauthorized voice operation', async () => {
    const response = await handleVoiceRoute(new Request('http://localhost/api/tts/synthesize', { method: 'POST', body: JSON.stringify({ text: 'hello' }) }), backends(), { ...authorization, authorize: () => { throw new Error('denied') } })
    expect(response?.status).toBe(403)
  })

  it('bounds a chunked body before parsing JSON', async () => {
    const response = await handleVoiceRoute(new Request('http://localhost/api/tts/synthesize', { method: 'POST', body: '{"text":"' + 'x'.repeat(11 * 1024 * 1024) + '"}' }), backends(), authorization)
    expect(response?.status).toBe(413)
  })

  it('invokes configured local callback adapters and reports unavailable otherwise', async () => {
    let called = false
    const configured = localVoiceBackends({ sttLibrary: async () => { called = true; return { final: 'ok' } } })
    await configured.stt.transcribe({ audio: new Uint8Array(), mimeType: 'audio/wav', signal: new AbortController().signal })
    expect(called).toBe(true)
    expect(localVoiceBackends().stt.status().available).toBe(false)
  })

  it('returns configured discovery capabilities and stable unavailable state', async () => {
    const configured = localVoiceBackends({
      sttLibrary: async () => ({ final: 'ok' }),
      sttModels: ['whisper-local'],
      ttsLibrary: async function* () { yield new Uint8Array([1]) },
      ttsModels: ['local-tts'],
      ttsVoices: ['default'],
    })
    expect(await (await handleVoiceRoute(new Request('http://localhost/api/stt/models'), configured, authorization))!.json()).toEqual({ models: ['whisper-local'], cached: false, state: 'available', available: true, kind: 'local', name: 'local-callback' })
    expect(await (await handleVoiceRoute(new Request('http://localhost/api/tts/voices'), configured, authorization))!.json()).toEqual({ voices: ['default'], cached: false, state: 'available', available: true, kind: 'local', name: 'local-callback' })
    expect(await (await handleVoiceRoute(new Request('http://localhost/api/tts/models'), localVoiceBackends(), authorization))!.json()).toEqual({ models: [], cached: false, state: 'unconfigured', available: false, kind: 'local', name: 'local-tts', detail: 'No backend is configured' })
  })

  it('protects discovery with the normal voice authorization scope', async () => {
    const response = await handleVoiceRoute(new Request('http://localhost/api/tts/voices'), backends(), { ...authorization, authorize: () => { throw new Error('denied') } })
    expect(response?.status).toBe(403)
    expect(await response?.json()).toEqual({ error: 'Voice access is not permitted', code: 'FORBIDDEN' })
  })

  it('propagates stream cancellation to the backend iterator', async () => {
    let returned = false
    const response = await handleVoiceRoute(new Request('http://localhost/api/tts/synthesize', { method: 'POST', body: JSON.stringify({ text: 'hello' }) }), { ...backends(), tts: new CallbackTTSBackend(() => ({
      async *[Symbol.asyncIterator]() { try { yield new Uint8Array([1]); await new Promise(() => undefined) } finally { returned = true } },
    })) }, authorization)
    await response!.body!.cancel()
    expect(returned).toBe(true)
  })

  it('redacts credentials from persisted/runtime settings', () => {
    expect(redactVoiceSettings({ enabled: true, apiKey: 'secret', token: 'token', apiKeyRef: 'vault://voice' })).toEqual({ enabled: true, apiKeyRef: 'vault://voice' })
  })
})
