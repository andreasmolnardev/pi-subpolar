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
      if (path.length === 3 && request.method === 'POST') {
        const input = await deps.body(request)
        if (typeof input.kind !== 'string' || typeof input.reference_id !== 'string' || typeof input.title !== 'string') return deps.json({ error: 'kind, reference_id, and title are required' }, 400)
        if (typeof input.project_id === 'string' && !(await deps.createProjectSessionRepository(client).getProject(authenticatedUser.id, input.project_id))) return deps.json({ error: 'Project is not owned by the authenticated user' }, 403)
        return deps.json({ item: await inbox.upsert({
          owner_id: authenticatedUser.id,
          kind: input.kind as never,
          reference_id: input.reference_id,
          title: input.title,
          ...(typeof input.body === 'string' ? { body: input.body } : {}),
          ...(typeof input.project_id === 'string' ? { project_id: input.project_id } : {}),
          ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
          ...(input.deep_link !== undefined ? { deep_link: input.deep_link as Record<string, string> } : {}),
          ...(input.reopen === true ? { reopen: true } : {}),
          ...(typeof input.underlying_state === 'string' ? { underlying_state: input.underlying_state } : {}),
        }) }, 201)
      }
    } catch (error) { return deps.json({ error: error instanceof Error ? error.message : 'Inbox request failed' }, 400) }
  }
  return undefined
}
