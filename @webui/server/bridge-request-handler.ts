/* HTTP request coordinator for the bridge. Domain routes live in ./routes. */
import { handleAuthRoute } from './routes/auth.ts'
import { handleGatewayRoute } from './routes/gateway.ts'
import { handleAutomationsRoute } from './routes/automations.ts'
import { handleInboxRoute } from './routes/inbox.ts'
import { handleNotificationsRoute } from './routes/notifications.ts'
import { handleAgentsRoute } from './routes/agents.ts'
import { handleTasksRoute } from './routes/tasks.ts'
import { handleBrowserRoute } from './routes/browser.ts'
import { handleProvidersRoute } from './routes/providers.ts'
import { handleRuntimeRoute } from './routes/runtime.ts'
import { handleProjectsRoute } from './routes/projects.ts'
import { handleLegacyRoute } from './routes/legacy.ts'
import { handleToolsRoute } from './routes/tools.ts'
import { handleSettingsRoute } from './routes/settings.ts'
import { handleSessionsRoute } from './routes/sessions.ts'
import { handleExtensionsRoute } from './routes/extensions.ts'
import type { BridgeRequestContext } from './bridge-route-context.ts'

export type BridgeRequestDependencies = Record<string, any>

type RouteHandler = (context: BridgeRequestContext) => Promise<Response | undefined>

const routeHandlers: RouteHandler[] = [
  handleAuthRoute,
  handleGatewayRoute,
  handleAutomationsRoute,
  handleInboxRoute,
  handleNotificationsRoute,
  handleAgentsRoute,
  handleTasksRoute,
  handleBrowserRoute,
  handleProvidersRoute,
  handleRuntimeRoute,
  handleProjectsRoute,
  handleLegacyRoute,
  handleToolsRoute,
  handleSettingsRoute,
  handleSessionsRoute,
  handleExtensionsRoute,
]

// This is a principal boundary, not an execution permission policy. Each
// supported handler still enforces its operation permission and resource scope.
function supportsGatewayPrincipal(request: Request, url: URL): boolean {
  const pathname = url.pathname
  if (request.method === 'POST') {
    return /^\/api\/subpolar-cli\/tools\/(list|search|describe|register|call|continue)$/.test(pathname)
      || /^\/api\/session\/[^/]+\/permissions\/[^/]+$/.test(pathname)
      || pathname === '/api/stt/transcribe' || pathname === '/api/tts/synthesize'
  }
  if (request.method === 'GET') {
    return pathname === '/api/permission' || pathname === '/api/sse/stream'
      || /^\/api\/(stt|tts)\/(status|models)$/.test(pathname)
      || pathname === '/api/tts/voices'
  }
  return false
}

export function createBridgeRequestHandler(deps: BridgeRequestDependencies) {
  return async function handle(request: Request, correlationId = deps.requestId(request)): Promise<Response> {
    const url = new URL(request.url)
    const path = url.pathname.split('/').filter(Boolean)
    if (request.method === 'OPTIONS') return new Response(null, { status: 204 })


    if (request.method === 'GET' && url.pathname === '/api/v1/capabilities') {
      return deps.json(deps.createCapabilitiesPayload(correlationId))
    }
    if (request.method === 'GET' && url.pathname === '/api/v1/health') {
      return deps.json(deps.createHealthPayload(await deps.diagnosticsComponents(), new Date().toISOString(), correlationId))
    }

    const publicApi = path[0] === 'api' && (
      path[1] === 'auth'
      || path[1] === 'auth-info'
      || (path[1] === 'v1' && (path[2] === 'capabilities' || path[2] === 'health'))
    )
    const internalRequest = Boolean(deps.internalToken) && request.headers.get('authorization') === `Bearer ${deps.internalToken}`
    // An installation token is not a tenant principal. Never infer an owner from
    // an arbitrary session id on browser/runtime/provider routes.
    if (internalRequest && !supportsGatewayPrincipal(request, url)) {
      return deps.json({ error: { code: 'INTERNAL_ROUTE_DENIED', message: 'This route requires an authenticated tenant principal' } }, 403)
    }
    let gatewayCredential: any = null
    const authorization = request.headers.get('authorization') ?? ''
    if (!internalRequest && authorization.startsWith('Bearer subpolar_gw_')) {
      try {
        gatewayCredential = await deps.authenticateGatewayCredential(await deps.applicationDatabase(), authorization.slice('Bearer '.length))
                if (!gatewayCredential) throw new deps.GatewayAuthError('GATEWAY_TOKEN_INVALID', 'Invalid gateway credential')
      } catch (error: any) {
        if (error instanceof deps.GatewayAuthError) {
          const status = error.code === 'GATEWAY_TOKEN_REQUIRED' || error.code === 'GATEWAY_TOKEN_INVALID' ? 401 : 403
          return deps.json({ error: { code: error.code, message: error.message } }, status)
        }
        return deps.json({ error: { code: 'GATEWAY_AUTH_UNAVAILABLE', message: 'Gateway authentication unavailable' } }, 503)
      }
    }

    if (gatewayCredential && !internalRequest && !supportsGatewayPrincipal(request, url)) {
      return deps.json({ error: { code: 'GATEWAY_ROUTE_DENIED', message: 'This route does not support gateway credentials' } }, 403)
    }

    let authenticatedUser: any = null
    if (path[0] === 'api' && !publicApi && !internalRequest && !gatewayCredential) {
      authenticatedUser = await deps.authenticateRequest(request)
      if (!authenticatedUser) return deps.json({ message: 'Unauthorized' }, 401)
    }

    if (path[0] === 'api' && (path[1] === 'stt' || path[1] === 'tts')) {
      let voiceContext
      try {
        voiceContext = await deps.voiceAuthorization(request, authenticatedUser, gatewayCredential, internalRequest)
      } catch (error: any) {
        if (error instanceof deps.GatewayAuthError) return deps.json({ error: { code: error.code, message: 'Voice access is not permitted' } }, 403)
        return deps.json({ error: 'Voice access is not permitted', code: 'FORBIDDEN' }, 403)
      }
      const voiceResponse = await deps.handleVoiceRoute(request, deps.voiceBackends, voiceContext)
      if (voiceResponse) return voiceResponse
    }

    const context: BridgeRequestContext = {
      request,
      url,
      path,
      correlationId,
      deps,
      authenticatedUser,
      gatewayCredential,
      internalRequest,
    }
    for (const routeHandler of routeHandlers) {
      const response = await routeHandler(context)
      if (response) return response
    }
    return deps.json({ error: 'Not found' }, 404)
  }
}
