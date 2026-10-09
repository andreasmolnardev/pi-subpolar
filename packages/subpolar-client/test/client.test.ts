import { describe, expect, test } from 'bun:test'
import { SubpolarClient, unsupportedFeatures } from '../src/index.ts'

function mockClient(handler: (request: Request) => Response | Promise<Response>) {
  const calls: Request[] = []
  const client = new SubpolarClient({
    baseUrl: 'https://subpolar.test/',
    token: 'test-token',
    fetch: async (input, init) => {
      const request = new Request(input, init)
      calls.push(request)
      return handler(request)
    },
  })
  return { client, calls }
}

describe('SubpolarClient', () => {
  test('refuses bearer credentials over non-loopback plaintext HTTP', () => {
    expect(() => new SubpolarClient({ baseUrl: 'http://subpolar.example', token: 'user-token' }))
      .toThrow('Bearer tokens require HTTPS except for loopback development servers')
    expect(() => new SubpolarClient({ baseUrl: 'http://localhost:4173', token: 'user-token' })).not.toThrow()
  })

  test('uses bearer authentication and calls existing discovery routes', async () => {
    const { client, calls } = mockClient(() => Response.json({ contract: { id: 'subpolar-api.v1', version: 'v1' } }))
    await client.capabilities()
    await client.health()
    expect(calls.map((request) => new URL(request.url).pathname)).toEqual(['/api/v1/capabilities', '/api/v1/health'])
    expect(calls[0]?.headers.get('authorization')).toBe('Bearer test-token')
  })

  test('lists agents with optional directory query and model catalog from owner-scoped API routes', async () => {
    const { client, calls } = mockClient((request) => new URL(request.url).pathname === '/api/agents'
      ? Response.json([{ id: 'a1', name: 'helper' }])
      : Response.json({ catalog: { providers: [{ id: 'p1', models: [{ id: 'm1' }] }], models: [{ id: 'm1', instanceId: 'p1', providerId: 'p1', modelId: 'm1', name: 'Model 1' }] } }))
    expect(await client.listAgents({ directory: '/workspace/one & two' })).toEqual([{ id: 'a1', name: 'helper' }])
    expect(await client.listModels()).toEqual([{ id: 'm1', instanceId: 'p1', providerId: 'p1', modelId: 'm1', name: 'Model 1' }])
    expect(calls.map((request) => new URL(request.url).pathname)).toEqual(['/api/agents', '/api/providers/catalog'])
    expect(new URL(calls[0]!.url).searchParams.get('directory')).toBe('/workspace/one & two')
    expect(new URL(calls[1]!.url).searchParams.has('directory')).toBe(false)
  })

  test('passes the provider catalog directory while preserving envelope handling and default refresh behavior', async () => {
    const catalog = { providers: [], accounts: [], models: [] }
    const { client, calls } = mockClient(() => Response.json({ catalog }))

    await expect(client.getProviderCatalog({ directory: '/workspace/one & two' })).resolves.toEqual(catalog)

    const url = new URL(calls[0]!.url)
    expect(url.pathname).toBe('/api/providers/catalog')
    expect(url.searchParams.get('directory')).toBe('/workspace/one & two')
    expect(url.searchParams.has('refresh')).toBe(false)

    const bareCatalogClient = mockClient(() => Response.json(catalog)).client
    await expect(bareCatalogClient.getProviderCatalog()).resolves.toEqual(catalog)
  })

  test('uses current provider, model-state, settings, tool, and policy route shapes', async () => {
    const { client, calls } = mockClient(async (request) => {
      const path = new URL(request.url).pathname
      if (path === '/api/providers/catalog') return Response.json({ catalog: { providers: [], accounts: [], models: [] } })
      if (path === '/api/providers/model-state') return Response.json({ recent: [], favorite: [], variant: {} })
      if (path === '/api/settings') return Response.json({ preferences: { theme: 'dark' }, updatedAt: 1 })
      if (path === '/api/settings/subpolar-tools') return Response.json({ tools: [] })
      return Response.json({ policies: [] })
    })
    await client.getProviderCatalog()
    await client.getModelState()
    await client.toggleFavoriteModel({ providerID: 'p', modelID: 'm' })
    await client.getSettings()
    await client.updateSettings({ theme: 'light' })
    await client.listTools()
    await client.listAgentToolPolicies('agent/one')
    await client.replaceAgentToolPolicies('agent/one', [{ toolId: 'builtin/read', effect: 'allow' }])
    expect(calls.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual([
      'GET /api/providers/catalog', 'GET /api/providers/model-state', 'POST /api/providers/model-state',
      'GET /api/settings', 'PATCH /api/settings', 'GET /api/settings/subpolar-tools',
      'GET /api/settings/agents/agent%2Fone/tool-policies', 'PUT /api/settings/agents/agent%2Fone/tool-policies',
    ])
    expect(await calls[2]?.json()).toEqual({ favorite: { providerID: 'p', modelID: 'm' } })
    expect(await calls[4]?.json()).toEqual({ preferences: { theme: 'light' } })
    expect(await calls[7]?.json()).toEqual({ policies: [{ toolId: 'builtin/read', effect: 'allow' }] })
    expect(calls.every((request) => request.headers.get('authorization') === 'Bearer test-token')).toBe(true)
  })

  test('looks up pending approvals through the supported list route and decides using session scope', async () => {
    const { client, calls } = mockClient((request) => request.method === 'GET'
      ? Response.json([{ id: 'approval-1', sessionId: 'session-1', toolId: 'builtin/write' }])
      : Response.json({ ok: true }))
    expect(await client.inspectApproval('approval-1', 'session 1')).toMatchObject({ id: 'approval-1' })
    await client.respondToApproval('session 1', 'approval-1', 'once')
    expect(new URL(calls[0]!.url).pathname).toBe('/api/permission')
    expect(new URL(calls[0]!.url).searchParams.get('sessionId')).toBe('session 1')
    expect(new URL(calls[1]!.url).pathname).toBe('/api/session/session%201/permissions/approval-1')
    expect(await calls[1]?.json()).toEqual({ response: 'once' })
  })

  test('updates and deletes sessions with optional directory routing', async () => {
    const { client, calls } = mockClient((request) => request.method === 'DELETE'
      ? Response.json({ ok: true })
      : Response.json({ session: { id: 'session/one', title: 'new', updatedAt: 2 } }))
    await client.updateSession('session/one', { title: 'new', archived: true }, { directory: '/workspace/one & two' })
    await client.deleteSession('session/one', { directory: '/workspace/one & two' })

    expect(calls.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual([
      'PATCH /api/sessions/session%2Fone', 'DELETE /api/sessions/session%2Fone',
    ])
    expect(calls.map((request) => new URL(request.url).searchParams.get('directory'))).toEqual([
      '/workspace/one & two', '/workspace/one & two',
    ])
    expect(await calls[0]?.json()).toEqual({ title: 'new', archived: true })
  })

  test('reads messages through owner-scoped session routes', async () => {
    const { client, calls } = mockClient(() => Response.json({ messages: [{ id: 'm1', role: 'user', content: 'hello' }] }))
    expect(await client.messages('session/one')).toEqual([{ id: 'm1', role: 'user', content: 'hello' }])
    expect(calls.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual([
      'GET /api/sessions/session%2Fone/messages',
    ])
  })

  test('reads projected UI message entries through the authenticated owner-scoped route', async () => {
    const projected = {
      info: { id: 'm1', sessionID: 's/1', role: 'assistant' },
      parts: [{ id: 'p1', sessionID: 's/1', messageID: 'm1', type: 'text', text: 'hello' }],
    }
    const { client, calls } = mockClient(() => Response.json({ messages: [projected] }))

    await expect(client.messages('s/1')).resolves.toEqual([projected])

    expect(new URL(calls[0]!.url).pathname).toBe('/api/sessions/s%2F1/messages')
    expect(new URL(calls[0]!.url).search).toBe('')
    expect(calls[0]!.headers.get('authorization')).toBe('Bearer test-token')
  })

  test('inspects an owner-scoped tool call through the session route', async () => {
    const { client, calls } = mockClient(() => Response.json({ callID: 'call/1', tool: 'web.search', error: null, output: 'results' }))
    expect(await client.inspectToolCall('session/one', 'call/1')).toMatchObject({ callID: 'call/1', tool: 'web.search', output: 'results' })
    expect(new URL(calls[0]!.url).pathname).toBe('/api/sessions/session%2Fone/tool-calls/call%2F1')
  })

  test('creates projects and sessions using server request shapes', async () => {
    const { client, calls } = mockClient(async (request) => {
      if (new URL(request.url).pathname === '/api/projects') return Response.json({ id: 1, name: 'demo' }, { status: 201 })
      return Response.json({ session: { id: 's-1', title: 'demo', updatedAt: 1 } }, { status: 201 })
    })
    const project = await client.createProject({ name: 'demo', directory: '/tmp/demo' })
    const session = await client.createSession({ project: 1, title: 'demo' })
    expect(project.name).toBe('demo')
    expect(session.id).toBe('s-1')
    expect(await calls[0]?.json()).toEqual({ name: 'demo', directory: '/tmp/demo' })
    expect(await calls[1]?.json()).toEqual({ project: 1, title: 'demo' })
  })

  test('lists, reads, updates, and deletes projects using server route shapes', async () => {
    const project = { id: 2, name: 'demo', directory: '/workspace/demo' }
    const { client, calls } = mockClient((request) => {
      const path = new URL(request.url).pathname
      if (request.method === 'GET' && path === '/api/projects') return Response.json({ projects: [project] })
      if (request.method === 'GET') return Response.json({ project })
      if (request.method === 'DELETE') return Response.json({ ok: true })
      return Response.json(project)
    })

    expect(await client.listProjects()).toEqual([project])
    expect(await client.getProject(2)).toEqual(project)
    expect(await client.updateProject(2, { name: 'renamed', directory: '/workspace/renamed', agentNames: ['helper'] })).toEqual(project)
    expect(await client.deleteProject(2)).toEqual({ ok: true })
    expect(calls.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual([
      'GET /api/projects', 'GET /api/projects/2', 'PATCH /api/projects/2', 'DELETE /api/projects/2',
    ])
    expect(await calls[2]?.json()).toEqual({ name: 'renamed', directory: '/workspace/renamed', agentNames: ['helper'] })
  })

  test('inspects a run through the user-scoped route', async () => {
    const { client, calls } = mockClient(() => Response.json({ run: { runId: 'r1', state: 'completed' } }))
    expect(await client.inspectRun('run/one')).toEqual({ runId: 'r1', state: 'completed' })
    expect(new URL(calls[0]!.url).pathname).toBe('/api/runs/run%2Fone')
  })

  test('reads owner-scoped repository status with the typed response contract', async () => {
    const payload = {
      repository: { root: '/workspace/project', gitDir: '/workspace/project/.git', bare: false, head: 'abc123' },
      status: { branch: 'main', ahead: 1, behind: 0, entries: [{ path: 'file.ts', index: ' ', worktree: 'M', untracked: false, renamed: false }], omitted: [], truncated: false },
      requestId: 'req-1',
    }
    const { client, calls } = mockClient(() => Response.json(payload))
    expect(await client.repositoryStatus('project/one')).toEqual(payload)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.method).toBe('GET')
    expect(new URL(calls[0]!.url).pathname).toBe('/api/projects/project%2Fone/repository/status')
  })

  test('starts a run through message delivery and the implemented runs endpoint', async () => {
    const { client, calls } = mockClient(async (request) => {
      if (request.url.endsWith('/messages')) return Response.json({ messageID: 'msg-1', state: 'pending' }, { status: 201 })
      return Response.json({ state: 'completed', output: 'ok' })
    })
    await client.run('session/one', 'hello', { metadata: { requestId: 'r1' } })
    expect(new URL(calls[0]!.url).pathname).toBe('/api/sessions/session%2Fone/messages')
    expect(new URL(calls[1]!.url).pathname).toBe('/api/sessions/session%2Fone/runs')
    expect(await calls[0]?.json()).toEqual({ content: 'hello', metadata: { requestId: 'r1' } })
    expect(await calls[1]?.json()).toEqual({ messageID: 'msg-1' })
  })

  test('preserves structured API errors', async () => {
    const { client } = mockClient(() => Response.json({ error: { code: 'NOPE', message: 'Denied' }, requestId: 'req-1' }, { status: 403 }))
    await expect(client.listProjects()).rejects.toMatchObject({
      name: 'SubpolarApiError', status: 403, code: 'NOPE', requestId: 'req-1', message: 'Denied',
    })
  })

  test('preserves top-level structured legacy route error codes and details', async () => {
    const { client } = mockClient(() => Response.json({ error: 'Model is unavailable', code: 'MODEL_UNAVAILABLE', details: { provider: 'p1' }, requestId: 'req-2' }, { status: 409 }))
    await expect(client.getModelState()).rejects.toMatchObject({
      name: 'SubpolarApiError', status: 409, code: 'MODEL_UNAVAILABLE', details: { provider: 'p1' }, requestId: 'req-2',
    })
  })

  test('parses SSE id, event type, and JSON data', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('id: 42\nevent: connected\ndata: {"connected":1}\n\n'))
        controller.close()
      },
    })
    const { client, calls } = mockClient(() => new Response(stream, { headers: { 'content-type': 'text/event-stream' } }))
    const events = []
    for await (const event of client.events({ after: 3, sessionId: 's 1' })) events.push(event)
    expect(events).toEqual([{ id: '42', event: 'connected', data: { connected: 1 }, rawData: '{"connected":1}' }])
    expect(new URL(calls[0]!.url).searchParams.get('after')).toBe('3')
    expect(new URL(calls[0]!.url).searchParams.get('sessionId')).toBe('s 1')
  })

  test('documents routes the server does not support', () => {
    expect(unsupportedFeatures.remoteRepositoryRefresh).toContain('UNSUPPORTED')
    expect(unsupportedFeatures.projectSessionBulkDelete).toContain('No bulk-delete route')
  })
})
