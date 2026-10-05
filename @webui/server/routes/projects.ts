/* Domain route extracted from bridge-request-handler.ts. */
// @ts-nocheck
import type { BridgeRequestContext } from '../bridge-route-context.ts'
import { GitReadService } from '../git/service.ts'
import { GitPathPolicy } from '../git/policy.ts'
import { configuredWorkspaceRoot } from '../core/project-filesystem.ts'
import { GitServiceError } from '../git/contracts.ts'
import { WorktreeController, PocketBaseWorktreeStore } from '../git/worktree-control.ts'
import { TaskRepository } from '../application/task-control-plane.ts'
import { assertUserWorkspacePath, ownerProjectDirectory } from '../persistence/project-store.ts'

export async function handleProjectsRoute(context: BridgeRequestContext): Promise<Response | undefined> {
  const { request, url, path, correlationId, deps, gatewayCredential, internalRequest } = context
  let authenticatedUser = context.authenticatedUser
  if (['projects', 'attachments'].includes(path[1]) && !authenticatedUser) return deps.json({ message: 'Unauthorized' }, 401)
  // These literal routes must precede the numeric project selector.
  if (request.method === 'GET' && path[1] === 'projects' && path[2] === 'default-directory') {
    return deps.json({ directory: ownerProjectDirectory(authenticatedUser!.id, url.searchParams.get('projectName')?.trim() || 'project', deps.projectsRoot) })
  }
  if (request.method === 'GET' && path[1] === 'projects' && path[2] === 'directories') {
    const repository = deps.createProjectSessionRepository(await deps.applicationDatabase())
    const owned = await repository.listProjects(authenticatedUser!.id)
    const requested = url.searchParams.get('path')
    // The shared parent is a virtual picker, never a host directory listing.
    if (!requested || deps.canonicalProjectPath(requested) === deps.canonicalProjectPath(deps.projectsRoot)) return deps.json({ currentPath: '', directories: owned.map(project => ({ name: project.name, path: project.path })) })
    try {
      const currentPath = deps.safeProjectPath(requested)
      if (!owned.some(project => deps.isPathWithin(project.path, currentPath))) return deps.json({ error: 'Project path is not owned by the authenticated user' }, 403)
      await repository.assertProjectPathAvailable(authenticatedUser!.id, currentPath)
      const directories = []
      for (const entry of deps.readdirSync(currentPath, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue
        const path = deps.join(currentPath, entry.name)
        try { await repository.assertProjectPathAvailable(authenticatedUser!.id, path); directories.push({ name: entry.name, path }) } catch { /* Do not expose denied child names or paths. */ }
      }
      return deps.json({ currentPath, directories })
    } catch { return deps.json({ error: 'Unable to list project directories' }, 403) }
  }
  if (path[1] === 'projects' && path.length === 5 && path[3] === 'repository' && request.method === 'POST' && ['worktrees', 'refresh'].includes(path[4])) {
    if (!authenticatedUser || gatewayCredential || internalRequest) return deps.json({ error: { code: 'MUTATION_DENIED', message: 'Worktree actions require an authenticated user request' } }, 403)
    try {
      const client = await deps.applicationDatabase()
      const repository = deps.createProjectSessionRepository(client)
      const policy = new GitPathPolicy((owner, id) => repository.getProject(owner, id))
      const projectId = decodeURIComponent(path[2])
      const { project, root } = await policy.project(authenticatedUser!.id, projectId)
      const input = await deps.body(request)
      if (path[4] === 'refresh') {
        // Git subprocess fetch cannot enforce HTTP policy, redirects, DNS pinning or credential isolation.
        // Do not turn a configured remote (including helpers/local paths) into an unrestricted network capability.
        throw new GitServiceError('UNSUPPORTED', 'Remote fetch is unavailable: a policy-aware authenticated Git transport is required. Refresh local references instead.')
      }
      if (input.approved !== true) throw new GitServiceError('APPROVAL_REQUIRED', 'Explicit worktree creation approval is required')
      if (typeof input.branch !== 'string' || typeof input.sourceRef !== 'string' || typeof input.expectedSha !== 'string') throw new GitServiceError('INVALID_REQUEST', 'Branch, source reference and displayed SHA are required')
      const inspected = await new GitReadService(policy).branches(authenticatedUser!.id, projectId, request.signal)
      if (input.sourceRef !== 'HEAD' && !inspected.branches.some(branch => branch.ref === input.sourceRef && !branch.symbolic)) throw new GitServiceError('REF_DENIED', 'Select a displayed branch reference')
      const tasks = new TaskRepository(client)
      const task = await tasks.create({ owner_id: authenticatedUser!.id, project_id: projectId, state: 'draft', kind: 'task', title: `Worktree: ${input.branch}`, base_ref: input.sourceRef })
      const controller = new WorktreeController(new PocketBaseWorktreeStore(client))
      let worktree
      try {
        worktree = await controller.create({ ownerId: authenticatedUser!.id, projectId, repository: root, taskId: task.id, baseRef: input.sourceRef, branch: input.branch, expectedSha: input.expectedSha })
        // Register the actual checkout as an owned repository. Existing runtime cwd isolation stays intact.
        const linked = await repository.createProject(authenticatedUser!.id, { name: `${project.name} · ${worktree.branch} · ${worktree.id}`, path: worktree.path, ...(project.hasAgentOverride ? { agentNames: project.agentNames ?? [] } : {}) })
        const projects = await repository.listProjects(authenticatedUser!.id)
        return deps.json({ worktree, repositoryId: linked.id, projectId: projects.findIndex(item => item.id === linked.id) + 1 }, 201)
      } catch (error) {
        if (worktree) await controller.remove(worktree).catch(() => undefined)
        await tasks.transition(authenticatedUser!.id, task.id, 'cancelled', { error_code: 'WORKTREE_CREATE_FAILED' }).catch(() => undefined)
        throw error
      }
    } catch (error) {
      if (error instanceof GitServiceError) return deps.json({ error: { code: error.code, message: error.message } }, error.status)
      console.warn(`Worktree creation failed: ${deps.redactedDiagnostic(error)}`)
      return deps.json({ error: { code: 'GIT_FAILED', message: 'Worktree creation failed; inspect activity before retrying' } }, 400)
    }
  }
  if (request.method === 'GET' && url.pathname === '/api/projects') {
    const client = await deps.applicationDatabase()
    return deps.json({ projects: await deps.ownedProjectResponses(authenticatedUser!.id, client) })
  }
  if (path[1] === 'projects' && path.length >= 4 && path[3] === 'repository' && request.method === 'GET') {
    const projectId = decodeURIComponent(path[2] ?? '')
    try {
      const client = await deps.applicationDatabase()
      const projectRepository = deps.createProjectSessionRepository(client)
      const policy = new GitPathPolicy((owner, id) => projectRepository.getProject(owner, id), configuredWorkspaceRoot(), {}, async (owner, id, worktreePath) => {
        const record = await client.collection('task_worktrees').getFirstListItem(`owner_id = "${deps.escapeFilter(owner)}" && project_id = "${deps.escapeFilter(id)}" && path = "${deps.escapeFilter(worktreePath)}" && state = "active"`).catch(() => null)
        return record?.owner_id === owner && record.project_id === id && record.path === worktreePath && record.state === 'active'
      })
      const service = new GitReadService(policy)
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
  if (request.method === 'GET' && path[1] === 'projects' && path[2] === 'general-chat' && path.length === 3) {
    const directory = deps.generalChatProject().path
    return deps.json({ repoId: 0, directory, relativePath: directory, files: {}, agents: [], automationsSkill: { path: '', exists: false, created: false } })
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
      : ownerProjectDirectory(authenticatedUser!.id, name, deps.projectsRoot))
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
    await deps.createProjectSessionRepository(client).assertProjectPathAvailable(authenticatedUser!.id, project.path)
    const file = assertUserWorkspacePath(deps.assertPathWithinWorkspace(requestedPath, project.path))
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
    await deps.createProjectSessionRepository(client).assertProjectPathAvailable(authenticatedUser!.id, project.path)
    const file = assertUserWorkspacePath(deps.assertPathWithinWorkspace(deps.join(project.path, name), project.path))
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


  if (request.method === 'GET' && url.pathname === '/api/new-session/resolve') {
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
