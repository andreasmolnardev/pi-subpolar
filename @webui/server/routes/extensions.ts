/* Domain route extracted from bridge-request-handler.ts. */
// @ts-nocheck
import type { BridgeRequestContext } from '../bridge-route-context.ts'

export async function handleExtensionsRoute(context: BridgeRequestContext): Promise<Response | undefined> {
  const { request, url, path, correlationId, deps, gatewayCredential, internalRequest } = context
  let authenticatedUser = context.authenticatedUser
  if (path[1] === 'extensions' && path[2] === 'projects') {
    const client = await deps.applicationDatabase()
    if (request.method === 'GET') return deps.json({ projects: await deps.ownedProjectResponses(authenticatedUser!.id, client) })
    if (request.method === 'POST') {
      const input = await deps.body(request)
      if (typeof input.sessionId !== 'string' || typeof input.project !== 'string') return deps.json({ error: 'sessionId and project are required' }, 400)
      const session = await deps.ownedSessionRecord(client, authenticatedUser!.id, input.sessionId)
      if (!session) return deps.json({ error: 'Session not found' }, 404)
      if (input.project !== 'General Chat' && !(await deps.createProjectSessionRepository(client).findProjectByName(authenticatedUser!.id, input.project))) return deps.json({ error: 'Project not found' }, 404)
      return deps.json(await deps.sendRpc(input.sessionId, { type: 'prompt', message: `/project ${input.project}` }, session))
    }
  }

  if (path[1] === 'extensions' && (path[2] === 'profiles' || path[2] === 'agent-profiles') && request.method === 'GET') {
    try {
      const agents = await deps.listAgents(await deps.applicationDatabase(), authenticatedUser!.id)
      return deps.json({ profiles: Object.fromEntries(agents.map((agent) => [agent.name, { systemPrompt: agent.system_prompt, tools: [] }])) })
    } catch (error) {
      console.warn(`Agent profile request failed: ${deps.redactedDiagnostic(error)}`)
      return deps.json({ error: 'Agent store unavailable' }, 503)
    }
  }

  if (path[1] === 'extensions' && (path[2] === 'profiles' || path[2] === 'agent-profiles') && path[3] === 'activate' && request.method === 'POST') {
    const input = await deps.body(request)
    if (typeof input.sessionId !== 'string' || typeof input.profile !== 'string' || !input.profile.trim()) return deps.json({ error: 'sessionId and profile are required' }, 400)
    const client = await deps.applicationDatabase()
    const session = await deps.ownedSessionRecord(client, authenticatedUser!.id, input.sessionId)
    if (!session) return deps.json({ error: 'Session not found' }, 404)
    const requestedPermission = deps.requestedMetadataPermission(input)
    if (requestedPermission === null) return deps.json({ error: 'Invalid permission override' }, 400)
    let context
    try {
      context = await deps.resolveToolSessionContext(client, authenticatedUser!.id, input.sessionId, input.profile.trim(), requestedPermission)
    } catch (error) {
      const failure = deps.sessionContextFailure(error)
      if (failure) return failure
      throw error
    }
    const updated = await deps.createProjectSessionRepository(client).updateSession(authenticatedUser!.id, input.sessionId, {
      profile: context.agentName,
      ...(requestedPermission === undefined ? {} : { permissionOverride: context.permissionOverride }),
    })
    if (!updated) return deps.json({ error: 'Session not found' }, 404)
    session.profile = context.agentName
    session.permissionOverride = updated.permissionOverride
    await deps.saveState(session)
    return deps.json(await deps.sendRpc(input.sessionId, { type: 'prompt', message: `/profile ${context.agentName}` }, session))
  }

  if (path[1] === 'extensions' && (path[2] === 'tools' || path[2] === 'list-tools') && request.method === 'GET') {
    if (!authenticatedUser) return deps.json({ message: 'Unauthorized' }, 401)
    try {
      const client = await deps.applicationDatabase()
      const sessionId = url.searchParams.get('sessionId')
      const session = sessionId ? await deps.ownedSessionRecord(client, authenticatedUser.id, sessionId) : null
      if (sessionId && !session) return deps.json({ message: 'Session not found' }, 404)
      const agentName = sessionId && session
        ? (await deps.resolveToolSessionContext(client, authenticatedUser.id, sessionId)).agentName
        : 'master'
      const tools = await deps.listToolsForAgent(client, authenticatedUser.id, agentName)
      return deps.json({ tools, ...(sessionId && session ? { commands: await deps.sendRpc(sessionId, { type: 'get_commands' }, session) } : {}) })
    } catch (error) { console.warn(`Tool registry request failed: ${deps.redactedDiagnostic(error)}`); return deps.json({ message: 'Tool registry unavailable' }, 503) }
  }

  if (path[1] === 'extensions' && path[2] === 'commands' && request.method === 'GET') {
    const sessionId = url.searchParams.get('sessionId')
    if (!sessionId) return deps.json({ commands: [] })
    const session = await deps.ownedSessionRecord(await deps.applicationDatabase(), authenticatedUser!.id, sessionId)
    if (!session) return deps.json({ error: 'Session not found' }, 404)
    return deps.json(await deps.sendRpc(sessionId, { type: 'get_commands' }, session))
  }

  if (path[1] === 'extensions' && path[2] === 'command' && path[3] && request.method === 'POST') {
    const input = await deps.body(request)
    if (typeof input.sessionId !== 'string') return deps.json({ error: 'sessionId is required' }, 400)
    const session = await deps.ownedSessionRecord(await deps.applicationDatabase(), authenticatedUser!.id, input.sessionId)
    if (!session) return deps.json({ error: 'Session not found' }, 404)
    const args = typeof input.args === 'string' && input.args.trim() ? ` ${input.args.trim()}` : ''
    return deps.json(await deps.sendRpc(input.sessionId, { type: 'prompt', message: `/${decodeURIComponent(path[3])}${args}` }, session))
  }

  if (path[1] === 'extensions' && (path[2] === 'session-search' || path[2] === 'session-history-search') && request.method === 'GET') {
    const query = (url.searchParams.get('q') ?? '').toLocaleLowerCase().trim()
    if (!query) return deps.json({ sessions: [] })
    const matches = []
    const ownedSessions = (await deps.createProjectSessionRepository(await deps.applicationDatabase()).listSessions(authenticatedUser!.id, { includeArchived: true }))
    for (const stored of ownedSessions) {
      const record = deps.sessions.find((candidate) => candidate.id === stored.id && candidate.userId === authenticatedUser!.id) ?? {
        id: stored.id, project: stored.project, title: stored.title, createdAt: stored.createdAt, updatedAt: stored.updatedAt, userId: stored.userId, tags: stored.tags,
      }
      try {
        const response = await deps.sendRpc(record.id, { type: 'get_messages' }, record) as any
        const payload = deps.entriesPayload(response)
        const text = deps.projectEntries(payload.entries, payload.leafId, record.id).map((item) => deps.sessionMessageText(item.info)).join('\n')
        if (`${record.title}\n${text}`.toLocaleLowerCase().includes(query)) matches.push(record)
      } catch {
        continue
      }
    }
    return deps.json({ sessions: matches })
  }

  if (path[1] === 'extensions' && path[2] === 'usage' && request.method === 'GET') {
    const values = []
    const ownedSessions = await deps.createProjectSessionRepository(await deps.applicationDatabase()).listSessions(authenticatedUser!.id, { includeArchived: true })
    for (const stored of ownedSessions) {
      const record = deps.sessions.find((candidate) => candidate.id === stored.id && candidate.userId === authenticatedUser!.id) ?? {
        id: stored.id, project: stored.project, title: stored.title, createdAt: stored.createdAt, updatedAt: stored.updatedAt, userId: stored.userId, tags: stored.tags,
      }
      try {
        const response = await deps.sendRpc(record.id, { type: 'get_session_stats' }, record) as any
        values.push({ session: record, stats: response.data ?? null })
      } catch {
        values.push({ session: record, stats: null })
      }
    }
    return deps.json({ sessions: values })
  }

  if (path[1] === 'extensions' && path[2] === 'session-title') {
    if (request.method === 'GET') {
      const sessionId = url.searchParams.get('sessionId')
      const record = sessionId ? await deps.ownedSessionRecord(await deps.applicationDatabase(), authenticatedUser!.id, sessionId) : null
      return deps.json({ title: record?.title ?? null })
    }
    if (request.method === 'POST') {
      const input = await deps.body(request)
      if (typeof input.sessionId !== 'string' || typeof input.title !== 'string' || !input.title.trim()) return deps.json({ error: 'sessionId and title are required' }, 400)
      const owned = await deps.ownedSessionRecord(await deps.applicationDatabase(), authenticatedUser!.id, input.sessionId)
      if (!owned) return deps.json({ error: 'Session not found' }, 404)
      const response = await deps.sendRpc(input.sessionId, { type: 'set_session_name', name: input.title.trim() }, owned)
      const record = owned
      record.title = input.title.trim()
      await deps.saveState(record)
      return deps.json({ response, session: record })
    }
  }

  if (path[1] === 'extensions' && path[2] === 'openapi-tools' && request.method === 'GET') return deps.json({ providers: deps.openApiProviders() })
  return undefined
}
