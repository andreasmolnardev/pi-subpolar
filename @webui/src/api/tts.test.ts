import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ttsApi } from './tts'

describe('tts session propagation', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new Blob(['audio']), {
      headers: { 'Content-Type': 'audio/wav' },
    })))
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('propagates the active session ID on synthesis requests', async () => {
    window.history.pushState({}, '', '/projects/1/sessions/session-tts')

    await ttsApi.synthesize('hello', 'arbitrary-user')

    expect(Object.fromEntries((fetch as ReturnType<typeof vi.fn>).mock.calls[0][1]?.headers as Headers)).toEqual({
      'content-type': 'application/json',
      'x-session-id': 'session-tts',
    })
  })

  it('omits session context when no session is active', async () => {
    window.history.pushState({}, '', '/settings')

    await ttsApi.synthesize('hello', 'arbitrary-user')

    expect(Object.fromEntries((fetch as ReturnType<typeof vi.fn>).mock.calls[0][1]?.headers as Headers)).toEqual({
      'content-type': 'application/json',
    })
  })
})
