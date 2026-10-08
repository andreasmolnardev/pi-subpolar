/* Domain route extracted from bridge-request-handler.ts. */
// @ts-nocheck
import type { BridgeRequestContext } from '../bridge-route-context.ts'

export async function handleRuntimeRoute(context: BridgeRequestContext): Promise<Response | undefined> {
  const { request, url, path, correlationId, deps, gatewayCredential, internalRequest } = context
  let authenticatedUser = context.authenticatedUser
  if (request.method === 'GET' && url.pathname === '/api/usage/daily') return deps.json(await deps.dailyUsage(authenticatedUser!.id, await deps.applicationDatabase()))
  if (url.pathname === '/api/proxy/credentials' && request.method === 'GET') {
    if (!authenticatedUser) return deps.json({ error: 'Authentication required' }, 401)
    const store = new deps.PocketBaseProxyCredentialStore(await deps.applicationDatabase())
    return deps.json({ credentials: (await store.list(authenticatedUser.id)).map(deps.proxyCredentialResponse) })
  }
  if (url.pathname === '/api/proxy/credentials' && request.method === 'POST') {
    if (!authenticatedUser) return deps.json({ error: 'Authentication required' }, 401)
    const secret = `subpolar_${deps.randomBytes(32).toString('base64url')}`
    const credential: ProxyCredential = { id: crypto.randomUUID(), prefix: secret.slice(0, 18), hash: deps.hashProxySecret(secret), createdAt: Date.now() }
    await new deps.PocketBaseProxyCredentialStore(await deps.applicationDatabase()).create(authenticatedUser.id, credential)
    return deps.json({ credential: deps.proxyCredentialResponse(credential), secret }, 201)
  }
  if (path[1] === 'proxy' && path[2] === 'credentials' && path.length === 4 && request.method === 'DELETE') {
    if (!authenticatedUser) return deps.json({ error: 'Authentication required' }, 401)
    const id = decodeURIComponent(path[3] ?? '')
    await new deps.PocketBaseProxyCredentialStore(await deps.applicationDatabase()).revoke(authenticatedUser.id, id)
    return deps.json({ ok: true })
  }
  return undefined
}
