/* Domain route extracted from bridge-request-handler.ts. */
// @ts-nocheck
import type { BridgeRequestContext } from '../bridge-route-context.ts'

export async function handleAgentsRoute(context: BridgeRequestContext): Promise<Response | undefined> {
  const { request, url, path, correlationId, deps, gatewayCredential, internalRequest } = context
  let authenticatedUser = context.authenticatedUser
  if (path[1] === 'agents' && authenticatedUser) {
    try {
      const client = await deps.applicationDatabase()
      await deps.ensureUserDefaults(client, authenticatedUser.id)
      if (path.length === 2 && request.method === 'GET') return deps.json(await deps.listAgents(client, authenticatedUser.id).then((agents) => agents.map((agent) => ({ ...agent, systemPrompt: agent.system_prompt }))))
      if (path.length === 2 && request.method === 'POST') {
        const input = await deps.body(request)
        const name = typeof input.name === 'string' ? input.name.trim() : ''
        if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) return deps.json({ message: 'A valid agent name is required' }, 400)
        const now = Date.now()
        const record = await client.collection('agents').create({
          user_id: authenticatedUser.id,
          name,
          description: typeof input.description === 'string' ? input.description : '',
          mode: input.mode === 'subagent' ? 'subagent' : 'primary',
          prompt: typeof input.prompt === 'string' ? input.prompt : '',
          systemPrompt: typeof input.systemPrompt === 'string' ? input.systemPrompt : '',
           enabled: input.enabled !== false,
           ...(input.template === 'general' || input.template === 'coding' || input.template === 'plan' || input.template === 'reviewer' ? { template: input.template } : {}),
           ...(typeof input.model === 'string' ? { model: input.model } : {}),
           ...(input.thinking === 'off' || input.thinking === 'minimal' || input.thinking === 'low' || input.thinking === 'medium' || input.thinking === 'high' ? { thinking: input.thinking } : {}),
           ...(input.approval_mode === 'auto' || input.approval_mode === 'ask' || input.approval_mode === 'deny' ? { approval_mode: input.approval_mode } : {}),
           ...(input.policies && typeof input.policies === 'object' ? { policies: input.policies } : {}),
           ...(input.project_overrides && typeof input.project_overrides === 'object' ? { project_overrides: input.project_overrides } : {}),
           ...(input.tool_context_modes && typeof input.tool_context_modes === 'object' ? { tool_context_modes: input.tool_context_modes } : {}),
           ...(input.skill_context_modes && typeof input.skill_context_modes === 'object' ? { skill_context_modes: input.skill_context_modes } : {}),
           created_at: now,
          updated_at: now,
        })
        return deps.json({ ...record, systemPrompt: record.systemPrompt }, 201)
      }
      if (path.length === 3 && (request.method === 'PUT' || request.method === 'PATCH')) {
        const id = decodeURIComponent(path[2])
        const existing = await client.collection('agents').getOne(id).catch(() => null)
        if (!existing || existing.user_id !== authenticatedUser.id) return deps.json({ message: 'Agent not found' }, 404)
        const input = await deps.body(request)
        const update = {
          ...(typeof input.name === 'string' ? { name: input.name.trim() } : {}),
          ...(typeof input.description === 'string' ? { description: input.description } : {}),
          ...(input.mode === 'subagent' || input.mode === 'primary' ? { mode: input.mode } : {}),
          ...(typeof input.prompt === 'string' ? { prompt: input.prompt } : {}),
          ...(typeof input.systemPrompt === 'string' ? { systemPrompt: input.systemPrompt } : {}),
           ...(typeof input.enabled === 'boolean' ? { enabled: input.enabled } : {}),
           ...(input.template === 'general' || input.template === 'coding' || input.template === 'plan' || input.template === 'reviewer' ? { template: input.template } : {}),
           ...(typeof input.model === 'string' ? { model: input.model } : {}),
           ...(input.thinking === 'off' || input.thinking === 'minimal' || input.thinking === 'low' || input.thinking === 'medium' || input.thinking === 'high' ? { thinking: input.thinking } : {}),
           ...(input.approval_mode === 'auto' || input.approval_mode === 'ask' || input.approval_mode === 'deny' ? { approval_mode: input.approval_mode } : {}),
           ...(input.policies && typeof input.policies === 'object' ? { policies: input.policies } : {}),
           ...(input.project_overrides && typeof input.project_overrides === 'object' ? { project_overrides: input.project_overrides } : {}),
           ...(input.tool_context_modes && typeof input.tool_context_modes === 'object' ? { tool_context_modes: input.tool_context_modes } : {}),
           ...(input.skill_context_modes && typeof input.skill_context_modes === 'object' ? { skill_context_modes: input.skill_context_modes } : {}),
           updated_at: Date.now(),
        }
        const record = await client.collection('agents').update(id, update)
        return deps.json({ ...record, systemPrompt: record.systemPrompt })
      }
      if (path.length === 3 && request.method === 'DELETE') {
        const id = decodeURIComponent(path[2])
        const existing = await client.collection('agents').getOne(id).catch(() => null)
        if (!existing || existing.user_id !== authenticatedUser.id || existing.name === 'master') return deps.json({ message: 'Agent not found' }, 404)
        await client.collection('agents').delete(id)
        return deps.json({ success: true })
      }
    } catch (error) {
      console.warn(`Agent store request failed: ${deps.redactedDiagnostic(error)}`)
      return deps.json({ message: 'Agent store unavailable' }, 503)
    }
  }
  return undefined
}
