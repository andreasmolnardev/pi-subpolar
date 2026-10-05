import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isVoiceProviderConfigured, redactVoiceSettings, requestVoiceBytes, VOICE_CLIENT_LIMITS } from './voice'
import { sttApi } from './stt'
import { ttsApi } from './tts'

describe('local voice HTTP lifecycle (disconnected)', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
    window.history.pushState({}, '', '/projects/1/sessions/local-voice')
  })
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); window.history.pushState({}, '', '/') })

  const operations = [
    { name: 'STT', call: (signal?: AbortSignal) => sttApi.transcribe(new Blob(['test'], { type: 'audio/wav' }), 'not-an-identity', signal), timeout: VOICE_CLIENT_LIMITS.sttTimeoutMs },
    { name: 'TTS', call: (signal?: AbortSignal) => ttsApi.synthesize('hello', 'not-an-identity', signal), timeout: VOICE_CLIENT_LIMITS.ttsTimeoutMs },
  ]

  for (const operation of operations) {
    it(`${operation.name} preserves unavailable and authorization error codes`, async () => {
      for (const [status, code] of [[503, 'UNAVAILABLE'], [403, 'FORBIDDEN'], [408, 'TIMEOUT'], [499, 'CANCELED']] as const) {
        vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Voice unavailable', code }), { status }))
        await expect(operation.call()).rejects.toMatchObject({ statusCode: status, code })
      }
      expect(vi.mocked(fetch).mock.calls[0][1]).toMatchObject({ credentials: 'include' })
    })

    it(`${operation.name} rejects pre-aborted work without fetching`, async () => {
      const controller = new AbortController()
      controller.abort()
      await expect(operation.call(controller.signal)).rejects.toMatchObject({ statusCode: 499, code: 'CANCELED' })
      expect(fetch).not.toHaveBeenCalled()
    })

    it(`${operation.name} cancels after headers while the body is stalled`, async () => {
      const canceled = vi.fn()
      vi.mocked(fetch).mockResolvedValueOnce(new Response(new ReadableStream({ cancel: canceled })))
      const controller = new AbortController()
      const result = operation.call(controller.signal)
      const assertion = expect(result).rejects.toMatchObject({ statusCode: 499, code: 'CANCELED' })
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())
      controller.abort()
      await assertion
      expect(canceled).toHaveBeenCalledOnce()
    })

    it(`${operation.name} times out a stalled body, not just slow headers`, async () => {
      vi.useFakeTimers()
      const canceled = vi.fn()
      vi.mocked(fetch).mockResolvedValueOnce(new Response(new ReadableStream({ cancel: canceled })))
      const result = operation.call()
      const assertion = expect(result).rejects.toMatchObject({ statusCode: 408, code: 'TIMEOUT' })
      await vi.advanceTimersByTimeAsync(operation.timeout)
      await assertion
      expect(canceled).toHaveBeenCalledOnce()
      expect(vi.getTimerCount()).toBe(0)
    })

    it(`${operation.name} removes the caller abort listener after success`, async () => {
      const controller = new AbortController()
      const remove = vi.spyOn(controller.signal, 'removeEventListener')
      vi.mocked(fetch).mockResolvedValueOnce(new Response(operation.name === 'STT' ? '{"text":"hello"}' : 'fake audio'))
      await operation.call(controller.signal)
      expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
    })
  }

  it('bounds decoded response bytes and cancels oversized streams', async () => {
    const canceled = vi.fn()
    vi.mocked(fetch).mockResolvedValueOnce(new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(5)) }, cancel: canceled })))
    await expect(requestVoiceBytes('/voice-test', {}, 4, 1000)).rejects.toMatchObject({ code: 'SIZE_LIMIT' })
    expect(canceled).toHaveBeenCalledOnce()
  })

  it('rejects oversized inputs without contacting a backend', async () => {
    await expect(sttApi.transcribe(new Blob([new Uint8Array(VOICE_CLIENT_LIMITS.audioBytes + 1)]))).rejects.toMatchObject({ statusCode: 413, code: 'SIZE_LIMIT' })
    await expect(ttsApi.synthesize('x'.repeat(VOICE_CLIENT_LIMITS.textChars + 1))).rejects.toMatchObject({ statusCode: 413, code: 'SIZE_LIMIT' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('does not turn malformed session URL encoding into a URIError', async () => {
    window.history.pushState({}, '', '/projects/1/sessions/%broken')
    vi.mocked(fetch).mockResolvedValueOnce(new Response('{"text":"ok"}'))
    await sttApi.transcribe(new Blob(['test']))
    expect(new Headers(vi.mocked(fetch).mock.calls[0][1]?.headers).has('x-session-id')).toBe(false)
  })

  it('rejects malformed successful STT responses', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response('{"text":123}'))
    await expect(sttApi.transcribe(new Blob(['test']))).rejects.toMatchObject({ code: 'INVALID_JSON' })
  })
})

describe('voice provider configuration', () => {
  it('allows an enabled local provider without browser credentials', () => {
    expect(isVoiceProviderConfigured('local', { enabled: true })).toBe(true)
  })

  it('treats a protected API key reference as configured', () => {
    expect(isVoiceProviderConfigured('cloud', { enabled: true, apiKeyRef: 'vault://tts' })).toBe(true)
    expect(isVoiceProviderConfigured('cloud', { enabled: true })).toBe(false)
  })

  it('keeps disabled providers unavailable and redacts secret values', () => {
    expect(isVoiceProviderConfigured('local', { enabled: false })).toBe(false)
    expect(redactVoiceSettings({ apiKey: 'secret', token: 'token', apiKeyRef: 'vault://tts' })).toEqual({ apiKeyRef: 'vault://tts' })
  })
})
