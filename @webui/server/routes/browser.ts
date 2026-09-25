/* Domain route extracted from bridge-request-handler.ts. */
// @ts-nocheck
import type { BridgeRequestContext } from '../bridge-route-context.ts'

export async function handleBrowserRoute(context: BridgeRequestContext): Promise<Response | undefined> {
  const { request, url, path, correlationId, deps, gatewayCredential, internalRequest } = context
  let authenticatedUser = context.authenticatedUser
  if (path[1] === 'browser' && path[2] === 'sessions' && authenticatedUser) {
    const browser = new deps.BrowserSessionService(await deps.applicationDatabase())
    const browserContext = (input: Record<string, unknown> = {}) => ({ ownerId: authenticatedUser!.id, ...(typeof input.projectId === 'string' && input.projectId.trim() ? { projectId: input.projectId.trim() } : {}), ...(typeof input.sessionId === 'string' && input.sessionId.trim() ? { sessionId: input.sessionId.trim() } : {}), ...(typeof input.taskId === 'string' && input.taskId.trim() ? { taskId: input.taskId.trim() } : {}) })
    try {
      if (path.length === 3 && request.method === 'POST') {
        const input = deps.object(await deps.body(request))
        return deps.json({ session: await browser.create(browserContext(input), deps.object(input.limits)) }, 201)
      }
      if (path.length === 3 && request.method === 'GET') return deps.json({ sessions: await browser.list(browserContext({ projectId: url.searchParams.get('projectId') ?? undefined, sessionId: url.searchParams.get('sessionId') ?? undefined, taskId: url.searchParams.get('taskId') ?? undefined })) })
      const browserId = decodeURIComponent(path[3] ?? '')
      const context = browserContext({ projectId: url.searchParams.get('projectId') ?? undefined, sessionId: url.searchParams.get('sessionId') ?? undefined, taskId: url.searchParams.get('taskId') ?? undefined })
      if (path.length === 4 && request.method === 'GET') return deps.json({ session: await browser.get(context, browserId) })
      if (path.length === 5 && path[4] === 'close' && request.method === 'POST') return deps.json({ session: await browser.close(context, browserId) })
      if (path.length === 5 && path[4] === 'audit' && request.method === 'GET') {
        const owned = await browser.get(context, browserId)
        const audit = await (await deps.applicationDatabase()).collection('browser_audit').getFullList({ filter: `owner_id = "${deps.escapeFilter(authenticatedUser.id)}" && browser_session_id = "${deps.escapeFilter(owned.id)}"`, sort: '-created_at' })
        return deps.json({ audit })
      }
      return deps.json({ error: 'Browser session route not found' }, 404)
    } catch (error) {
      if (error instanceof deps.BrowserRuntimeError) return deps.json({ error: { code: error.code, message: error.message } }, error.code === 'BROWSER_SESSION_NOT_FOUND' ? 404 : 409)
      console.warn(`Browser session request failed: ${deps.redactedDiagnostic(error)}`)
      return deps.json({ error: { code: 'BROWSER_UNAVAILABLE', message: 'Browser session store unavailable' } }, 503)
    }
  }
  return undefined
}
