import { VoiceAuthorizationError, VoiceBackendError, type VoiceAuthorization, type VoiceBackends } from './contracts.ts'

export const VOICE_LIMITS = { audioBytes: 10 * 1024 * 1024, multipartOverheadBytes: 64 * 1024, bodyBytes: 10 * 1024 * 1024 + 64 * 1024, textChars: 32_000, ttsOutputBytes: 32 * 1024 * 1024, timeoutMs: 30_000 } as const

class VoiceRequestLimitError extends Error {}

function errorResponse(error: unknown): Response {
  const code = error instanceof VoiceBackendError ? error.code : error instanceof VoiceRequestLimitError ? 'SIZE_LIMIT' : 'FAILED'
  const status = error instanceof VoiceAuthorizationError ? 403 : error instanceof VoiceRequestLimitError ? 413 : code === 'UNAVAILABLE' ? 503 : code === 'TIMEOUT' ? 408 : code === 'CANCELED' ? 499 : 400
  if (error instanceof VoiceAuthorizationError) return Response.json({ error: 'Voice access is not permitted', code: 'FORBIDDEN' }, { status })
  return Response.json({ error: code === 'UNAVAILABLE' ? 'Voice backend unavailable' : code === 'TIMEOUT' ? 'Voice request timed out' : code === 'CANCELED' ? 'Voice request canceled' : 'Voice request failed', code }, { status })
}

function guarded<T>(operation: () => T | PromiseLike<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', abort)
    const abort = () => { cleanup(); reject(signal.reason) }
    signal.addEventListener('abort', abort, { once: true })
    Promise.resolve().then(() => {
      if (signal.aborted) throw signal.reason
      return operation()
    }).then((value) => { cleanup(); resolve(value) }, (error) => { cleanup(); reject(error) })
  })
}

async function boundedBody(request: Request, limit: number, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  if (request.body === null) return new Uint8Array()
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const next = await guarded(() => reader.read(), signal)
      if (next.done) break
      size += next.value.byteLength
      if (size > limit) throw new VoiceRequestLimitError('Request body exceeds size limit')
      chunks.push(next.value)
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined)
    throw error
  } finally { reader.releaseLock() }
  const body = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength }
  return body
}

function boundedSignal(request: Request): { signal: AbortSignal; cancel: () => void; cleanup: () => void } {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(new VoiceBackendError('TIMEOUT', 'Voice request timed out')), VOICE_LIMITS.timeoutMs)
  const cancel = () => controller.abort(new VoiceBackendError('CANCELED', 'Voice request canceled'))
  const cleanup = () => { clearTimeout(timeout); request.signal.removeEventListener('abort', cancel) }
  if (request.signal.aborted) cancel()
  else request.signal.addEventListener('abort', cancel, { once: true })
  // Cleanup must not abort: an ordinary backend failure is not a timeout.
  return { signal: controller.signal, cancel, cleanup }
}

function discoveryResponse(backend: VoiceBackends['stt'] | VoiceBackends['tts'], field: 'models' | 'voices'): Response {
  const status = backend.status()
  const values = backend.capabilities?.()[field]
  const items = Array.isArray(values) ? values.filter((value): value is string => typeof value === 'string' && value.length > 0) : []
  return Response.json({ [field]: items, cached: false, state: status.available ? 'available' : 'unconfigured', ...status })
}

function streamError(error: unknown): VoiceBackendError {
  const code = error instanceof VoiceBackendError ? error.code : 'UNAVAILABLE'
  return new VoiceBackendError(code, code === 'TIMEOUT' ? 'Voice request timed out' : code === 'CANCELED' ? 'Voice request canceled' : 'Voice backend unavailable')
}

export async function handleVoiceRoute(request: Request, backends: VoiceBackends, authorization: VoiceAuthorization): Promise<Response | null> {
  const url = new URL(request.url)
  if (!((url.pathname === '/api/stt/status' || url.pathname === '/api/tts/status' || url.pathname === '/api/stt/models' || url.pathname === '/api/tts/models' || url.pathname === '/api/tts/voices') && request.method === 'GET') && !((url.pathname === '/api/stt/transcribe' || url.pathname === '/api/tts/synthesize') && request.method === 'POST')) return null
  try { await authorization.authorize() } catch { return errorResponse(new VoiceAuthorizationError()) }
  try {
    if (url.pathname === '/api/stt/status') return Response.json(backends.stt.status())
    if (url.pathname === '/api/tts/status') return Response.json(backends.tts.status())
    if (url.pathname === '/api/stt/models') return discoveryResponse(backends.stt, 'models')
    if (url.pathname === '/api/tts/models') return discoveryResponse(backends.tts, 'models')
    if (url.pathname === '/api/tts/voices') return discoveryResponse(backends.tts, 'voices')
  } catch (error) { return errorResponse(error) }

  const lifecycle = boundedSignal(request)
  const { signal } = lifecycle
  let streaming = false
  let iterator: AsyncIterator<Uint8Array> | undefined
  const returnIterator = () => {
    // A callback ignoring cancellation can leave next()/return() pending. Do not
    // let that prevent HTTP cancellation; local processes are terminated by signal.
    try { void Promise.resolve(iterator?.return?.()).catch(() => undefined) } catch { /* Backend cleanup is best effort. */ }
  }
  try {
    if (url.pathname === '/api/stt/transcribe') {
      const form = await guarded(async () => request.body === null ? request.formData() : new Request(request, { body: await boundedBody(request, VOICE_LIMITS.bodyBytes, signal) }).formData(), signal)
      const file = form.get('audio')
      const audioFile = file && typeof file === 'object' && 'size' in file && typeof (file as { arrayBuffer?: unknown }).arrayBuffer === 'function'
        ? file as { size: number; type?: string; arrayBuffer: () => Promise<ArrayBuffer> }
        : null
      if (!audioFile || audioFile.size > VOICE_LIMITS.audioBytes) throw new VoiceRequestLimitError('Audio exceeds size limit')
      const audio = new Uint8Array(await guarded(() => audioFile.arrayBuffer(), signal))
      if (audio.byteLength > VOICE_LIMITS.audioBytes) throw new VoiceRequestLimitError('Audio exceeds size limit')
      const result = await guarded(() => backends.stt.transcribe({ audio, mimeType: audioFile.type ?? '', language: typeof form.get('language') === 'string' ? String(form.get('language')) : undefined, signal }), signal)
      return Response.json({ text: result.final, partial: result.partial })
    }

    const bytes = await boundedBody(request, Math.min(VOICE_LIMITS.bodyBytes, VOICE_LIMITS.textChars * 4 + 1024), signal)
    const input = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>
    const text = typeof input.text === 'string' ? input.text.trim() : ''
    if (!text || text.length > VOICE_LIMITS.textChars) throw new VoiceRequestLimitError('Text exceeds size limit')
    const result = await guarded(() => backends.tts.synthesize({ text, voice: typeof input.voice === 'string' ? input.voice : undefined, model: typeof input.model === 'string' ? input.model : undefined, speed: typeof input.speed === 'number' ? input.speed : undefined, signal }), signal)
    iterator = result instanceof Uint8Array ? (async function* () { yield result })()[Symbol.asyncIterator]() : result[Symbol.asyncIterator]()
    // Surface lazy process startup failures before committing HTTP 200 headers.
    let first: IteratorResult<Uint8Array> | undefined = await guarded(() => iterator!.next(), signal)
    if (!first.done && first.value.byteLength > VOICE_LIMITS.ttsOutputBytes) throw new VoiceRequestLimitError('Audio output exceeds size limit')
    let size = 0
    let finished = false
    let streamController: ReadableStreamDefaultController<Uint8Array>
    const finish = () => {
      if (finished) return
      finished = true
      signal.removeEventListener('abort', abortStream)
      lifecycle.cleanup()
      returnIterator()
    }
    const abortStream = () => { streamController.error(streamError(signal.reason)); finish() }
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller
        signal.addEventListener('abort', abortStream, { once: true })
      },
      async pull(controller) {
        if (finished) return
        try {
          const next = first ?? await guarded(() => iterator!.next(), signal)
          first = undefined
          if (finished) return
          if (next.done) { controller.close(); finish(); return }
          if (!(next.value instanceof Uint8Array)) throw new VoiceBackendError('INVALID', 'Invalid audio output')
          size += next.value.byteLength
          if (size > VOICE_LIMITS.ttsOutputBytes) throw new VoiceBackendError('INVALID', 'Audio output exceeds size limit')
          controller.enqueue(next.value)
        } catch (error) {
          if (finished) return
          controller.error(streamError(signal.aborted ? signal.reason : error))
          finish()
          lifecycle.cancel()
        }
      },
      cancel() { finish(); lifecycle.cancel() },
    })
    streaming = true
    return new Response(stream, { headers: { 'content-type': 'audio/mpeg', 'cache-control': 'no-store' } })
  } catch (error) {
    const response = errorResponse(signal.aborted ? signal.reason : error)
    lifecycle.cancel()
    returnIterator()
    return response
  } finally { if (!streaming) lifecycle.cleanup() }
}
