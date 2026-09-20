import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SubpolarClient } from './subpolar'

describe('SubpolarClient', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('treats empty successful session deletes as success', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }))

    await expect(new SubpolarClient('/api/opencode', '/repo').deleteSession('ses_1')).resolves.toBeUndefined()

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost/api/sessions/ses_1?directory=%2Frepo',
      expect.objectContaining({ method: 'DELETE' }),
    )
  })

  it('sends the selected permission when creating the first session', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      session: {
        id: 'ses_1',
        runtime: 'pi',
        runtimeSessionId: null,
        profile: 'assistant',
        permissionOverride: 'ask',
      },
    }), { status: 201 }))

    await new SubpolarClient('/api/opencode', '/repo').createSession({
      agent: 'assistant',
      model: 'openai/gpt-4.1',
      permission: 'ask',
    })

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      agent: 'assistant',
      model: 'openai/gpt-4.1',
      permission: 'ask',
      runtime: 'pi',
      directory: '/repo',
    })
  })

  it('deletes workspaces with directory routing', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }))

    await expect(new SubpolarClient('/api/opencode', '/repo').deleteWorkspace('wrk_stale')).resolves.toBeUndefined()

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost/api/opencode/experimental/workspace/wrk_stale?directory=%2Frepo',
      expect.objectContaining({ method: 'DELETE' }),
    )
  })

  it('preserves text error responses', async () => {
    fetchMock.mockResolvedValue(new Response('Workspace not found: wrk_stale', { status: 500 }))

    await expect(new SubpolarClient('/api/opencode', '/repo').deleteSession('ses_1')).rejects.toThrow(
      'Workspace not found: wrk_stale',
    )
  })

  describe('listSessionsPage', () => {
    it('returns adapted sessions from the native API response', async () => {
      fetchMock.mockResolvedValue(
        new Response(
          JSON.stringify({
            sessions: [
              {
                id: 'ses_1',
                projectId: 7,
                directory: '/my-repo',
                title: 'V2 Session',
                createdAt: 3000,
                updatedAt: 4000,
              },
            ],
          }),
          { status: 200 },
        ),
      )

      const result = await new SubpolarClient('/api/opencode', '/repo').listSessionsPage({ limit: 10 })

      expect(result.items).toHaveLength(1)
      expect(result.items[0]).toMatchObject({
        id: 'ses_1',
        projectID: '7',
        directory: '/my-repo',
        title: 'V2 Session',
        version: 'pi',
        time: { created: 3000, updated: 4000 },
      })
    })

    it('sends first-page params to /api/sessions with directory and returns adapted sessions', async () => {
      fetchMock.mockResolvedValue(
        new Response(
          JSON.stringify({
            sessions: [
              {
                id: 'ses_1',
                projectId: 1,
                directory: '/repo',
                title: 'My Session',
                createdAt: 1000,
                updatedAt: 2000,
              },
            ],
          }),
          { status: 200 },
        ),
      )

      const result = await new SubpolarClient('/api/opencode', '/repo').listSessionsPage({
        limit: 25,
        order: 'desc',
        search: 'deploy',
      })

      expect(fetchMock).toHaveBeenCalledWith(
        'http://localhost/api/sessions?limit=25&order=desc&search=deploy&directory=%2Frepo',
        expect.any(Object),
      )
      expect(result.items).toHaveLength(1)
      expect(result.items[0]).toMatchObject({
        id: 'ses_1',
        projectID: '1',
        directory: '/repo',
        title: 'My Session',
        version: 'pi',
        time: { created: 1000, updated: 2000 },
      })
    })

    it('sends cursor requests with native session params', async () => {
      fetchMock.mockResolvedValue(
        new Response(
          JSON.stringify({
            sessions: [],
          }),
          { status: 200 },
        ),
      )

      await new SubpolarClient('/api/opencode', '/repo').listSessionsPage({ cursor: 'cursor_123' })

      expect(fetchMock).toHaveBeenCalledWith(
        'http://localhost/api/sessions?cursor=cursor_123&directory=%2Frepo',
        expect.any(Object),
      )
    })

    it('exposes additive page metadata without changing the item adapter', async () => {
      fetchMock.mockResolvedValue(new Response(JSON.stringify({
        sessions: [{ id: 'ses_1', title: 'First', updatedAt: 10 }],
        nextCursor: 'cursor_2',
        page: { limit: 1, order: 'desc', hasNext: true, nextCursor: 'cursor_2' },
      }), { status: 200 }))

      await expect(new SubpolarClient('/api/opencode').listSessionsPage({ limit: 1 })).resolves.toMatchObject({
        nextCursor: 'cursor_2',
        page: { limit: 1, order: 'desc', hasNext: true },
        items: [{ id: 'ses_1' }],
      })
    })

    it('uses Untitled Session for empty title', async () => {
      fetchMock.mockResolvedValue(
        new Response(
          JSON.stringify({
            sessions: [
              {
                id: 'ses_2',
                projectId: 2,
                title: '',
                createdAt: 1000,
                updatedAt: 2000,
              },
            ],
          }),
          { status: 200 },
        ),
      )

      const result = await new SubpolarClient('/api/opencode', '/repo').listSessionsPage()

      expect(result.items[0].title).toBe('Untitled Session')
    })

    it('works without directory set', async () => {
      fetchMock.mockResolvedValue(
        new Response(
          JSON.stringify({
            sessions: [
              {
                id: 'ses_3',
                projectId: 3,
                title: 'No Dir',
                createdAt: 1000,
                updatedAt: 2000,
              },
            ],
          }),
          { status: 200 },
        ),
      )

      const result = await new SubpolarClient('/api/opencode').listSessionsPage({ limit: 5 })

      expect(fetchMock).toHaveBeenCalledWith(
        'http://localhost/api/sessions?limit=5',
        expect.any(Object),
      )
      expect(result.items[0].directory).toBe('')
    })
  })

  it('queues prompts through native message and run endpoints', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 201 }))

    await expect(
      new SubpolarClient('/api/opencode', '/repo').sendPromptAsync('ses_1', {
        parts: [{ type: 'text', text: 'Hello Pi' }],
        agent: 'build',
        model: { providerID: 'openai', modelID: 'gpt-4.1' },
      }),
    ).resolves.toBeUndefined()

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'http://localhost/api/sessions/ses_1/messages?directory=%2Frepo',
      expect.objectContaining({
        method: 'POST',
      }),
    )
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      role: 'user',
      content: 'Hello Pi',
      metadata: {
        agent: 'build',
        model: { providerID: 'openai', modelID: 'gpt-4.1' },
      },
    })
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'http://localhost/api/sessions/ses_1/runs?directory=%2Frepo',
      expect.objectContaining({
        method: 'POST',
      }),
    )
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({
      runtime: 'pi',
      agentId: 'build',
      model: { providerID: 'openai', modelID: 'gpt-4.1' },
    })
  })

  it('sends immediate prompts through the same native endpoints with the client message ID', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 201 }))

    await expect(
      new SubpolarClient('/api/opencode', '/repo').sendPrompt('ses_1', {
        parts: [{ type: 'text', text: 'Immediate hello' }],
        messageID: 'optimistic_user_immediate',
      }),
    ).resolves.toEqual({ messageID: 'optimistic_user_immediate', state: 'completed' })

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      messageID: 'optimistic_user_immediate',
      content: 'Immediate hello',
    })
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'http://localhost/api/sessions/ses_1/runs?directory=%2Frepo',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('rejects an interrupted delivery instead of clearing the first-send handoff', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ messageID: 'optimistic_user_stale', state: 'pending' }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: false,
        messageID: 'optimistic_user_stale',
        state: 'interrupted',
        error: {
          code: 'DELIVERY_INTERRUPTED',
          message: 'This delivery was interrupted before its outcome was known. It was not retried automatically. Resend the prompt to try again.',
          recoverable: true,
        },
      }), { status: 200 }))

    await expect(new SubpolarClient('/api/opencode', '/repo').sendPromptAsync('ses_1', {
      parts: [{ type: 'text', text: 'Do not lose this prompt' }],
      messageID: 'optimistic_user_stale',
    })).rejects.toMatchObject({ code: 'DELIVERY_INTERRUPTED', statusCode: 409 })
  })

  it('accepts a running delivery as in-flight', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ messageID: 'message_running', state: 'pending' }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        messageID: 'message_running',
        state: 'running',
      }), { status: 200 }))

    await expect(new SubpolarClient('/api/opencode', '/repo').sendPromptAsync('ses_1', {
      parts: [{ type: 'text', text: 'Keep this in flight' }],
      messageID: 'message_running',
    })).resolves.toBeUndefined()
  })

  it('rejects an unknown delivery as recoverable uncertainty', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ messageID: 'message_unknown', state: 'pending' }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: false,
        messageID: 'message_unknown',
        state: 'unknown',
        error: {
          code: 'DELIVERY_UNKNOWN',
          message: 'The delivery outcome is unknown.',
          recoverable: true,
        },
      }), { status: 200 }))

    await expect(new SubpolarClient('/api/opencode', '/repo').sendPromptAsync('ses_1', {
      parts: [{ type: 'text', text: 'Handle the unknown outcome' }],
      messageID: 'message_unknown',
    })).rejects.toMatchObject({ code: 'DELIVERY_UNKNOWN', statusCode: 409 })
  })

  it('accepts completed delivery metadata without hiding the native RPC response', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ messageID: 'message_1', state: 'pending' }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        type: 'response',
        id: 'rpc_1',
        success: true,
        data: { value: 1 },
        delivery: { ok: true, messageID: 'message_1', state: 'completed' },
      }), { status: 200 }))

    await expect(new SubpolarClient('/api/opencode', '/repo').sendPromptAsync('ses_1', {
      parts: [{ type: 'text', text: 'Compatibility check' }],
    })).resolves.toBeUndefined()
  })

  it('reconstructs split reasoning blocks around tool calls', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          messages: [
            {
              id: 'msg_1',
              role: 'assistant',
              content: 'Final answer',
              createdAt: 1000,
              metadata: {
                completedAt: 2000,
                assistantParts: [
                  { type: 'reasoning', id: 'msg_1-reasoning-0', text: 'First thought' },
                  {
                    type: 'tool',
                    id: 'msg_1-tool-call_1',
                    callID: 'call_1',
                    tool: 'task',
                    state: { status: 'completed', input: {}, output: 'done', time: { start: 1100, end: 1200 } },
                  },
                  { type: 'reasoning', id: 'msg_1-reasoning-1', text: 'Second thought' },
                  { type: 'text', id: 'msg_1-text-0', text: 'Final answer' },
                ],
                tools: [
                  { callID: 'call_1', tool: 'task', state: { status: 'completed', input: {}, output: 'done', time: { start: 1100, end: 1200 } } },
                ],
              },
            },
          ],
        }),
        { status: 200 },
      ),
    )

    const result = await new SubpolarClient('/api/opencode', '/repo').listMessages('ses_1')

    expect(result[0].parts).toHaveLength(5)
    expect(result[0].parts[0]).toMatchObject({ type: 'reasoning', text: 'First thought' })
    expect(result[0].parts[1]).toMatchObject({ type: 'tool', callID: 'call_1' })
    expect(result[0].parts[2]).toMatchObject({ type: 'reasoning', text: 'Second thought' })
    expect(result[0].parts[3]).toMatchObject({ type: 'text', text: 'Final answer' })
    expect(result[0].parts[4]).toMatchObject({ type: 'step-finish' })
  })
})
