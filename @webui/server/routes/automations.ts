/* Domain route extracted from bridge-request-handler.ts. */
// @ts-nocheck
import type { BridgeRequestContext } from '../bridge-route-context.ts'

export async function handleAutomationsRoute(context: BridgeRequestContext): Promise<Response | undefined> {
  const { request, url, path, correlationId, deps, gatewayCredential, internalRequest } = context
  let authenticatedUser = context.authenticatedUser
  if (path[1] === 'automations' && authenticatedUser) {
    const client = await deps.applicationDatabase()
    const automations = new deps.AutomationRepository(client, { serializationScope: 'process' })
    try {
      if (path.length === 3 && path[2] === 'runs' && request.method === 'GET') {
        const limit = deps.routeLimit(url.searchParams.get('limit'))
        const offsetValue = Number(url.searchParams.get('offset') ?? 0)
        const offset = Number.isInteger(offsetValue) && offsetValue >= 0 ? Math.min(offsetValue, 10000) : 0
        const runsCollection = client.collection('automation_runs') as unknown as { getList?: (page: number, perPage: number, options: Record<string, unknown>) => Promise<{ items: Array<Record<string, unknown>> }>; getFullList: (options: Record<string, unknown>) => Promise<Array<Record<string, unknown>>> }
        const page = Math.floor(offset / 100) + 1
        const pageResult = await runsCollection.getList?.(page, 100, { filter: `owner_id = "${deps.escapeFilter(authenticatedUser.id)}"`, sort: '-created_at' })
        const rawRuns = pageResult?.items ?? await runsCollection.getFullList({ filter: `owner_id = "${deps.escapeFilter(authenticatedUser.id)}"`, sort: '-created_at' })
        const definitions = new Map((await automations.listOwned(authenticatedUser.id)).map((item) => [item.id, item]))
        const projectValue = url.searchParams.get('repoId') ?? url.searchParams.get('projectId') ?? undefined
        const projectId = await deps.ownedProjectIdForRoute(client, authenticatedUser.id, projectValue)
        if (projectValue !== undefined && projectId === null) return deps.routeError(correlationId, 'PROJECT_NOT_FOUND', 'Project not found', 404)
        const jobFilter = url.searchParams.get('jobId') ?? url.searchParams.get('automationId')
        const triggerFilter = url.searchParams.get('triggerSource')
        const runs = rawRuns
          .filter((item) => item.owner_id === authenticatedUser.id && definitions.has(String(item.automation_id)))
          .filter((item) => !url.searchParams.get('status') || item.state === url.searchParams.get('status'))
          .filter((item) => !jobFilter || String(item.automation_id) === jobFilter)
          .filter((item) => projectId === undefined || definitions.get(String(item.automation_id))?.project_id === projectId)
          .filter((item) => !triggerFilter || (triggerFilter === 'manual' ? String(item.trigger_key).startsWith('manual') : triggerFilter === 'automation' ? String(item.trigger_key).startsWith('schedule') : true))
          .slice(pageResult ? offset % 100 : offset, pageResult ? (offset % 100) + limit : offset + limit)
          .map((item) => ({ ...item, automation: definitions.get(String(item.automation_id)) }))
        return deps.json({ runs, limit, offset }, 200, correlationId)
      }
      if (path.length === 2 && request.method === 'GET') {
        const projectValue = url.searchParams.get('projectId') ?? url.searchParams.get('project_id') ?? undefined
        const projectId = await deps.ownedProjectIdForRoute(client, authenticatedUser.id, projectValue)
        if (projectValue !== undefined && projectId === null) return deps.routeError(correlationId, 'PROJECT_NOT_FOUND', 'Project not found', 404)
        const values = await automations.listOwned(authenticatedUser.id)
        const filtered = projectId === undefined ? values : values.filter((item) => item.project_id === projectId)
        const limit = deps.routeLimit(url.searchParams.get('limit'), 100)
        return deps.json({ automations: filtered.slice(0, limit), jobs: filtered.slice(0, limit) }, 200, correlationId)
      }
      if (path.length === 2 && request.method === 'POST') {
        const input = await deps.body(request)
        if (typeof input.name !== 'string' || typeof input.prompt !== 'string' || typeof input.agent_id !== 'string' || typeof input.timezone !== 'string' || !input.schedule || typeof input.schedule !== 'object') return deps.routeError(correlationId, 'INVALID_AUTOMATION_INPUT', 'name, prompt, agent_id, timezone, and schedule are required', 400)
        const ownedAgents = await deps.listAgents(client, authenticatedUser.id)
        if (!ownedAgents.some((agent) => agent.id === input.agent_id || agent.name === input.agent_id)) return deps.routeError(correlationId, 'AGENT_NOT_FOUND', 'Agent is not owned by the authenticated user', 403)
        const projectId = await deps.ownedProjectIdForRoute(client, authenticatedUser.id, input.project_id)
        if (projectId === null) return deps.routeError(correlationId, 'PROJECT_NOT_FOUND', 'Project is not owned by the authenticated user', 403)
        const created = await automations.create(authenticatedUser.id, { name: input.name, prompt: input.prompt, agent_id: input.agent_id, timezone: input.timezone, schedule: input.schedule as never, ...(projectId === undefined ? {} : { project_id: projectId }), ...(input.retry_policy && typeof input.retry_policy === 'object' ? { retry_policy: input.retry_policy as never } : {}), ...(input.concurrency_policy === 'allow' || input.concurrency_policy === 'skip' || input.concurrency_policy === 'queue' ? { concurrency_policy: input.concurrency_policy } : {}) })
        if (input.enabled === false) await automations.cancel(authenticatedUser.id, created.id)
        return deps.json({ automation: created, job: created }, 201, correlationId)
      }
      if (path.length === 3) {
        const id = decodeURIComponent(path[2])
        if (request.method === 'GET') { const found = await automations.getOwned(authenticatedUser.id, id); return found ? deps.json({ automation: found, job: found }, 200, correlationId) : deps.routeError(correlationId, 'AUTOMATION_NOT_FOUND', 'Automation not found', 404) }
        if (request.method === 'DELETE') {
          const found = await automations.getOwned(authenticatedUser.id, id)
          if (!found) return deps.routeError(correlationId, 'AUTOMATION_NOT_FOUND', 'Automation not found', 404)
          await client.collection('automations').update(id, { state: 'deleted', updated_at: Date.now() })
          return deps.json({ ok: true }, 200, correlationId)
        }
        if (request.method === 'PATCH' || request.method === 'PUT') {
          const input = await deps.body(request)
          if (Object.keys(input).some((key) => !['name', 'prompt', 'agent_id', 'project_id', 'timezone', 'schedule', 'retry_policy', 'concurrency_policy', 'enabled'].includes(key))) return deps.routeError(correlationId, 'UNSUPPORTED_AUTOMATION_FIELD', 'Unsupported automation field', 400)
          if (typeof input.enabled === 'boolean' && Object.keys(input).length === 1) {
            const found = await automations.getOwned(authenticatedUser.id, id)
            if (!found) return deps.routeError(correlationId, 'AUTOMATION_NOT_FOUND', 'Automation not found', 404)
            if (input.enabled === false) await automations.cancel(authenticatedUser.id, id)
            else await client.collection('automations').update(id, { state: 'active', updated_at: Date.now() })
            const updated = await automations.getOwned(authenticatedUser.id, id)
            return updated ? deps.json({ automation: updated, job: updated }, 200, correlationId) : deps.routeError(correlationId, 'AUTOMATION_NOT_FOUND', 'Automation not found', 404)
          }
          if (typeof input.agent_id === 'string' && !(await deps.listAgents(client, authenticatedUser.id)).some((agent) => agent.id === input.agent_id || agent.name === input.agent_id)) return deps.routeError(correlationId, 'AGENT_NOT_FOUND', 'Agent is not owned by the authenticated user', 403)
          const projectId = await deps.ownedProjectIdForRoute(client, authenticatedUser.id, input.project_id)
          if (projectId === null) return deps.routeError(correlationId, 'PROJECT_NOT_FOUND', 'Project is not owned by the authenticated user', 403)
          const { enabled, ...automationPatch } = input
          const patch = { ...automationPatch, ...(input.project_id !== undefined ? { project_id: projectId } : {}) }
          const updated = await automations.update(authenticatedUser.id, id, patch as never)
          if (!updated) return deps.routeError(correlationId, 'AUTOMATION_NOT_FOUND', 'Automation not found', 404)
          if (typeof enabled === 'boolean') {
            if (enabled === false) await automations.cancel(authenticatedUser.id, id)
            else await client.collection('automations').update(id, { state: 'active', updated_at: Date.now() })
          }
          const result = await automations.getOwned(authenticatedUser.id, id)
          return result ? deps.json({ automation: result, job: result }, 200, correlationId) : deps.routeError(correlationId, 'AUTOMATION_NOT_FOUND', 'Automation not found', 404)
        }
      }
      if (path.length === 4 && path[3] === 'run' && request.method === 'POST') {
        const automationId = decodeURIComponent(path[2])
        const target = await automations.getOwned(authenticatedUser.id, automationId)
        if (!target) return deps.routeError(correlationId, 'AUTOMATION_NOT_FOUND', 'Automation not found', 404)
        const input = await deps.body(request)
        const key = input.trigger_key === undefined ? `manual:${Date.now()}` : deps.validateTriggerKey(input.trigger_key)
        const queued = await automations.trigger(authenticatedUser.id, automationId, key)
        const run = await deps.automationWorkerFor(client).execute(authenticatedUser.id, queued.id)
        return deps.json({ run }, run.state === 'pending' || run.state === 'retrying' ? 202 : 200, correlationId)
      }
      if ((path.length === 4 && path[3] === 'cancel' || path.length === 5 && path[3] === 'runs' && path[4] === 'cancel' || path.length === 6 && path[3] === 'runs' && path[5] === 'cancel') && request.method === 'POST') {
        const automationId = decodeURIComponent(path[2])
        const runId = path.length === 6 ? decodeURIComponent(path[4]) : (await deps.body(request)).run_id
        if (typeof runId !== 'string' || !runId.trim()) return deps.routeError(correlationId, 'AUTOMATION_RUN_REQUIRED', 'run_id is required', 400)
        const run = await client.collection('automation_runs').getOne(runId).catch(() => null) as Record<string, unknown> | null
        if (!run || run.owner_id !== authenticatedUser.id || run.automation_id !== automationId) return deps.routeError(correlationId, 'AUTOMATION_RUN_NOT_FOUND', 'Automation run not found', 404)
        const cancelled = await automations.cancelRun(authenticatedUser.id, runId)
        if (cancelled) await deps.automationWorkerFor(client).executeDue()
        return cancelled ? deps.json({ run: cancelled }, 200, correlationId) : deps.routeError(correlationId, 'AUTOMATION_RUN_NOT_FOUND', 'Automation run not found', 404)
      }
      if (path.length === 4 && path[3] === 'history' && request.method === 'GET') return deps.json({ runs: (await automations.history(authenticatedUser.id, decodeURIComponent(path[2]))).slice(0, deps.routeLimit(url.searchParams.get('limit'))) }, 200, correlationId)
      if (path.length === 5 && path[3] === 'runs' && request.method === 'GET') {
        const automationId = decodeURIComponent(path[2])
        const runId = decodeURIComponent(path[4])
        const owned = await automations.getOwned(authenticatedUser.id, automationId)
        const run = owned ? (await automations.history(authenticatedUser.id, automationId)).find((candidate) => candidate.id === runId) : undefined
        return run ? deps.json({ run }, 200, correlationId) : deps.routeError(correlationId, 'AUTOMATION_RUN_NOT_FOUND', 'Automation run not found', 404)
      }
    } catch (error) {
      const code = error instanceof deps.RequestSecurityError ? error.code : error instanceof Error && error.message === deps.TRIGGER_KEY_ERROR ? 'INVALID_TRIGGER_KEY' : error instanceof Error && error.message.includes('not found') ? 'AUTOMATION_NOT_FOUND' : 'AUTOMATION_REQUEST_FAILED'
      const status = error instanceof deps.RequestSecurityError ? error.status : code === 'AUTOMATION_NOT_FOUND' ? 404 : 400
      return deps.routeError(correlationId, code, error instanceof Error ? error.message : 'Automation request failed', status)
    }
  }
  return undefined
}
