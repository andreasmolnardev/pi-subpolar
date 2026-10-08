// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LOCAL_VOICE_LIMITS, ProcessSTTBackend, ProcessTTSBackend, localVoiceBackends } from './adapters.ts'

const signal = () => new AbortController().signal
const stt = (script: string) => new ProcessSTTBackend(process.execPath, ['-e', script])
const tts = (script: string) => new ProcessTTSBackend(process.execPath, ['-e', script])
async function collect(chunks: AsyncIterable<Uint8Array>) {
  const output: Uint8Array[] = []
  for await (const chunk of chunks) output.push(chunk)
  return Buffer.concat(output)
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('local process adapters (synthetic executables, no speech service)', () => {
  it('reports missing executables unavailable without exposing paths', () => {
    const missing = '/nonexistent/subpolar-voice-test-secret'
    const backends = localVoiceBackends({ sttExecutable: missing, ttsExecutable: missing })
    for (const backend of [backends.stt, backends.tts]) {
      expect(backend.status().available).toBe(false)
      expect(JSON.stringify(backend.status())).not.toContain(missing)
    }
    expect(stt('').status().available).toBe(true)
    expect(localVoiceBackends().stt.status().available).toBe(false)
  })

  it('reads raw audio and forwards MIME/language metadata, removing abort listeners', async () => {
    const inputSignal = signal()
    const remove = vi.spyOn(inputSignal, 'removeEventListener')
    const backend = stt("const chunks=[]; process.stdin.on('data', c=>chunks.push(c)); process.stdin.on('end', ()=>process.stdout.write(JSON.stringify({final:Buffer.concat(chunks).toString(),partial:process.env.SUBPOLAR_VOICE_AUDIO_MIME_TYPE+':'+process.env.SUBPOLAR_VOICE_AUDIO_LANGUAGE})))")
    expect(await backend.transcribe({ audio: new TextEncoder().encode('synthetic audio'), mimeType: 'audio/webm', language: 'en', signal: inputSignal })).toEqual({ final: 'synthetic audio', partial: 'audio/webm:en' })
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
  })

  it.each(['{}', 'null', '[]', '{"final":5}', '{"final":"ok","partial":5}', 'not json'])('rejects malformed STT output %s', async (output) => {
    await expect(stt(`process.stdin.resume(); process.stdin.on('end',()=>process.stdout.write(${JSON.stringify(output)}))`).transcribe({ audio: new Uint8Array(), mimeType: 'audio/wav', signal: signal() })).rejects.toMatchObject({ code: 'INVALID' })
  })

  it('bounds STT stdout rather than retaining unlimited transcript data', async () => {
    await expect(stt(`process.stdin.resume(); process.stdin.on('end',()=>process.stdout.write('x'.repeat(${LOCAL_VOICE_LIMITS.sttOutputBytes + 1})))`).transcribe({ audio: new Uint8Array(), mimeType: 'audio/wav', signal: signal() })).rejects.toMatchObject({ code: 'INVALID' })
  })

  it('sends TTS metadata as JSON and handles fast process exit', async () => {
    const backend = tts("let input=''; process.stdin.on('data',c=>input+=c); process.stdin.on('end',()=>process.stdout.write(input))")
    const bytes = await collect(backend.synthesize({ text: 'hello', model: 'local', voice: 'default', speed: 1.2, signal: signal() }))
    expect(JSON.parse(bytes.toString())).toEqual({ text: 'hello', model: 'local', voice: 'default', speed: 1.2 })
  })

  it.each(['stt', 'tts'] as const)('maps missing %s executable and stdin failure without unhandled errors', async (kind) => {
    const backends = localVoiceBackends({ sttExecutable: '/nonexistent/voice-secret', ttsExecutable: '/nonexistent/voice-secret' })
    const result = kind === 'stt' ? backends.stt.transcribe({ audio: new Uint8Array(1024), mimeType: 'audio/wav', signal: signal() }) : collect(new ProcessTTSBackend('/nonexistent/voice-secret').synthesize({ text: 'hello', signal: signal() }))
    await expect(result).rejects.toMatchObject({ code: 'UNAVAILABLE' })
    await expect(result).rejects.not.toThrow('voice-secret')
  })

  it('rejects empty successful output rather than returning unusable audio', async () => {
    await expect(collect(tts("process.stdin.resume();process.stdin.on('end',()=>process.exit(0))").synthesize({ text: 'hello', signal: signal() }))).rejects.toMatchObject({ code: 'INVALID' })
  })

  it('maps nonzero exit to a sanitized backend failure', async () => {
    const output = collect(tts("process.stdin.resume(); process.stdin.on('end',()=>{process.stderr.write('private text');process.exit(2)})").synthesize({ text: 'hello', signal: signal() }))
    await expect(output).rejects.toMatchObject({ code: 'UNAVAILABLE' })
    await expect(output).rejects.not.toThrow('private text')
  })

  it('rejects pre-aborted STT and TTS without starting work', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(stt('process.exit(0)').transcribe({ audio: new Uint8Array(), mimeType: 'audio/wav', signal: controller.signal })).rejects.toMatchObject({ code: 'CANCELED' })
    await expect(collect(tts('process.exit(0)').synthesize({ text: 'hello', signal: controller.signal }))).rejects.toMatchObject({ code: 'CANCELED' })
  })

  it('cancels a blocked iterator and kills a child ignoring SIGTERM after the grace period', async () => {
    const controller = new AbortController()
    const iterator = tts("process.on('SIGTERM',()=>{});process.stdout.write(String(process.pid));setInterval(()=>{},1000)").synthesize({ text: 'hello', signal: controller.signal })[Symbol.asyncIterator]()
    const first = await iterator.next()
    const pid = Number(Buffer.from(first.value!).toString())
    const pending = iterator.next()
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'CANCELED' })
    await new Promise((resolve) => setTimeout(resolve, LOCAL_VOICE_LIMITS.killGraceMs + 300))
    expect(() => process.kill(pid, 0)).toThrow()
  })

  it('enforces a deadline even when the child never writes or closes stdout', async () => {
    vi.useFakeTimers()
    const output = collect(tts('setInterval(()=>{},1000)').synthesize({ text: 'hello', signal: signal() }))
    const assertion = expect(output).rejects.toMatchObject({ code: 'TIMEOUT' })
    await vi.advanceTimersByTimeAsync(LOCAL_VOICE_LIMITS.timeoutMs)
    await assertion
    await vi.advanceTimersByTimeAsync(LOCAL_VOICE_LIMITS.killGraceMs)
  })

  it('bounds TTS stdout and direct adapter inputs', async () => {
    await expect(collect(tts(`process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(Buffer.alloc(${LOCAL_VOICE_LIMITS.ttsOutputBytes + 1})))`).synthesize({ text: 'hello', signal: signal() }))).rejects.toMatchObject({ code: 'INVALID' })
    await expect(stt('').transcribe({ audio: new Uint8Array(LOCAL_VOICE_LIMITS.audioBytes + 1), mimeType: 'audio/wav', signal: signal() })).rejects.toMatchObject({ code: 'INVALID' })
    expect(() => tts('').synthesize({ text: 'x'.repeat(LOCAL_VOICE_LIMITS.textChars + 1), signal: signal() })).toThrow('Text exceeds size limit')
  })
})
