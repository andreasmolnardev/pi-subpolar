/* Domain route extracted from bridge-request-handler.ts. */
// @ts-nocheck
import type { BridgeRequestContext } from '../bridge-route-context.ts'

export async function handleLegacyRoute(context: BridgeRequestContext): Promise<Response | undefined> {
  const { request, url, path, correlationId, deps, gatewayCredential, internalRequest } = context
  let authenticatedUser = context.authenticatedUser
  if (request.method === 'GET' && url.pathname === '/api/sse/stream') {
    const eventUserId = gatewayCredential ? gatewayCredential.ownerId : authenticatedUser?.id
    if (!eventUserId) return deps.json({ error: { code: 'GATEWAY_OWNER_REQUIRED', message: 'An authenticated owner is required' } }, 401)
    let eventSessionId: string | undefined
    if (gatewayCredential) {
      try {
        const sessionId = url.searchParams.get('sessionId')?.trim()
        let scope = {}
        if (sessionId) {
          const database = await deps.applicationDatabase()
          const session = await deps.createProjectSessionRepository(database).getSessionById(sessionId)
          if (!session || session.userId !== eventUserId) return deps.json({ error: 'Session not found' }, 404)
          const agents = await deps.listAgents(database, eventUserId)
          const agent = agents.find((item) => item.id === session.profile || item.name === session.profile) ?? agents.find((item) => item.name === 'master')
          if (!agent || agent.enabled === false) throw new deps.GatewayAuthError('GATEWAY_SCOPE_DENIED', 'Session agent is unavailable')
          eventSessionId = session.id
          scope = { sessionId: session.id, projectId: session.projectId || undefined, agentName: agent.name }
        }
        // Empty context deliberately fails closed for any restricted scope.
        deps.assertGatewayAccess(gatewayCredential, 'events', scope)
      } catch (error) {
        if (error instanceof deps.GatewayAuthError) return deps.gatewayErrorResponse(error)
        return deps.json({ error: { code: 'GATEWAY_EVENTS_UNAVAILABLE', message: 'Event authorization unavailable' } }, 503)
      }
    }
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
        const send = (chunk: Uint8Array) => {
          if (closed) return
          try { controller.enqueue(chunk) } catch { close() }
        }
        client = {
          userId: eventUserId,
          enqueue: (chunk) => {
            // The runtime broadcaster already selects owner but has no session
            // filter. Its complete JSON SSE frames are checked at this boundary.
            if (eventSessionId) {
              try {
                const frames = new TextDecoder().decode(chunk).trim().split(/\r?\n\r?\n/)
                if (!frames.length || frames.some((frame) => {
                  const data = frame.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n')
                  return JSON.parse(data)?.properties?.sessionID !== eventSessionId
                })) return
              } catch { return }
            }
            send(chunk)
          },
          close,
        }
        if (replay.reset) {
          send(deps.encoder.encode(`event: cursor.reset\nid: ${replay.resetCursor ?? 0}\ndata: ${JSON.stringify({ cursor: replay.resetCursor ?? 0, reason: 'retention' })}\n\n`))
        }
        for (const event of replay.events) {
          if (event.ownerId !== eventUserId || (eventSessionId && event.sessionId !== eventSessionId)) continue
          send(deps.encoder.encode(`id: ${event.id}\ndata: ${JSON.stringify(event.payload)}\n\n`))
        }
        deps.sseClients.add(client)
        const connected = [...deps.active.values()].filter((session) => session.record.userId === eventUserId && (!eventSessionId || session.record.id === eventSessionId)).length
        send(deps.encoder.encode(`event: connected\ndata: ${JSON.stringify({ clientId: 'pi-local', connected, total: connected })}\n\n`))
        heartbeat = setInterval(() => send(deps.encoder.encode('event: heartbeat\ndata: {}\n\n')), 30000)
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
