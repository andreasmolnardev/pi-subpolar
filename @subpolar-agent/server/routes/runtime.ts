/* Domain route extracted from bridge-request-handler.ts. */
// @ts-nocheck
import type { BridgeRequestContext } from '../bridge-route-context.ts'
import { redactSensitiveText } from '../core/security-redaction.ts'

export async function handleRuntimeRoute(context: BridgeRequestContext): Promise<Response | undefined> {
  const { request, url, path, correlationId, deps, gatewayCredential, internalRequest } = context
  let authenticatedUser = context.authenticatedUser
  if (path[1] === 'runs' && path.length === 3) {
    if (request.method !== 'GET') return deps.json({ error: 'Method not allowed' }, 405)
    if (context.internalRequest || context.gatewayCredential) return deps.json({ error: 'Authentication required' }, 401)
    if (!authenticatedUser?.id) return deps.json({ error: 'Authentication required' }, 401)
    let runId: string
    try { runId = decodeURIComponent(path[2] ?? '') } catch { return deps.json({ error: 'Run not found' }, 404) }
    const store = new deps.PocketBaseRuntimeStore(await deps.applicationDatabase())
    const run = await store.getRuntimeRun(authenticatedUser.id, runId)
    if (!run) return deps.json({ error: 'Run not found' }, 404)
    return deps.json({ run: { ...run, ...(run.error === undefined ? {} : { error: redactSensitiveText(run.error) }) } })
  }
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
