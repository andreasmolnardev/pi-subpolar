import { VoiceAuthorizationError, VoiceBackendError, type VoiceAuthorization, type VoiceBackends } from './contracts.ts'

export const VOICE_LIMITS = { audioBytes: 10 * 1024 * 1024, multipartOverheadBytes: 64 * 1024, bodyBytes: 10 * 1024 * 1024 + 64 * 1024, textChars: 32_000, timeoutMs: 30_000 } as const

class VoiceRequestLimitError extends Error {}

function errorResponse(error: unknown): Response {
  const code = error instanceof VoiceBackendError ? error.code : 'FAILED'
  const status = error instanceof VoiceAuthorizationError ? 403 : error instanceof VoiceRequestLimitError ? 413 : code === 'UNAVAILABLE' ? 503 : code === 'TIMEOUT' ? 408 : code === 'CANCELED' ? 499 : 400
  if (error instanceof VoiceAuthorizationError) return Response.json({ error: 'Voice access is not permitted', code: 'FORBIDDEN' }, { status })
  return Response.json({ error: code === 'UNAVAILABLE' ? 'Voice backend unavailable' : code === 'TIMEOUT' ? 'Voice request timed out' : code === 'CANCELED' ? 'Voice request canceled' : 'Voice request failed', code }, { status })
}

async function boundedBody(request: Request, limit: number): Promise<Uint8Array> {
  if (request.body === null) return new Uint8Array()
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > limit) throw new VoiceRequestLimitError('Request body exceeds size limit')
      chunks.push(next.value)
    }
  } finally { reader.releaseLock() }
  const body = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength }
  return body
}

function boundedSignal(request: Request): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), VOICE_LIMITS.timeoutMs)
  const cancel = () => { clearTimeout(timeout); controller.abort() }
  request.signal.addEventListener('abort', cancel, { once: true })
  return { signal: controller.signal, cancel }
}

function discoveryResponse(backend: VoiceBackends['stt'] | VoiceBackends['tts'], field: 'models' | 'voices'): Response {
  const status = backend.status()
  const values = backend.capabilities?.()[field]
  const items = Array.isArray(values) ? values.filter((value): value is string => typeof value === 'string' && value.length > 0) : []
  return Response.json({
    [field]: items,
    cached: false,
    state: status.available ? 'available' : 'unconfigured',
    ...status,
  })
}

export async function handleVoiceRoute(request: Request, backends: VoiceBackends, authorization: VoiceAuthorization): Promise<Response | null> {
  const url = new URL(request.url)
  if (!((url.pathname === '/api/stt/status' || url.pathname === '/api/tts/status' || url.pathname === '/api/stt/models' || url.pathname === '/api/tts/models' || url.pathname === '/api/tts/voices') && request.method === 'GET') && !((url.pathname === '/api/stt/transcribe' || url.pathname === '/api/tts/synthesize') && request.method === 'POST')) return null
  try { await authorization.authorize() } catch { return errorResponse(new VoiceAuthorizationError()) }
  if (url.pathname === '/api/stt/status' && request.method === 'GET') return Response.json(backends.stt.status())
  if (url.pathname === '/api/tts/status' && request.method === 'GET') return Response.json(backends.tts.status())
  if (url.pathname === '/api/stt/models' && request.method === 'GET') return discoveryResponse(backends.stt, 'models')
  if (url.pathname === '/api/tts/models' && request.method === 'GET') return discoveryResponse(backends.tts, 'models')
  if (url.pathname === '/api/tts/voices' && request.method === 'GET') return discoveryResponse(backends.tts, 'voices')
  if (url.pathname === '/api/stt/transcribe' && request.method === 'POST') {
    const { signal, cancel } = boundedSignal(request)
    try {
      const form = request.body === null ? await request.formData() : await new Request(request, { body: await boundedBody(request, VOICE_LIMITS.bodyBytes) }).formData()
      const file = form.get('audio')
      const audioFile = file && typeof file === 'object' && 'size' in file && typeof (file as { arrayBuffer?: unknown }).arrayBuffer === 'function'
        ? file as { size: number; type?: string; arrayBuffer: () => Promise<ArrayBuffer> }
        : null
      if (!audioFile || audioFile.size > VOICE_LIMITS.audioBytes) return Response.json({ error: 'Audio exceeds size limit', code: 'SIZE_LIMIT' }, { status: 413 })
      const result = await backends.stt.transcribe({ audio: new Uint8Array(await audioFile.arrayBuffer()), mimeType: audioFile.type ?? '', language: typeof form.get('language') === 'string' ? String(form.get('language')) : undefined, signal })
      return Response.json({ text: result.final, partial: result.partial })
    } catch (error) { if (error instanceof VoiceRequestLimitError) return errorResponse(error); if (signal.aborted && request.signal.aborted) return errorResponse(new VoiceBackendError('CANCELED', 'Voice request canceled')); if (signal.aborted) return errorResponse(new VoiceBackendError('TIMEOUT', 'Voice request timed out')); return errorResponse(error) }
    finally { cancel() }
  }
  if (url.pathname === '/api/tts/synthesize' && request.method === 'POST') {
    const { signal, cancel } = boundedSignal(request)
    try {
      const bytes = await boundedBody(request, Math.min(VOICE_LIMITS.bodyBytes, VOICE_LIMITS.textChars * 4 + 1024))
      const input = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>
      const text = typeof input.text === 'string' ? input.text.trim() : ''
      if (!text || text.length > VOICE_LIMITS.textChars) return Response.json({ error: 'Text exceeds size limit', code: 'SIZE_LIMIT' }, { status: 413 })
      const result = await backends.tts.synthesize({ text, voice: typeof input.voice === 'string' ? input.voice : undefined, model: typeof input.model === 'string' ? input.model : undefined, speed: typeof input.speed === 'number' ? input.speed : undefined, signal })
      const stream = result instanceof Uint8Array
        ? new ReadableStream({ start(controller) { controller.enqueue(result); controller.close(); cancel() } })
        : new ReadableStream({ async start(controller) { const iterator = result[Symbol.asyncIterator](); try { while (true) { if (signal.aborted) throw new VoiceBackendError('CANCELED', 'Voice request canceled'); const next = await iterator.next(); if (next.done) break; controller.enqueue(next.value) } controller.close(); cancel() } catch (error) { cancel(); controller.error(error) } finally { await iterator.return?.() } }, cancel() { cancel() } })
      return new Response(stream, { headers: { 'content-type': 'audio/mpeg', 'cache-control': 'no-store' } })
    } catch (error) { cancel(); if (error instanceof VoiceRequestLimitError) return errorResponse(error); if (signal.aborted && request.signal.aborted) return errorResponse(new VoiceBackendError('CANCELED', 'Voice request canceled')); if (signal.aborted) return errorResponse(new VoiceBackendError('TIMEOUT', 'Voice request timed out')); return errorResponse(error) }
  }
  return null
}
