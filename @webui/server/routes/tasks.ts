/* Domain route extracted from bridge-request-handler.ts. */
// @ts-nocheck
import type { BridgeRequestContext } from '../bridge-route-context.ts'

export async function handleTasksRoute(context: BridgeRequestContext): Promise<Response | undefined> {
  const { request, url, path, correlationId, deps, gatewayCredential, internalRequest } = context
  let authenticatedUser = context.authenticatedUser
  if (path[1] === 'tasks' && authenticatedUser) {
    const tasks = new deps.TaskRepository(await deps.applicationDatabase())
    try {
      if (path.length === 2 && request.method === 'GET') {
        const states = url.searchParams.getAll('state').filter((value): value is TaskState => ['draft', 'queued', 'running', 'waiting_for_input', 'waiting_for_approval', 'review_required', 'failed', 'completed', 'cancelled'].includes(value))
        return deps.json({ tasks: await tasks.listOwned(authenticatedUser.id, states) })
      }
      if (path.length === 2 && request.method === 'POST') {
        const input = deps.object(await deps.body(request)); const title = typeof input.title === 'string' ? input.title.trim() : ''
        if (!title) return deps.json({ error: 'title is required' }, 400)
        const state = input.state === 'draft' ? 'draft' : 'queued'
        const client = await deps.applicationDatabase()
        const repository = deps.createProjectSessionRepository(client)
        const kind = input.kind === 'subagent_run' ? 'subagent_run' : 'task'
        const sessionId = typeof input.sessionId === 'string' ? input.sessionId.trim() : ''
        const requestedProjectId = typeof input.projectId === 'string' ? input.projectId.trim() : ''
        const session = sessionId ? await repository.getSession(authenticatedUser.id, sessionId) : null
        if (sessionId && !session) throw new deps.TaskRequestError('SESSION_NOT_FOUND', 'Session not found', 404)
        const projectId = requestedProjectId || session?.projectId || undefined
        const project = projectId ? await repository.getProject(authenticatedUser.id, projectId) : null
        if (projectId && !project) throw new deps.TaskRequestError('PROJECT_NOT_FOUND', 'Project not found', 404)
        if (session?.projectId && projectId !== session.projectId) throw new deps.TaskRequestError('SESSION_PROJECT_MISMATCH', 'Session and project do not match')

        const parentRunId = typeof input.parentRunId === 'string' ? input.parentRunId.trim() : ''
        const parentRun = parentRunId ? await tasks.getOwned(authenticatedUser.id, parentRunId) : null
        if (parentRunId && !parentRun) throw new deps.TaskRequestError('PARENT_TASK_NOT_FOUND', 'Parent task not found', 404)
        if (parentRun && !sessionId && !projectId) throw new deps.TaskRequestError('PARENT_CONTEXT_REQUIRED', 'Parent task requires an owned session or project')
        if (parentRun && ((sessionId && parentRun.session_id !== sessionId) || (projectId && parentRun.project_id !== projectId))) throw new deps.TaskRequestError('PARENT_CONTEXT_MISMATCH', 'Parent task context does not match')

        const agents = await deps.listAgents(client, authenticatedUser.id)
        const resolveAgent = (value: unknown, code: string) => {
          if (typeof value !== 'string' || !value.trim()) return undefined
          const agent = agents.find((candidate) => candidate.id === value.trim() || candidate.name === value.trim())
          if (!agent) throw new deps.TaskRequestError(code, 'Agent not found', 404)
          if (!agent.enabled) throw new deps.TaskRequestError('AGENT_DISABLED', 'Agent is disabled', 409)
          return agent
        }
        const parentAgent = resolveAgent(input.agentId ?? session?.profile, 'PARENT_AGENT_NOT_FOUND')
        const targetAgent = resolveAgent(input.subagentId, 'TARGET_AGENT_NOT_FOUND')
        if (kind === 'subagent_run') {
          if (!session) throw new deps.TaskRequestError('SESSION_REQUIRED', 'An owned session is required')
          if (!projectId) throw new deps.TaskRequestError('PROJECT_REQUIRED', 'An owned project is required')
          if (!parentAgent || !targetAgent) throw new deps.TaskRequestError('AGENT_REQUIRED', 'Parent and target agents are required')
          if (session.profile && parentAgent.name !== session.profile && parentAgent.id !== session.profile) throw new deps.TaskRequestError('SESSION_AGENT_MISMATCH', 'Session and parent agent do not match')
          if (targetAgent.mode !== 'subagent') throw new deps.TaskRequestError('TARGET_AGENT_DENIED', 'Target agent is not a subagent', 403)
          if (project?.agentNames?.length && !project.agentNames.includes(targetAgent.name) && !project.agentNames.includes(targetAgent.id)) throw new deps.TaskRequestError('TARGET_AGENT_DENIED', 'Target agent is not enabled for this project', 403)
          const configuredTarget = deps.effectiveAgentConfiguration(targetAgent, projectId)
          const requested = deps.object(input.input).capabilities
          const capabilities = Array.isArray(requested) ? requested.filter((value): value is string => typeof value === 'string') : []
          const ceiling = new Set(['subagent/run', 'read', 'write', 'bash'].filter((capability) => capability === 'subagent/run' ? configuredTarget.policies.subagent : configuredTarget.policies.builtin[capability]))
          if (capabilities.some((capability) => !ceiling.has(capability))) throw new deps.TaskRequestError('CAPABILITY_ESCALATION', 'Requested capabilities exceed the target agent ceiling', 403)
        }
        return deps.json({ task: await tasks.create({ owner_id: authenticatedUser.id, project_id: projectId, session_id: (session?.id ?? sessionId) || undefined, parent_run_id: parentRun?.id, agent_id: parentAgent?.id, subagent_id: targetAgent?.id, state, kind, title, input: input.input }) }, 201)
      }
      const taskId = decodeURIComponent(path[2] ?? '')
      const ownedTask = await tasks.getOwned(authenticatedUser.id, taskId)
      if (path.length >= 3 && !ownedTask) return deps.json({ error: { code: 'TASK_NOT_FOUND', message: 'Task not found' } }, 404)
      if (path.length === 3 && request.method === 'GET') {
        return deps.json({ task: ownedTask })
      }
      if (path.length === 4 && path[3] === 'activity' && request.method === 'GET') return deps.json({ activity: await tasks.listActivity(authenticatedUser.id, taskId) })
      if (path.length === 4 && path[3] === 'audit' && request.method === 'GET') return deps.json({ audit: await tasks.listAudit(authenticatedUser.id, taskId) })
      if (path.length === 4 && path[3] === 'worktree' && request.method === 'GET') {
        const worktree = await (await deps.applicationDatabase()).collection('task_worktrees').getFirstListItem(`owner_id = "${deps.escapeFilter(authenticatedUser.id)}" && task_id = "${deps.escapeFilter(taskId)}"`).catch(() => null)
        return worktree ? deps.json({ worktree }) : deps.json({ error: { code: 'WORKTREE_NOT_FOUND', message: 'Worktree not found' } }, 404)
      }
      if (path.length === 4 && path[3] === 'cancel' && request.method === 'POST') {
        if (deps.subagentController) return deps.json({ task: await deps.subagentController.cancel(authenticatedUser.id, taskId) })
        return deps.json({ task: await tasks.transition(authenticatedUser.id, taskId, 'cancelled', { error_code: 'CANCELLED' }) })
      }
      if (path.length === 4 && path[3] === 'resume' && request.method === 'POST') {
        if (!deps.subagentController) return deps.json({ error: { code: 'SUBAGENT_UNAVAILABLE', message: 'Subagent execution host is unavailable' } }, 503)
        return deps.json({ task: await deps.subagentController.resume(authenticatedUser.id, taskId) })
      }
      if (path.length === 4 && path[3] === 'review' && request.method === 'POST') {
        const input = deps.object(await deps.body(request)); if (input.decision !== 'approved' && input.decision !== 'rejected') return deps.json({ error: 'decision must be approved or rejected' }, 400)
        return deps.json({ task: await tasks.review(authenticatedUser.id, taskId, input.decision, typeof input.note === 'string' ? input.note : undefined) })
      }
      return deps.json({ error: 'Task route not found' }, 404)
    } catch (error) {
      if (error instanceof deps.TaskRequestError) return deps.json({ error: { code: error.code, message: error.message } }, error.status)
      if (error instanceof deps.TaskControlError) return deps.json({ error: { code: error.code, message: error.message } }, error.code === 'TASK_NOT_FOUND' ? 404 : 409)
      throw error
    }
  }
  return undefined
}
