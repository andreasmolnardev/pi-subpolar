import { describe, expect, test } from 'bun:test'
import { SubpolarClient, unsupportedFeatures } from '../src/index.ts'

function mockClient(handler: (request: Request) => Response | Promise<Response>) {
  const calls: Request[] = []
  const client = new SubpolarClient({
    baseUrl: 'http://subpolar.test/',
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
  test('uses bearer authentication and calls existing discovery routes', async () => {
    const { client, calls } = mockClient(() => Response.json({ contract: { id: 'subpolar-api.v1', version: 'v1' } }))
    await client.capabilities()
    await client.health()
    expect(calls.map((request) => new URL(request.url).pathname)).toEqual(['/api/v1/capabilities', '/api/v1/health'])
    expect(calls[0]?.headers.get('authorization')).toBe('Bearer test-token')
  })

  test('lists agents and model catalog from owner-scoped API routes', async () => {
    const { client, calls } = mockClient((request) => new URL(request.url).pathname === '/api/agents'
      ? Response.json([{ id: 'a1', name: 'helper' }])
      : Response.json({ catalog: { providers: [{ id: 'p1', models: [{ id: 'm1' }] }] } }))
    expect(await client.listAgents()).toEqual([{ id: 'a1', name: 'helper' }])
    expect(await client.listModels()).toEqual([{ id: 'p1', models: [{ id: 'm1' }] }])
    expect(calls.map((request) => new URL(request.url).pathname)).toEqual(['/api/agents', '/api/providers/catalog'])
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

  test('starts a run through message delivery and the implemented runs endpoint', async () => {
    const { client, calls } = mockClient(async (request) => {
      if (request.url.endsWith('/messages')) return Response.json({ messageID: 'msg-1', state: 'pending' }, { status: 201 })
      return Response.json({ state: 'completed', output: 'ok' })
    })
    await client.run('session/one', 'hello', { metadata: { requestId: 'r1' } })
    expect(new URL(calls[0]!.url).pathname).toBe('/api/sessions/session%2Fone/messages')
    expect(new URL(calls[1]!.url).pathname).toBe('/api/sessions/session%2Fone/runs')
    expect(await calls[1]?.json()).toEqual({ messageID: 'msg-1' })
  })

  test('preserves structured API errors', async () => {
    const { client } = mockClient(() => Response.json({ error: { code: 'NOPE', message: 'Denied' }, requestId: 'req-1' }, { status: 403 }))
    await expect(client.listProjects()).rejects.toMatchObject({
      name: 'SubpolarApiError', status: 403, code: 'NOPE', requestId: 'req-1', message: 'Denied',
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
