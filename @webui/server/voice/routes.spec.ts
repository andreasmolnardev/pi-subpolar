// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CallbackSTTBackend, CallbackTTSBackend, localVoiceBackends, ProcessTTSBackend } from './adapters.ts'
import { handleVoiceRoute, VOICE_LIMITS } from './routes.ts'
import { VoiceBackendError, type STTRequest, type TTSRequest, type VoiceAuthorization } from './contracts.ts'

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

const authorization: VoiceAuthorization = { userId: 'owner', sessionId: 'session', agentName: 'master', authorize: () => undefined }
const discovery = ['/api/stt/status', '/api/stt/models', '/api/tts/status', '/api/tts/models', '/api/tts/voices']
function operation(path: string) {
  if (path.endsWith('/transcribe')) {
    const body = new FormData()
    body.append('audio', new Blob(['synthetic'], { type: 'audio/wav' }), 'test.wav')
    return new Request(`http://localhost${path}`, { method: 'POST', body })
  }
  if (path.endsWith('/synthesize')) return new Request(`http://localhost${path}`, { method: 'POST', body: JSON.stringify({ text: 'hello' }), headers: { 'content-type': 'application/json' } })
  return new Request(`http://localhost${path}`)
}

describe('voice request deadline and cancellation', () => {
  it('does not misclassify malformed JSON or ordinary backend errors as timeout', async () => {
    const malformed = await handleVoiceRoute(new Request('http://localhost/api/tts/synthesize', { method: 'POST', body: 'not JSON' }), localVoiceBackends(), authorization)
    expect(malformed?.status).toBe(400)
    expect(await malformed!.json()).toMatchObject({ code: 'FAILED' })
    const unavailable = await handleVoiceRoute(operation('/api/tts/synthesize'), { ...localVoiceBackends(), tts: new CallbackTTSBackend(async () => { throw new VoiceBackendError('UNAVAILABLE', 'private path/token') }) }, authorization)
    expect(unavailable?.status).toBe(503)
    expect(await unavailable!.text()).not.toContain('private')
  })

  it('surfaces lazy missing executable failures before audio headers are sent', async () => {
    const response = await handleVoiceRoute(operation('/api/tts/synthesize'), { ...localVoiceBackends(), tts: new ProcessTTSBackend('/nonexistent/subpolar-voice-secret') }, authorization)
    expect(response?.status).toBe(503)
    expect(await response!.json()).toEqual({ code: 'UNAVAILABLE', error: 'Voice backend unavailable' })
  })

  for (const path of ['/api/stt/transcribe', '/api/tts/synthesize']) {
    it(`honors a real deadline for a noncooperative backend at ${path}`, async () => {
      vi.useFakeTimers()
      const hanging = vi.fn((_request: STTRequest | TTSRequest) => new Promise<never>(() => undefined))
      const backends = { stt: new CallbackSTTBackend(hanging), tts: new CallbackTTSBackend(hanging) }
      const pending = handleVoiceRoute(operation(path), backends, authorization)
      await vi.waitFor(() => expect(hanging).toHaveBeenCalledOnce())
      await vi.advanceTimersByTimeAsync(VOICE_LIMITS.timeoutMs)
      const response = await pending
      expect(response?.status).toBe(408)
      expect(await response!.json()).toEqual({ code: 'TIMEOUT', error: 'Voice request timed out' })
      expect(hanging.mock.calls[0][0].signal.aborted).toBe(true)
      expect(vi.getTimerCount()).toBe(0)
    })

    it(`honors caller cancellation rather than reporting timeout at ${path}`, async () => {
      const controller = new AbortController()
      const hanging = vi.fn((_request: STTRequest | TTSRequest) => new Promise<never>(() => undefined))
      const pending = handleVoiceRoute(new Request(operation(path), { signal: controller.signal }), { stt: new CallbackSTTBackend(hanging), tts: new CallbackTTSBackend(hanging) }, authorization)
      await vi.waitFor(() => expect(hanging).toHaveBeenCalledOnce())
      controller.abort()
      const response = await pending
      expect(response?.status).toBe(499)
      expect(await response!.json()).toEqual({ code: 'CANCELED', error: 'Voice request canceled' })
    })

    it(`does not call a backend for a pre-aborted request at ${path}`, async () => {
      const controller = new AbortController()
      controller.abort()
      const stt = vi.fn(async () => ({ final: 'unexpected' }))
      const tts = vi.fn(async () => new Uint8Array([1]))
      const response = await handleVoiceRoute(new Request(operation(path), { signal: controller.signal }), { stt: new CallbackSTTBackend(stt), tts: new CallbackTTSBackend(tts) }, authorization)
      expect(response?.status).toBe(499)
      expect(stt).not.toHaveBeenCalled()
      expect(tts).not.toHaveBeenCalled()
    })
  }

  it('times out and cancels a stalled upload reader', async () => {
    vi.useFakeTimers()
    const canceled = vi.fn()
    const body = new ReadableStream<Uint8Array>({ cancel: canceled })
    const request = new Request('http://localhost/api/tts/synthesize', { method: 'POST', body, duplex: 'half' } as RequestInit & { duplex: 'half' })
    const pending = handleVoiceRoute(request, localVoiceBackends(), authorization)
    await vi.advanceTimersByTimeAsync(VOICE_LIMITS.timeoutMs)
    const response = await pending
    expect(response?.status).toBe(408)
    expect(canceled).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('times out an iterator stalled after the first audio chunk and returns it', async () => {
    vi.useFakeTimers()
    const returned = vi.fn(async () => ({ done: true as const, value: undefined }))
    const next = vi.fn().mockResolvedValueOnce({ done: false, value: new Uint8Array([1]) }).mockImplementation(() => new Promise(() => undefined))
    const backend = new CallbackTTSBackend(() => ({ [Symbol.asyncIterator]: () => ({ next, return: returned }) }))
    const response = await handleVoiceRoute(operation('/api/tts/synthesize'), { ...localVoiceBackends(), tts: backend }, authorization)
    const reader = response!.body!.getReader()
    expect((await reader.read()).value).toEqual(new Uint8Array([1]))
    const pending = reader.read()
    const assertion = expect(pending).rejects.toMatchObject({ code: 'TIMEOUT', message: 'Voice request timed out' })
    await vi.advanceTimersByTimeAsync(VOICE_LIMITS.timeoutMs)
    await assertion
    expect(returned).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('applies backpressure and cancels without waiting for a noncooperative iterator', async () => {
    const returned = vi.fn(async () => ({ done: true as const, value: undefined }))
    const next = vi.fn().mockResolvedValueOnce({ done: false, value: new Uint8Array([1]) }).mockImplementation(() => new Promise(() => undefined))
    let backendSignal: AbortSignal | undefined
    const backend = new CallbackTTSBackend(({ signal }) => { backendSignal = signal; return { [Symbol.asyncIterator]: () => ({ next, return: returned }) } })
    const response = await handleVoiceRoute(operation('/api/tts/synthesize'), { ...localVoiceBackends(), tts: backend }, authorization)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(next).toHaveBeenCalledOnce()
    const reader = response!.body!.getReader()
    await reader.read()
    const pending = reader.read()
    await reader.cancel()
    await expect(pending).resolves.toMatchObject({ done: true })
    expect(backendSignal?.aborted).toBe(true)
    expect(returned).toHaveBeenCalledOnce()
  })

  it('sanitizes errors occurring after streaming headers', async () => {
    const backend = new CallbackTTSBackend(async function* () { yield new Uint8Array([1]); throw new Error('private executable/token/transcript') })
    const response = await handleVoiceRoute(operation('/api/tts/synthesize'), { ...localVoiceBackends(), tts: backend }, authorization)
    expect(response?.status).toBe(200)
    await expect(response!.arrayBuffer()).rejects.toMatchObject({ code: 'UNAVAILABLE', message: 'Voice backend unavailable' })
  })
})

describe('disconnected local voice routes (no configured speech backend)', () => {
  it.each(discovery)('reports stable unconfigured discovery for %s', async (path) => {
    const response = await handleVoiceRoute(operation(path), localVoiceBackends(), authorization)
    expect(response?.status).toBe(200)
    const data = await response!.json()
    expect(data).toMatchObject({ available: false, kind: 'local', detail: 'No backend is configured' })
    if (!path.endsWith('/status')) expect(data).toMatchObject({ state: 'unconfigured', cached: false, [path.endsWith('/voices') ? 'voices' : 'models']: [] })
  })

  it.each(['/api/stt/transcribe', '/api/tts/synthesize'])('fails safely without a backend for %s', async (path) => {
    const response = await handleVoiceRoute(operation(path), localVoiceBackends(), authorization)
    expect(response?.status).toBe(503)
    expect(await response!.json()).toEqual({ code: 'UNAVAILABLE', error: 'Voice backend unavailable' })
  })

  it.each([...discovery, '/api/stt/transcribe', '/api/tts/synthesize'])('authorizes before touching a backend for %s', async (path) => {
    const backends = localVoiceBackends()
    const calls = [vi.spyOn(backends.stt, 'status'), vi.spyOn(backends.tts, 'status'), vi.spyOn(backends.stt, 'transcribe'), vi.spyOn(backends.tts, 'synthesize')]
    const response = await handleVoiceRoute(operation(path), backends, { ...authorization, authorize: () => { throw new Error('private authorization details') } })
    expect(response?.status).toBe(403)
    expect(await response!.json()).toEqual({ code: 'FORBIDDEN', error: 'Voice access is not permitted' })
    for (const call of calls) expect(call).not.toHaveBeenCalled()
  })
})
