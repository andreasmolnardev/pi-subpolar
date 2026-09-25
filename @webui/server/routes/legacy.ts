/* Domain route extracted from bridge-request-handler.ts. */
// @ts-nocheck
import type { BridgeRequestContext } from '../bridge-route-context.ts'

export async function handleLegacyRoute(context: BridgeRequestContext): Promise<Response | undefined> {
  const { request, url, path, correlationId, deps, gatewayCredential, internalRequest } = context
  let authenticatedUser = context.authenticatedUser
  if (request.method === 'GET' && url.pathname === '/api/agent') {
    try {
      const agents = await deps.listAgents(await deps.applicationDatabase(), authenticatedUser!.id)
      return deps.json(agents.map((agent) => ({ name: agent.name, mode: agent.mode, description: agent.description, systemPrompt: agent.system_prompt })))
    } catch (error) {
      console.warn(`Agent listing failed: ${deps.redactedDiagnostic(error)}`)
      return deps.json({ error: 'Agent store unavailable' }, 503)
    }
  }
  if (request.method === 'GET' && url.pathname === '/api/provider') {
    try {
      if (!authenticatedUser) return deps.json({ all: [], connected: [], default: {} }, 401)
      return deps.json(await deps.runtimeProviders(authenticatedUser.id))
    } catch { return deps.json({ all: [], connected: [], default: {} }) }
  }
  if (request.method === 'GET' && url.pathname === '/api/config') return deps.json({ model: undefined, default_agent: 'master', default_permission: 'ask' })
  if (request.method === 'GET' && url.pathname === '/api/command') return deps.json([])
  if (request.method === 'GET' && url.pathname === '/api/deps.sessions/status') {
    const owned = await deps.createProjectSessionRepository(await deps.applicationDatabase()).listSessions(authenticatedUser!.id, { includeArchived: true })
    return deps.json(Object.fromEntries(owned.map((session) => [session.id, { type: deps.active.get(deps.activeKey(authenticatedUser!.id, session.id))?.record.userId === authenticatedUser!.id ? 'busy' : 'idle' }])))
  }
  if (request.method === 'GET' && url.pathname === '/api/sse/stream') {
    if (gatewayCredential) {
      const denied = (() => { try { deps.assertGatewayAccess(gatewayCredential!, 'events', { ...(url.searchParams.get('sessionId') ? { sessionId: url.searchParams.get('sessionId')! } : {}) }); return null } catch (error) { return deps.gatewayErrorResponse(error) } })()
      if (denied) return denied
    }
    const eventUserId = authenticatedUser?.id ?? gatewayCredential?.ownerId
    if (!eventUserId) return deps.json({ error: { code: 'GATEWAY_OWNER_REQUIRED', message: 'An authenticated owner is required' } }, 401)
    const after = url.searchParams.get('after') ?? request.headers.get('last-event-id')
    const replay = await (await deps.runtimeStore()).replayEvents(eventUserId, after)
    let heartbeat: ReturnType<typeof setInterval> | undefined
    let client: SseClient | undefined
    let closed = false
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const close = () => {
          if (closed) return
          closed = true
          if (heartbeat) clearInterval(heartbeat)
          if (client) deps.sseClients.delete(client)
          try { controller.close() } catch { /* the consumer may already have cancelled the stream */ }
        }
        client = {
          userId: eventUserId,
          enqueue: (chunk) => {
            if (closed) return
            try { controller.enqueue(chunk) } catch { close() }
          },
          close,
        }
        if (replay.reset) {
          client.enqueue(deps.encoder.encode(`event: cursor.reset\nid: ${replay.resetCursor ?? 0}\ndata: ${JSON.stringify({ cursor: replay.resetCursor ?? 0, reason: 'retention' })}\n\n`))
        }
        for (const event of replay.events) {
          client.enqueue(deps.encoder.encode(`id: ${event.id}\ndata: ${JSON.stringify(event.payload)}\n\n`))
        }
        deps.sseClients.add(client)
        const connected = [...active.values()].filter((session) => session.record.userId === eventUserId).length
        client.enqueue(deps.encoder.encode(`event: connected\ndata: ${JSON.stringify({ clientId: 'pi-local', connected, total: connected })}\n\n`))
        heartbeat = setInterval(() => client?.enqueue(deps.encoder.encode('event: heartbeat\ndata: {}\n\n')), 30000)
      },
      cancel() {
        if (client) client.close()
      },
    })
    return new Response(stream, { headers: { 'cache-control': 'no-cache', 'content-type': 'text/event-stream', 'connection': 'keep-alive' } })
  }
  if (request.method === 'POST' && (url.pathname === '/api/sse/subscribe' || url.pathname === '/api/sse/unsubscribe' || url.pathname === '/api/sse/visibility')) return deps.json({ ok: true })

  if (path[0] !== 'api') return deps.json({ error: 'Not found' }, 404)
  return undefined
}
