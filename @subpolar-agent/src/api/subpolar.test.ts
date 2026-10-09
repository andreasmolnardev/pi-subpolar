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

  it('lists sessions through the shared client with supported filters and legacy adaptation', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      sessions: [{ id: 'ses_1', title: 'General Chat session', projectId: 0, directory: '/selected', createdAt: 10, updatedAt: 20 }],
    }), { status: 200 }))

    const client = new SubpolarClient('/api', '/selected')
    const sessions = await client.listSessions({
      directory: '/other', project: 'General Chat', search: 'chat', order: 'asc', limit: 7, roots: true,
    })

    const url = new URL(String(fetchMock.mock.calls[0]?.[0]))
    expect(url.pathname).toBe('/api/sessions')
    expect(url.searchParams.get('directory')).toBe('/selected')
    expect(url.searchParams.get('project')).toBe('General Chat')
    expect(url.searchParams.get('search')).toBe('chat')
    expect(url.searchParams.get('order')).toBe('asc')
    expect(url.searchParams.get('limit')).toBe('7')
    expect(url.searchParams.has('roots')).toBe(false)
    expect(sessions[0]).toMatchObject({
      id: 'ses_1', projectID: 'default', directory: '/selected', title: 'General Chat session',
      version: 'pi', time: { created: 10, updated: 20 },
    })
  })

  it('reads sessions through the shared client with directory routing and legacy adaptation', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      id: 'ses/a', title: 'Read session', projectId: 4, directory: '/repo', createdAt: 100, updatedAt: 200,
      profile: 'assistant', model: 'openai/gpt-4.1', permissionOverride: 'ask', workspaceAvailable: true,
    }), { status: 200 }))

    const session = await new SubpolarClient('/api', '/repo').getSession('ses/a')

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost/api/sessions/ses%2Fa?directory=%2Frepo',
      expect.any(Object),
    )
    expect(session).toMatchObject({
      id: 'ses/a', projectID: '4', directory: '/repo', title: 'Read session',
      version: 'pi', time: { created: 100, updated: 200 }, profile: 'assistant',
      model: 'openai/gpt-4.1', permissionOverride: 'ask', workspaceAvailable: true,
    })
  })

  it('aborts sessions through the authenticated shared API route', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 200 }))

    await expect(new SubpolarClient('/api', '/repo').abortSession('ses/a')).resolves.toEqual({ success: true })

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost/api/sessions/ses%2Fa/abort',
      expect.objectContaining({ method: 'POST', credentials: 'include', cache: 'no-store' }),
    )
  })

  it('treats empty successful session deletes as success', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }))

    await expect(new SubpolarClient('/api', '/repo').deleteSession('ses_1')).resolves.toBeUndefined()

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost/api/sessions/ses_1?directory=%2Frepo',
      expect.objectContaining({ method: 'DELETE' }),
    )
  })

  it('loads agents from the canonical agents route', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify([
      { name: 'master', mode: 'primary', description: 'Default', systemPrompt: 'Be helpful' },
    ]), { status: 200 }))

    await expect(new SubpolarClient('/api', '/repo').listAgents()).resolves.toEqual([
      { name: 'master', mode: 'primary', description: 'Default', systemPrompt: 'Be helpful' },
    ])

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost/api/agents?directory=%2Frepo',
      expect.any(Object),
    )
  })

  it('maps user settings to the config shape used by active callers', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      preferences: { defaultModel: 'openai/gpt-4.1', defaultAgent: 'assistant' },
    }), { status: 200 }))

    await expect(new SubpolarClient('/api', '/repo').getConfig()).resolves.toMatchObject({
      model: 'openai/gpt-4.1',
      default_agent: 'assistant',
      default_permission: 'ask',
    })

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost/api/settings',
      expect.any(Object),
    )
  })

  it('updates user settings through the shared client with the preferences envelope', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      preferences: { defaultModel: 'openai/gpt-4.1', defaultAgent: 'assistant' },
      updatedAt: 123,
    }), { status: 200 }))

    const config = { model: 'openai/gpt-4.1', default_agent: 'assistant' }
    await expect(new SubpolarClient('/api', '/repo').updateConfig(config)).resolves.toMatchObject({
      defaultModel: 'openai/gpt-4.1',
      defaultAgent: 'assistant',
    })

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost/api/settings',
      expect.objectContaining({ method: 'PATCH' }),
    )
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ preferences: config })
  })

  it('does not query the removed command route', async () => {
    await expect(new SubpolarClient('/api').listCommands()).resolves.toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('creates through the shared route with routing and execution fields, without a runtime bypass', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      session: {
        id: 'ses_1', title: 'Created', directory: '/repo', projectId: 'project-1',
        profile: 'assistant', model: 'openai/gpt-4.1:high', permissionOverride: 'ask', worktreeId: 'owned-worktree',
        createdAt: 10, updatedAt: 20,
      },
    }), { status: 201 }))

    const session = await new SubpolarClient('/api', '/repo').createSession({
      project: 'General Chat',
      title: 'Created',
      agent: 'assistant',
      model: 'openai/gpt-4.1',
      thinking: 'high',
      permission: 'ask',
      repositoryId: 'linked-repository',
      worktreeId: 'owned-worktree',
    })

    expect(fetchMock).toHaveBeenCalledWith('http://localhost/api/sessions', expect.any(Object))
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      project: 'General Chat',
      title: 'Created',
      agent: 'assistant',
      model: 'openai/gpt-4.1',
      thinking: 'high',
      permission: 'ask',
      repositoryId: 'linked-repository',
      worktreeId: 'owned-worktree',
      directory: '/repo',
    })
    expect(session).toMatchObject({
      id: 'ses_1', directory: '/repo', profile: 'assistant', model: 'openai/gpt-4.1:high',
      permissionOverride: 'ask', version: 'pi', time: { created: 10, updated: 20 },
    })
  })

  it('updates and archives through the shared client, retaining directory and envelope semantics', async () => {
    const response = () => new Response(JSON.stringify({ session: { id: 'ses/1', title: 'Renamed', updatedAt: 20 } }), { status: 200 })
    fetchMock.mockResolvedValueOnce(response()).mockResolvedValueOnce(response())
    const client = new SubpolarClient('/api', '/repo')

    await expect(client.updateSession('ses/1', { title: 'Renamed' })).resolves.toMatchObject({
      session: { id: 'ses/1', title: 'Renamed' },
    })
    await expect(client.archiveSession('ses/1', true)).resolves.toMatchObject({
      session: { id: 'ses/1', title: 'Renamed' },
    })

    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      'http://localhost/api/sessions/ses%2F1?directory=%2Frepo',
      'http://localhost/api/sessions/ses%2F1?directory=%2Frepo',
    ])
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ title: 'Renamed' })
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({ archived: true })
  })

  it('deletes workspaces with directory routing', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }))

    await expect(new SubpolarClient('/api', '/repo').deleteWorkspace('wrk_stale')).resolves.toBeUndefined()

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost/api/experimental/workspace/wrk_stale?directory=%2Frepo',
      expect.objectContaining({ method: 'DELETE' }),
    )
  })

  it('preserves text error responses', async () => {
    fetchMock.mockResolvedValue(new Response('Workspace not found: wrk_stale', { status: 500 }))

    await expect(new SubpolarClient('/api', '/repo').deleteSession('ses_1')).rejects.toThrow(
      'Workspace not found: wrk_stale',
    )
  })

  describe('listSessionsPage', () => {
    it('uses the shared client and retains cursor-only pagination with directory routing', async () => {
      fetchMock.mockResolvedValue(new Response(JSON.stringify({
        sessions: [{ id: 'ses_2', title: 'Next page', updatedAt: 42 }],
        nextCursor: 'cursor_next',
        page: { limit: 3, order: 'desc', hasNext: true, nextCursor: 'cursor_next' },
      }), { status: 200 }))

      const result = await new SubpolarClient('/api', '/repo').listSessionsPage({
        cursor: 'cursor_current', limit: 99, order: 'asc', search: 'ignored-after-cursor',
      })

      const url = new URL(String(fetchMock.mock.calls[0]?.[0]))
      expect(url.pathname).toBe('/api/sessions')
      expect([...url.searchParams.entries()]).toEqual([['directory', '/repo'], ['cursor', 'cursor_current']])
      expect(result).toMatchObject({
        items: [{ id: 'ses_2', directory: '/repo', title: 'Next page', version: 'pi' }],
        nextCursor: 'cursor_next',
        page: { limit: 3, order: 'desc', hasNext: true },
      })
    })
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

      const result = await new SubpolarClient('/api', '/repo').listSessionsPage({ limit: 10 })

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

      const result = await new SubpolarClient('/api', '/repo').listSessionsPage({
        limit: 25,
        order: 'desc',
        search: 'deploy',
      })

      expect(fetchMock).toHaveBeenCalledWith(
        'http://localhost/api/sessions?directory=%2Frepo&limit=25&order=desc&search=deploy',
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

      await new SubpolarClient('/api', '/repo').listSessionsPage({ cursor: 'cursor_123' })

      expect(fetchMock).toHaveBeenCalledWith(
        'http://localhost/api/sessions?directory=%2Frepo&cursor=cursor_123',
        expect.any(Object),
      )
    })

    it('exposes additive page metadata without changing the item adapter', async () => {
      fetchMock.mockResolvedValue(new Response(JSON.stringify({
        sessions: [{ id: 'ses_1', title: 'First', updatedAt: 10 }],
        nextCursor: 'cursor_2',
        page: { limit: 1, order: 'desc', hasNext: true, nextCursor: 'cursor_2' },
      }), { status: 200 }))

      await expect(new SubpolarClient('/api').listSessionsPage({ limit: 1 })).resolves.toMatchObject({
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

      const result = await new SubpolarClient('/api', '/repo').listSessionsPage()

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

      const result = await new SubpolarClient('/api').listSessionsPage({ limit: 5 })

      expect(fetchMock).toHaveBeenCalledWith(
        'http://localhost/api/sessions?limit=5',
        expect.any(Object),
      )
      expect(result.items[0].directory).toBe('')
    })
  })

  it('queues prompts through the shared canonical message and run operation', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ messageID: 'msg_hello', state: 'pending' }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, messageID: 'msg_hello', state: 'completed' }), { status: 200 }))

    await expect(
      new SubpolarClient('/api', '/repo').sendPromptAsync('ses_1', {
        parts: [{ type: 'text', text: 'Hello Pi' }],
        agent: 'build',
        model: { providerID: 'openai', modelID: 'gpt-4.1' },
        permission: 'allow_all',
        routing: true,
      }),
    ).resolves.toBeUndefined()

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'http://localhost/api/sessions/ses_1/messages',
      expect.objectContaining({
        method: 'POST',
      }),
    )
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      content: 'Hello Pi',
      metadata: {
        agent: 'build',
        model: { providerID: 'openai', modelID: 'gpt-4.1' },
        permission: 'allow_all',
        routing: true,
      },
    })
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).not.toHaveProperty('runtime')
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'http://localhost/api/sessions/ses_1/runs',
      expect.objectContaining({
        method: 'POST',
      }),
    )
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({ messageID: 'msg_hello' })
  })

  it('sends immediate prompts through the same native endpoints with the client message ID', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ messageID: 'optimistic_user_immediate', state: 'pending' }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, messageID: 'optimistic_user_immediate', state: 'completed' }), { status: 200 }))

    await expect(
      new SubpolarClient('/api', '/repo').sendPrompt('ses_1', {
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
      'http://localhost/api/sessions/ses_1/runs',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      messageID: 'optimistic_user_immediate',
      metadata: {},
    })
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({ messageID: 'optimistic_user_immediate' })
  })

  it('lists pending permissions through the shared approval route with the OpenCode response shape', async () => {
    const permissions = [{
      id: 'approval_1', sessionID: 'ses_1', permission: 'builtin/write', patterns: ['builtin/write'],
      metadata: { toolId: 'builtin/write', input: { path: '/repo/file' }, reason: 'Approval required' }, always: [],
    }]
    fetchMock.mockResolvedValue(new Response(JSON.stringify(permissions), { status: 200 }))

    await expect(new SubpolarClient('/api', '/repo').listPendingPermissions()).resolves.toEqual(permissions)

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost/api/permission?directory=%2Frepo',
      expect.any(Object),
    )
  })

  it('responds to permissions through the shared approval route with directory routing', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true, approval: { id: 'approval_1', status: 'approved' } }), { status: 200 }))

    await expect(new SubpolarClient('/api', '/repo').respondToPermission('ses_1', 'approval_1', 'once')).resolves.toEqual({
      ok: true, approval: { id: 'approval_1', status: 'approved' },
    })

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost/api/session/ses_1/permissions/approval_1?directory=%2Frepo',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ response: 'once' }),
      }),
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

    await expect(new SubpolarClient('/api', '/repo').sendPromptAsync('ses_1', {
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

    await expect(new SubpolarClient('/api', '/repo').sendPromptAsync('ses_1', {
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

    await expect(new SubpolarClient('/api', '/repo').sendPromptAsync('ses_1', {
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

    await expect(new SubpolarClient('/api', '/repo').sendPromptAsync('ses_1', {
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

    const result = await new SubpolarClient('/api', '/repo').listMessages('ses_1')

    expect(result[0].parts).toHaveLength(5)
    expect(result[0].parts[0]).toMatchObject({ type: 'reasoning', text: 'First thought' })
    expect(result[0].parts[1]).toMatchObject({ type: 'tool', callID: 'call_1' })
    expect(result[0].parts[2]).toMatchObject({ type: 'reasoning', text: 'Second thought' })
    expect(result[0].parts[3]).toMatchObject({ type: 'text', text: 'Final answer' })
    expect(result[0].parts[4]).toMatchObject({ type: 'step-finish' })
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost/api/sessions/ses_1/messages',
      expect.objectContaining({ credentials: 'include', cache: 'no-store' }),
    )
  })

  it('preserves server-projected UI messages returned by the shared client', async () => {
    const projected = {
      info: { id: 'msg_projected', sessionID: 'ses_1', role: 'assistant' },
      parts: [{ id: 'part_1', sessionID: 'ses_1', messageID: 'msg_projected', type: 'text', text: 'Projected reply' }],
    }
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ messages: [projected] }), { status: 200 }))

    const result = await new SubpolarClient('/api', '/ignored-directory').listMessages('ses_1')

    expect(result).toEqual([projected])
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost/api/sessions/ses_1/messages',
      expect.objectContaining({ credentials: 'include', cache: 'no-store' }),
    )
  })
})
