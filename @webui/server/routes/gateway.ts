/* Domain route extracted from bridge-request-handler.ts. */
// @ts-nocheck
import type { BridgeRequestContext } from '../bridge-route-context.ts'

export async function handleGatewayRoute(context: BridgeRequestContext): Promise<Response | undefined> {
  const { request, url, path, correlationId, deps, gatewayCredential, internalRequest } = context
  let authenticatedUser = context.authenticatedUser
  if (path[1] === 'gateway' && path[2] === 'credentials') {
    if (!authenticatedUser) return deps.json({ error: { code: 'GATEWAY_OWNER_REQUIRED', message: 'An authenticated owner is required' } }, 401)
    const client = await deps.applicationDatabase()
    if (path.length === 3 && request.method === 'GET') return deps.json({ credentials: (await deps.listGatewayCredentials(client, authenticatedUser.id)).map(deps.publicGatewayCredential) })
    if (path.length === 3 && request.method === 'POST') {
      const input = await deps.body(request)
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
  }
  return undefined
}
