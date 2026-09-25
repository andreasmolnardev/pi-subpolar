/* Domain route extracted from bridge-request-handler.ts. */
// @ts-nocheck
import type { BridgeRequestContext } from '../bridge-route-context.ts'

export async function handleProjectsRoute(context: BridgeRequestContext): Promise<Response | undefined> {
  const { request, url, path, correlationId, deps, gatewayCredential, internalRequest } = context
  let authenticatedUser = context.authenticatedUser
  if (request.method === 'GET' && url.pathname === '/api/projects') {
    const client = await deps.applicationDatabase()
    return deps.json({ projects: await deps.ownedProjectResponses(authenticatedUser!.id, client) })
  }
  if (path[1] === 'projects' && path.length >= 4 && path[3] === 'repository' && request.method === 'GET') {
    const projectId = decodeURIComponent(path[2] ?? '')
    try {
      const client = await deps.applicationDatabase()
      const projectRepository = deps.createProjectSessionRepository(client)
      const service = new deps.GitReadService(new deps.GitPathPolicy((owner, id) => projectRepository.getProject(owner, id)))
      const action = path[4]
      const result = action === undefined ? await service.discover(authenticatedUser!.id, projectId, request.signal)
        : action === 'status' && path.length === 5 ? await service.status(authenticatedUser!.id, projectId, request.signal)
          : action === 'branches' && path.length === 5 ? await service.branches(authenticatedUser!.id, projectId, request.signal)
            : action === 'worktrees' && path.length === 5 ? await service.worktrees(authenticatedUser!.id, projectId, request.signal)
              : action === 'diff' && path.length === 5 ? await service.diff(authenticatedUser!.id, projectId, { path: url.searchParams.get('path') ?? undefined, ref: url.searchParams.get('ref') ?? undefined, staged: url.searchParams.get('staged') === 'true' }, request.signal)
                : null
      if (!result) return deps.json({ error: { code: 'NOT_FOUND', message: 'Repository route not found' }, requestId: correlationId }, 404)
      return deps.json({ ...result, requestId: correlationId })
    } catch (error) {
      if (error instanceof deps.GitServiceError) return deps.json({ error: { code: error.code, message: error.message }, requestId: correlationId }, error.status)
      console.warn(`Git read request failed: ${deps.redactedDiagnostic(error)}`)
      return deps.json({ error: { code: 'GIT_UNAVAILABLE', message: 'Git repository information is unavailable' }, requestId: correlationId }, 503)
    }
  }
  if (request.method === 'GET' && path[1] === 'projects' && path.length === 3) {
    const client = await deps.applicationDatabase()
    const owned = await deps.ownedProjectResponses(authenticatedUser!.id, client)
    const project = owned.find((item) => item.id === Number(path[2]))
    return project ? deps.json({ project }) : deps.json({ error: 'Project not found' }, 404)
  }

  if (request.method === 'POST' && path[1] === 'projects' && path.length === 2) {
    const input = await deps.body(request)
    const name = typeof input.name === 'string' ? input.name.trim() : ''
    if (!name || name.toLocaleLowerCase() === 'general chat') return deps.json({ error: 'A unique project name is required' }, 400)
    const directory = deps.safeProjectPath(typeof input.directory === 'string' && input.directory.trim()
      ? input.directory
      : deps.join(deps.projectsRoot, 'projects', name.toLocaleLowerCase().replace(/[^a-z0-9]+/g, '-')))
    const client = await deps.applicationDatabase()
    await deps.ensureUserMetadata(authenticatedUser!.id)
    const repository = deps.createProjectSessionRepository(client)
    if (await repository.findProjectByName(authenticatedUser!.id, name)) return deps.json({ error: 'Project already exists' }, 409)
    try {
      await repository.assertProjectPathAvailable(authenticatedUser!.id, directory)
      deps.mkdirSync(directory, { recursive: true })
      await repository.createProject(authenticatedUser!.id, {
        name,
        path: directory,
        ...(Array.isArray(input.agentNames) ? { agentNames: input.agentNames.filter((agentName): agentName is string => typeof agentName === 'string') } : {}),
      })
    } catch (error) {
      if (error instanceof deps.ProjectPathConflictError) return deps.json({ error: error.message, code: error.code }, 409)
      throw error
    }

    const owned = await deps.ownedProjectResponses(authenticatedUser!.id, client)
    const project = owned.find((item) => item.name === name)
    return deps.json(project ?? { error: 'Unable to create project' }, project ? 201 : 500)
  }
  if (request.method === 'PATCH' && path[1] === 'projects' && path.length === 3) {
    const id = Number(path[2])
    if (id === 0) return deps.json({ error: 'General Chat cannot be renamed' }, 400)
    const client = await deps.applicationDatabase()
    const owned = await deps.createProjectSessionRepository(client).listProjects(authenticatedUser!.id)
    const current = owned[id - 1]
    if (!current) return deps.json({ error: 'Project not found' }, 404)
    const input = await deps.body(request)
    const name = typeof input.name === 'string' && input.name.trim() ? input.name.trim() : current.name
    const directory = typeof input.directory === 'string' && input.directory.trim() ? deps.safeProjectPath(input.directory) : deps.safeProjectPath(current.path)
    let updated
    try {
      await deps.createProjectSessionRepository(client).assertProjectPathAvailable(authenticatedUser!.id, directory, current.id)
      deps.mkdirSync(directory, { recursive: true })
      updated = await deps.createProjectSessionRepository(client).updateProject(authenticatedUser!.id, current.id, {
        name,
        path: directory,
        ...(Array.isArray(input.agentNames) ? { agentNames: input.agentNames.filter((agentName): agentName is string => typeof agentName === 'string') } : {}),
      })
    } catch (error) {
      if (error instanceof deps.ProjectPathConflictError) return deps.json({ error: error.message, code: error.code }, 409)
      throw error
    }
    if (!updated) return deps.json({ error: 'Project not found' }, 404)

    return deps.json((await deps.ownedProjectResponses(authenticatedUser!.id, client)).find((project) => project.id === id) ?? { error: 'Project not found' })
  }
  if (request.method === 'DELETE' && path[1] === 'projects' && path.length === 3) {
    const id = Number(path[2])
    if (id === 0) return deps.json({ error: 'General Chat cannot be deleted' }, 400)
    const client = await deps.applicationDatabase()
    const owned = await deps.createProjectSessionRepository(client).listProjects(authenticatedUser!.id)
    const current = owned[id - 1]
    if (!current) return deps.json({ error: 'Project not found' }, 404)
    await deps.createProjectSessionRepository(client).deleteProject(authenticatedUser!.id, current.id)

    return deps.json({ ok: true })
  }
  if (request.method === 'POST' && path[1] === 'attachments' && path[2] === 'project') {
    const input = await deps.body(request)
    if (typeof input.directory !== 'string' || typeof input.path !== 'string') return deps.json({ error: 'directory and path are required' }, 400)
    const directory = input.directory
    const requestedPath = input.path
    const client = await deps.applicationDatabase()
    const owned = await deps.createProjectSessionRepository(client).listProjects(authenticatedUser!.id)
    const project = owned.find((item) => deps.canonicalProjectPath(item.path) === deps.canonicalProjectPath(directory))
    if (!project) return deps.json({ error: 'Project path is not owned by the authenticated user' }, 403)
    const file = deps.assertPathWithinWorkspace(requestedPath, project.path)
    const info = deps.statSync(file)
    if (!info.isFile()) return deps.json({ error: 'Attachment is not a file' }, 400)
    if (!/\.(md|mdx|txt|deps.json|csv|xml|ya?ml|js|jsx|ts|tsx|css|html|pdf|png|jpe?g|gif|webp)$/i.test(file)) return deps.json({ error: 'File type is not supported' }, 415)
    if (info.size > 10 * 1024 * 1024) return deps.json({ error: 'Attachment exceeds the 10 MB limit' }, 413)
    return deps.json({ path: file, name: file.split('/').pop() ?? file, size: info.size, mime: 'text/plain' })
  }
  if (request.method === 'POST' && path[1] === 'attachments' && path[2] === 'markdown') {
    const input = await deps.body(request)
    if (typeof input.directory !== 'string' || typeof input.name !== 'string' || typeof input.content !== 'string') return deps.json({ error: 'directory, name, and content are required' }, 400)
    const directory = input.directory
    const name = input.name
    const content = input.content
    if (!/^[a-zA-Z0-9._-]+\.md$/i.test(input.name) || input.content.length > 10 * 1024 * 1024) return deps.json({ error: 'Invalid Markdown attachment' }, 400)
    const client = await deps.applicationDatabase()
    const owned = await deps.createProjectSessionRepository(client).listProjects(authenticatedUser!.id)
    const project = owned.find((item) => deps.canonicalProjectPath(item.path) === deps.canonicalProjectPath(directory))
    if (!project) return deps.json({ error: 'Project path is not owned by the authenticated user' }, 403)
    const file = deps.assertPathWithinWorkspace(deps.join(project.path, name), project.path)
    deps.writeFileSync(file, content, 'utf8')
    return deps.json({ path: file, name }, 201)
  }
  if (request.method === 'POST' && path[1] === 'attachments' && path[2] === 'website') {
    const input = await deps.body(request)
    if (typeof input.url !== 'string') return deps.json({ error: 'url is required' }, 400)
    const target = new URL(input.url)
    const response = await deps.fetchWithNetworkPolicy(target, {}, { allowedHosts: [target.hostname], maxResponseBytes: 1024 * 1024, maxRedirects: 3 })
    if (!response.ok) return deps.json({ error: `Website returned HTTP ${response.status}` }, 400)
    const content = await deps.readBoundedResponse(response, 1024 * 1024)
    return deps.json({ url: target.href, content, size: new TextEncoder().encode(content).byteLength })
  }
  if (request.method === 'GET' && path[1] === 'projects' && path[2] === 'default-directory') {
    const name = url.searchParams.get('projectName')?.trim() || 'project'
    const directory = deps.join(deps.projectsRoot, 'projects', name.toLocaleLowerCase().replace(/[^a-z0-9]+/g, '-'))
    return deps.json({ directory })
  }
  if (request.method === 'GET' && path[1] === 'projects' && path[2] === 'directories') {
    const requested = url.searchParams.get('path')
    const currentPath = requested ? deps.safeProjectPath(requested) : deps.canonicalProjectPath(deps.projectsRoot)
    try {
      const client = await deps.applicationDatabase()
      const ownedRoots = (await deps.createProjectSessionRepository(client).listProjects(authenticatedUser!.id))
        .map((project) => deps.canonicalProjectPath(project.path))
      if (currentPath !== deps.canonicalProjectPath(deps.projectsRoot) && !ownedRoots.some((projectRoot) => deps.isPathWithin(projectRoot, currentPath))) {
        return deps.json({ error: 'Project path is not owned by the authenticated user' }, 403)
      }
      const directories = deps.readdirSync(currentPath, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
        .map((entry) => ({ name: entry.name, path: deps.join(currentPath, entry.name) }))
      return deps.json({ currentPath, directories })
    } catch (error) {
      console.warn(`Directory listing failed: ${deps.redactedDiagnostic(error)}`)
      return deps.json({ error: 'Unable to list project directories' }, 400)
    }
  }
  if (request.method === 'GET' && path[1] === 'projects' && path[2] === 'general-chat') {
    const directory = deps.generalChatProject().path
    return deps.json({ repoId: 0, directory, relativePath: directory, files: {}, agents: [], automationsSkill: { path: '', exists: false, created: false } })
  }
  if (request.method === 'GET' && url.pathname === '/api/new-session/deps.resolve') {
    const client = await deps.applicationDatabase()
    const repository = deps.createProjectSessionRepository(client)
    const ownedProjects = await repository.listProjects(authenticatedUser!.id)
    const projectCandidates = [
      { id: 0, ...deps.generalChatProject() },
      ...ownedProjects.map((project, index) => ({
        id: index + 1,
        name: project.name,
        path: project.path,
        agentNames: project.agentNames,
        hasAgentOverride: project.hasAgentOverride,
      })),
    ]
    const agentCandidates = await deps.listAgents(client, authenticatedUser!.id)
    try {
      const resolved = deps.resolveNewSessionRoute({
        projectName: url.searchParams.get('projectName') ?? undefined,
        agentName: url.searchParams.get('agentName') ?? undefined,
        projects: projectCandidates,
        agents: agentCandidates,
      })
      const projectId = typeof resolved.project.id === 'number' ? resolved.project.id : 0
      const preferences = await deps.getUserPreferences(client, authenticatedUser!.id)
      return deps.json({
        context: {
          project: deps.projectResponse(resolved.project, projectId, projectId === 0),
          agent: { id: resolved.agent.id, name: resolved.agent.name, description: resolved.agent.description },
          defaults: { permission: 'ask', ...(deps.preferenceModel(preferences?.preferences, 'conversation') ? { model: deps.preferenceModel(preferences?.preferences, 'conversation') } : {}) },
        },
      })
    } catch (error) {
      if (error instanceof deps.NewSessionRouteError) {
        const status = error.code === 'NEW_SESSION_PROJECT_NOT_FOUND' || error.code === 'NEW_SESSION_AGENT_NOT_FOUND' ? 404 : 409
        return deps.json({ error: error.message, code: error.code }, status)
      }
      throw error
    }
  }
  if (request.method === 'POST' && path[1] === 'projects' && path[2] === 'general-chat') {
    deps.mkdirSync(deps.generalChatProject().path, { recursive: true })
    return deps.json({ ok: true })
  }
  if (request.method === 'POST' && path[1] === 'projects' && path.length === 4 && path[3] === 'access') {
    // Compatibility heartbeat used by the project activity hook.
    return deps.json({ ok: true })
  }
  return undefined
}
