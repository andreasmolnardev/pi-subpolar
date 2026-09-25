import { Hono } from 'hono'
import { bridgeRuntime } from './bridge-runtime.ts'

type SocketData = {
  sessionId: string
  userId: string
  record: any
  project: any
  unsubscribe?: () => void
  historyReady?: boolean
  buffered?: any[]
}

const {
  port, handle, handleProxy, startAutomationScheduler, requestId, isAllowedOrigin, errorEnvelope,
  assertSafeBrowserMutation, REQUEST_LIMITS, authenticateRequest, rateLimitKey, requestRateLimiter,
  json, redactedDiagnostic, RequestSecurityError, applicationDatabase, ownedSessionRecord,
  ownedSessionProject, resolveToolSessionContext, rpcSession, handleSocketMessage,
} = bridgeRuntime

const app = new Hono()
app.all('*', async (context) => {
  const request = context.req.raw
  const origin = request.headers.get('origin')
  const id = requestId(request)
  const pathname = new URL(request.url).pathname
  if (origin && !isAllowedOrigin(request, { allowLoopbackDev: true })) {
    const response = pathname.startsWith('/api/v1/')
      ? context.json(errorEnvelope('ORIGIN_NOT_ALLOWED', 'Origin not allowed', undefined, id), 403)
      : context.json({ error: 'Origin not allowed', requestId: id }, 403)
    response.headers.set('x-request-id', id)
    return response
  }
  try {
    assertSafeBrowserMutation(request, { allowLoopbackDev: true })
    const mutation = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)
    const bucketName = pathname.includes('/auth/') ? 'auth' : mutation ? 'mutation' : 'read'
    const kind = bucketName === 'auth' ? REQUEST_LIMITS.auth : mutation ? REQUEST_LIMITS.mutation : REQUEST_LIMITS.read
    // Cookie headers are mutable and are not a client identity. Use the
    // authenticated PocketBase user when available; unauthenticated auth
    // attempts intentionally fall back to a route bucket.
    const rateUser = await authenticateRequest(request).catch(() => null)
    const rateKey = rateLimitKey(bucketName, pathname, rateUser?.id)
    const limited = requestRateLimiter.consume(rateKey, kind.limit, kind.windowMs)
    if (!limited.allowed) {
      const response = pathname.startsWith('/api/v1/')
        ? context.json(errorEnvelope('RATE_LIMITED', 'Too many requests', undefined, id), 429)
        : context.json({ error: 'Too many requests', requestId: id }, 429)
      response.headers.set('retry-after', String(Math.ceil(limited.retryAfterMs / 1000)))
      response.headers.set('x-request-id', id)
      return response
    }
    const response = pathname.startsWith('/proxy/')
      ? await handleProxy(request)
      : await handle(request, id)
    response.headers.set('x-request-id', id)
    response.headers.set('access-control-allow-methods', 'GET,POST,PATCH,DELETE,OPTIONS')
    response.headers.set('access-control-allow-headers', 'content-type, authorization, x-request-id')
    if (request.url.includes('/proxy/')) response.headers.set('access-control-allow-origin', '*')
    else if (origin) response.headers.set('access-control-allow-origin', origin)
    return response
  } catch (error: any) {
    const status = error instanceof RequestSecurityError ? error.status : 400
    if (!(error instanceof RequestSecurityError)) console.warn(`Unhandled bridge request failure: ${redactedDiagnostic(error)}`)
    const response = pathname.startsWith('/api/v1/')
      ? json(errorEnvelope(error instanceof RequestSecurityError ? error.code : 'REQUEST_FAILED', error instanceof RequestSecurityError ? error.message : 'Request failed', undefined, id), status)
      : json({ error: error instanceof RequestSecurityError ? error.message : 'Request failed', requestId: id }, status)
    response.headers.set('x-request-id', id)
    return response
  }
})

const _server = Bun.serve<SocketData>({
  port,
  hostname: '127.0.0.1',
  // Agent turns and transcript WebSockets can legitimately remain quiet for
  // longer than Bun's 10-second default while a model or tool is working.
  idleTimeout: 120,
  async fetch(request, server) {
    const url = new URL(request.url)
    const match = url.pathname.match(/^\/api\/sessions\/([^/]+)\/events$/)
    if (match) {
      const id = requestId(request)
      if (!isAllowedOrigin(request, { allowLoopbackDev: true })) {
        const response = json({ error: 'Origin not allowed', requestId: id }, 403)
        response.headers.set('x-request-id', id)
        return response
      }
      const user = await authenticateRequest(request)
      if (!user) return json({ message: 'Unauthorized' }, 401)
      const sessionId = decodeURIComponent(match[1] ?? '')
      const limited = requestRateLimiter.consume(rateLimitKey('websocket', url.pathname, user.id), REQUEST_LIMITS.read.limit, REQUEST_LIMITS.read.windowMs)
      if (!limited.allowed) {
        const response = json({ error: 'Too many requests', requestId: id }, 429)
        response.headers.set('retry-after', String(Math.ceil(limited.retryAfterMs / 1000)))
        response.headers.set('x-request-id', id)
        return response
      }
      const client = await applicationDatabase()
      const record = await ownedSessionRecord(client, user.id, sessionId)
      const project = record ? await ownedSessionProject(client, user.id, record) : null
      if (!record || !project) return json({ error: 'Session not found' }, 404)
      try {
        await resolveToolSessionContext(client, user.id, sessionId)
      } catch {
        return json({ error: 'Session agent is unavailable' }, 400)
      }
      if (server.upgrade(request, { data: { sessionId, userId: user.id, record, project } })) return undefined
      return json({ error: 'WebSocket upgrade failed' }, 400)
    }
    return app.fetch(request)
  },
  websocket: {
    open(socket) {
      try {
        const session = rpcSession(
          socket.data.sessionId,
          socket.data.userId,
          socket.data.record,
          socket.data.project,
          socket.data.record.profile ?? 'master',
          socket.data.record.permissionOverride ?? 'ask',
        )
        socket.data.buffered = []
        // Subscribe before reading entries. Events generated during the read are replayed
        // after the authoritative snapshot, so a reconnect cannot lose a turn.
        socket.data.unsubscribe = session.onMessage((message: any) => {
          if (!socket.data.historyReady) {
            if ((socket.data.buffered ?? []).length < 200) socket.data.buffered!.push(message)
            return
          }
          if (message.type !== 'response') socket.send(JSON.stringify({ type: 'transcript.event', event: message }))
        })
      } catch {
        socket.close(1011, 'Unknown session')
      }
    },
    close(socket) {
      socket.data.unsubscribe?.()
    },
    message(socket, raw) {
      void handleSocketMessage(socket, raw, rpcSession(
        socket.data.sessionId,
        socket.data.userId,
        socket.data.record,
        socket.data.project,
        socket.data.record.profile ?? 'master',
        socket.data.record.permissionOverride ?? 'ask',
      ))
    },
  },
})

startAutomationScheduler()

void _server
