/* Domain route extracted from bridge-request-handler.ts. */
// @ts-nocheck
import type { BridgeRequestContext } from '../bridge-route-context.ts'

export async function handleGatewayRoute(context: BridgeRequestContext): Promise<Response | undefined> {
  const { request, url, path, correlationId, deps, gatewayCredential, internalRequest } = context
  let authenticatedUser = context.authenticatedUser
  if (path[1] === 'gateway' && path[2] === 'credentials') {
    if (!authenticatedUser) return deps.json({ error: { code: 'GATEWAY_OWNER_REQUIRED', message: 'An authenticated owner is required' } }, 401)
    try {
    const client = await deps.applicationDatabase()
    if (path.length === 3 && request.method === 'GET') return deps.json({ credentials: (await deps.listGatewayCredentials(client, authenticatedUser.id)).map(deps.publicGatewayCredential) })
    if (path.length === 3 && request.method === 'POST') {
      const input = await deps.body(request)
      if (!Array.isArray(input.permissions) || input.permissions.some((value) => typeof value !== 'string')) return deps.json({ error: 'permissions must be an array of strings' }, 400)
      if (input.scope !== undefined && (!input.scope || typeof input.scope !== 'object' || Array.isArray(input.scope))) return deps.json({ error: 'scope must be an object' }, 400)
      for (const [key, value] of Object.entries(input.scope ?? {})) {
        if (!['projectIds', 'agentNames', 'sessionIds'].includes(key) || !Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) return deps.json({ error: 'scope must contain non-empty string arrays for projectIds, agentNames, or sessionIds' }, 400)
      }
      if (input.expiresAt !== undefined && (typeof input.expiresAt !== 'number' || !Number.isFinite(input.expiresAt))) return deps.json({ error: 'expiresAt must be a finite timestamp' }, 400)
      const permissions = Array.isArray(input.permissions) ? input.permissions.filter((value): value is GatewayPermission => typeof value === 'string') : []
      const scope = input.scope && typeof input.scope === 'object' && !Array.isArray(input.scope) ? input.scope as Record<string, unknown> : undefined
      const created = await deps.createGatewayCredential(client, {
        ownerId: authenticatedUser.id,
        principal: typeof input.principal === 'string' ? input.principal : '',
        permissions,
        scope: { projectIds: Array.isArray(scope?.projectIds) ? scope.projectIds.filter((value): value is string => typeof value === 'string') : [], agentNames: Array.isArray(scope?.agentNames) ? scope.agentNames.filter((value): value is string => typeof value === 'string') : [], sessionIds: Array.isArray(scope?.sessionIds) ? scope.sessionIds.filter((value): value is string => typeof value === 'string') : [] },
        ...(typeof input.expiresAt === 'number' ? { expiresAt: input.expiresAt } : {}),
      })
      return deps.json({ credential: deps.publicGatewayCredential(created.credential), secret: created.secret }, 201)
    }
    if (path.length === 5 && path[4] === 'rotate' && request.method === 'POST') {
      const rotated = await deps.rotateGatewayCredential(client, authenticatedUser.id, decodeURIComponent(path[3] ?? ''))
      return rotated ? deps.json({ credential: deps.publicGatewayCredential(rotated.credential), secret: rotated.secret }, 201) : deps.json({ error: { code: 'GATEWAY_CREDENTIAL_NOT_FOUND', message: 'Gateway credential not found' } }, 404)
    }
    if (path.length === 4 && request.method === 'DELETE') return deps.json({ ok: await deps.revokeGatewayCredential(client, authenticatedUser.id, decodeURIComponent(path[3] ?? '')) })
    } catch (error) {
      if (error instanceof deps.GatewayAuthError) return deps.gatewayErrorResponse(error)
      console.warn(`Gateway credential request failed: ${deps.redactedDiagnostic(error)}`)
      return deps.json({ error: { code: 'GATEWAY_UNAVAILABLE', message: 'Gateway credential store unavailable' } }, 503)
    }
  }
  return undefined
}
