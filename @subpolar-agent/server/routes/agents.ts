/* Domain route extracted from bridge-request-handler.ts. */
// @ts-nocheck
import type { BridgeRequestContext } from '../bridge-route-context.ts'

const toolModes = new Set(['always', 'discoverable', 'on-demand', 'disabled'])
const skillModes = new Set(['always-loaded', 'discoverable', 'explicit-only', 'disabled'])
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const validModes = (value: unknown, modes: Set<string>) => isRecord(value) && Object.values(value).every((mode) => typeof mode === 'string' && modes.has(mode))
const validPolicies = (value: unknown) => isRecord(value) && Object.entries(value).every(([key, policy]) =>
  key === 'builtin' || key === 'registered'
    ? isRecord(policy) && Object.values(policy).every((effect) => typeof effect === 'boolean')
    : ['browser', 'memory', 'subagent'].includes(key) && typeof policy === 'boolean')

function profileInputError(input: unknown): string | undefined {
  if (!isRecord(input)) return 'Agent input must be an object'
  if (input.name !== undefined && (typeof input.name !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(input.name.trim()))) return 'A valid agent name is required'
  for (const [key, values] of Object.entries({ mode: ['primary', 'subagent'], template: ['general', 'coding', 'plan', 'reviewer'], thinking: ['off', 'minimal', 'low', 'medium', 'high'], approval_mode: ['auto', 'ask', 'deny'] })) {
    if (input[key] !== undefined && !values.includes(input[key] as string)) return `Invalid ${key}`
  }
  if (input.policies !== undefined && !validPolicies(input.policies)) return 'Invalid policies'
  if (input.permission !== undefined && !isRecord(input.permission)) return 'Invalid permission'
  if (input.tool_context_modes !== undefined && !validModes(input.tool_context_modes, toolModes)) return 'Invalid tool_context_modes'
  if (input.skill_context_modes !== undefined && !validModes(input.skill_context_modes, skillModes)) return 'Invalid skill_context_modes'
  if (input.project_overrides !== undefined && (!isRecord(input.project_overrides) || !Object.entries(input.project_overrides).every(([id, value]) => id.trim() && isRecord(value) && Object.entries(value).every(([key, setting]) =>
    key === 'tools' ? validModes(setting, toolModes) : key === 'skills' ? validModes(setting, skillModes) : key === 'policies' && validPolicies(setting))))) return 'Invalid project_overrides'
  return undefined
}

export async function handleAgentsRoute(context: BridgeRequestContext): Promise<Response | undefined> {
  const { request, url, path, correlationId, deps, gatewayCredential, internalRequest } = context
  let authenticatedUser = context.authenticatedUser
  if (path[1] === 'agents' && authenticatedUser) {
    try {
      const client = await deps.applicationDatabase()
      await deps.ensureUserDefaults(client, authenticatedUser.id)
      const validReferences = async (input) => {
        const ids = Object.keys(input.project_overrides ?? {})
        if (!ids.length) return true
        const repository = deps.createProjectSessionRepository(client)
        for (const id of ids) if (!await repository.getProject(authenticatedUser.id, id)) return false
        return true
      }
      if (path.length === 2 && request.method === 'GET') return deps.json(await deps.listAgents(client, authenticatedUser.id).then((agents) => agents.filter(agent => agent.user_id === authenticatedUser.id).map((agent) => ({ ...agent, systemPrompt: agent.system_prompt }))))
      if (path.length === 2 && request.method === 'POST') {
        const input = await deps.body(request)
        const inputError = profileInputError(input)
        if (inputError) return deps.json({ message: inputError }, 400)
        const name = typeof input.name === 'string' ? input.name.trim() : ''
        if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) return deps.json({ message: 'A valid agent name is required' }, 400)
        if (!await validReferences(input)) return deps.json({ message: 'Project not found' }, 404)
        const now = Date.now()
        const record = await client.collection('agents').create({
          user_id: authenticatedUser.id,
          name,
          description: typeof input.description === 'string' ? input.description : '',
          mode: input.mode === 'subagent' ? 'subagent' : 'primary',
          prompt: typeof input.prompt === 'string' ? input.prompt : '',
          systemPrompt: typeof input.systemPrompt === 'string' ? input.systemPrompt : '',
          enabled: input.enabled !== false,
          ...(typeof input.icon === 'string' ? { icon: input.icon } : {}),
          ...(Array.isArray(input.skills) ? { skills: input.skills } : {}),
          ...(Array.isArray(input.skillAccess) ? { skillAccess: input.skillAccess } : {}),
          ...(Array.isArray(input.allowedCommands) ? { allowedCommands: input.allowedCommands } : {}),
          ...(Array.isArray(input.toolAccess) ? { toolAccess: input.toolAccess } : {}),
          ...(input.permission && typeof input.permission === 'object' ? { permission: input.permission } : {}),
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
        const inputError = profileInputError(input)
        if (inputError) return deps.json({ message: inputError }, 400)
        if (!await validReferences(input)) return deps.json({ message: 'Project not found' }, 404)
        const update = {
          ...(typeof input.name === 'string' ? { name: input.name.trim() } : {}),
          ...(typeof input.description === 'string' ? { description: input.description } : {}),
          ...(input.mode === 'subagent' || input.mode === 'primary' ? { mode: input.mode } : {}),
          ...(typeof input.prompt === 'string' ? { prompt: input.prompt } : {}),
          ...(typeof input.systemPrompt === 'string' ? { systemPrompt: input.systemPrompt } : {}),
          ...(typeof input.enabled === 'boolean' ? { enabled: input.enabled } : {}),
          ...(typeof input.icon === 'string' ? { icon: input.icon } : {}),
          ...(Array.isArray(input.skills) ? { skills: input.skills } : {}),
          ...(Array.isArray(input.skillAccess) ? { skillAccess: input.skillAccess } : {}),
          ...(Array.isArray(input.allowedCommands) ? { allowedCommands: input.allowedCommands } : {}),
          ...(Array.isArray(input.toolAccess) ? { toolAccess: input.toolAccess } : {}),
          ...(input.permission && typeof input.permission === 'object' ? { permission: input.permission } : {}),
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
