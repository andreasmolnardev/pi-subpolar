/* Domain route extracted from bridge-request-handler.ts. */
// @ts-nocheck
import type { BridgeRequestContext } from '../bridge-route-context.ts'

export async function handleInboxRoute(context: BridgeRequestContext): Promise<Response | undefined> {
  const { request, url, path, correlationId, deps, gatewayCredential, internalRequest } = context
  let authenticatedUser = context.authenticatedUser
  if (path[1] === 'inbox' && authenticatedUser) {
    const client = await deps.applicationDatabase()
    const inbox = new deps.InboxRepository(client)
    try {
      if (path.length === 2 && request.method === 'GET') return deps.json({ items: await inbox.list(authenticatedUser.id, url.searchParams.get('projectId') ?? undefined) })
      if (path.length === 4 && path[3] === 'resolve' && request.method === 'POST') { const item = await inbox.resolve(authenticatedUser.id, decodeURIComponent(path[2])); return item ? deps.json({ item }) : deps.json({ error: 'Inbox item not found' }, 404) }
      // Only domain services may project authoritative approvals and run outcomes.
      if ((path.length === 2 || path.length === 3) && request.method === 'POST') return deps.json({ error: 'Inbox items are created by domain services', code: 'INBOX_PROJECTION_FORBIDDEN' }, 403)
    } catch (error) { return deps.json({ error: error instanceof Error ? error.message : 'Inbox request failed' }, 400) }
  }
  return undefined
}
