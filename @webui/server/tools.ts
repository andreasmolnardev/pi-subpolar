import type PocketBase from 'pocketbase'
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
} from '@earendil-works/pi-coding-agent'
import { escapeFilter } from './pocketbase'
import { createApprovalFlow, type ApprovalFlowApproval } from './approval-flow.ts'
import { createMcpAdapter, type McpToolReference } from './mcp-adapter.ts'
import { fetchWithNetworkPolicy, networkPolicyFromMetadata, readBoundedResponse } from './network-policy.ts'
import { redactSensitive, redactSensitiveText } from './security-redaction.ts'
import { createProjectSessionRepository, type SessionContext } from './project-store.ts'
import { assertPathWithinWorkspace, configuredWorkspaceRoot } from './project-filesystem.ts'
import { discardPendingApprovalInput, retainPendingApprovalInput, takePendingApprovalInput } from './approval-execution.ts'
import type { ToolGatewayContext } from './tool-gateway.ts'

export type ToolAdapter = 'internal' | 'http' | 'openapi' | 'mcp'
export type ToolEffect = 'allow' | 'deny' | 'approval'
export type ToolRisk = 'read' | 'write' | 'delete' | 'external'
export type PermissionOverride = 'ask' | 'none' | 'allow_all'
export type ToolContextMode = 'always' | 'discoverable' | 'on-demand' | 'disabled'
export type SkillContextMode = 'always-loaded' | 'discoverable' | 'explicit-only' | 'disabled'
export type AgentApprovalMode = 'auto' | 'ask' | 'deny'

export const TOOL_CONTEXT_MODES: readonly ToolContextMode[] = ['always', 'discoverable', 'on-demand', 'disabled']
export const SKILL_CONTEXT_MODES: readonly SkillContextMode[] = ['always-loaded', 'discoverable', 'explicit-only', 'disabled']
export const DECLARED_CAPABILITIES = ['subagent/run', 'read', 'write', 'bash'] as const

export type AgentPolicySet = {
  builtin: Record<string, boolean>
  registered: Record<string, boolean>
  browser: boolean
  memory: boolean
  subagent: boolean
}

export type AgentProjectOverride = {
  tools?: Record<string, ToolContextMode>
  skills?: Record<string, SkillContextMode>
  policies?: Partial<AgentPolicySet>
}

export type AgentEffectiveSource = {
  model: 'agent' | 'template' | 'default'
  thinking: 'agent' | 'template' | 'default'
  approval: 'agent' | 'template' | 'default'
  tools: 'agent' | 'template' | 'default' | 'project'
  skills: 'agent' | 'template' | 'default' | 'project'
}

export type ToolDefinition = {
  id?: string
  tool_id: string
  namespace: string
  description: string
  adapter: ToolAdapter
  target: string
  operation: string
  input_schema: Record<string, unknown>
  output_schema: Record<string, unknown>
  risk: ToolRisk
  requires_approval: boolean
  enabled: boolean
  metadata: Record<string, unknown>
  created_at?: number
  updated_at?: number
}

export type AgentDefinition = {
  id: string
  user_id: string
  name: string
  description: string
  mode: 'primary' | 'subagent'
  prompt: string
  system_prompt: string
  enabled: boolean
  template?: 'general' | 'coding' | 'plan' | 'reviewer'
  model: string
  thinking: 'off' | 'minimal' | 'low' | 'medium' | 'high'
  approval_mode: AgentApprovalMode
  policies: AgentPolicySet
  project_overrides: Record<string, AgentProjectOverride>
  tool_context_modes: Record<string, ToolContextMode>
  skill_context_modes: Record<string, SkillContextMode>
  effective_source: AgentEffectiveSource
  created_at?: number
  updated_at?: number
}

export type Approval = {
  id: string
  user_id: string
  agent_id: string
  session_id?: string
  tool_id: string
  input: unknown
  status: 'pending' | 'approved' | 'rejected' | 'expired'
  reason: string
  created_at: number
  resolved_at?: number
}

const piToolIds: Record<string, string> = {
  read: 'read',
  write: 'write',
  edit: 'edit',
  bash: 'bash',
  grep: 'grep',
  find: 'find',
  ls: 'ls',
}

const mcpAdapter = createMcpAdapter()
type SubagentToolRunner = (input: unknown, context: ToolGatewayContext) => Promise<unknown>
let subagentToolRunner: SubagentToolRunner | undefined

export function configureSubagentToolRunner(runner: SubagentToolRunner | undefined): void {
  subagentToolRunner = runner
}

const toolSeeds: Array<Omit<ToolDefinition, 'id' | 'created_at' | 'updated_at'>> = [
  { tool_id: 'subagent/run', namespace: 'builtin', description: 'Run an authorized isolated subagent task', adapter: 'internal', target: 'subagent', operation: 'run', input_schema: { type: 'object', properties: { targetAgent: { type: 'string', minLength: 1 }, prompt: { type: 'string', minLength: 1 }, capabilities: { type: 'array', items: { type: 'string' } }, coding: { type: 'boolean' } }, required: ['targetAgent', 'prompt'], additionalProperties: false }, output_schema: { type: 'object' }, risk: 'write', requires_approval: true, enabled: true, metadata: { capability: 'subagent/run' } },
  { tool_id: 'search-tool', namespace: 'builtin', description: 'Search tools available to the active agent', adapter: 'internal', target: 'tool-router', operation: 'search', input_schema: { type: 'object', properties: { query: { type: 'string', minLength: 1 } }, required: ['query'], additionalProperties: false }, output_schema: { type: 'array' }, risk: 'read', requires_approval: false, enabled: true, metadata: {} },
  { tool_id: 'read', namespace: 'builtin', description: 'Read files from the selected project', adapter: 'internal', target: 'pi', operation: 'read', input_schema: { type: 'object', properties: { path: { type: 'string' }, offset: { type: 'number' }, limit: { type: 'number' } }, required: ['path'], additionalProperties: false }, output_schema: { type: 'object' }, risk: 'read', requires_approval: false, enabled: true, metadata: {} },
  { tool_id: 'grep', namespace: 'builtin', description: 'Search file contents in the selected project', adapter: 'internal', target: 'pi', operation: 'grep', input_schema: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' }, glob: { type: 'string' }, ignoreCase: { type: 'boolean' }, literal: { type: 'boolean' }, context: { type: 'number' }, limit: { type: 'number' } }, required: ['pattern'], additionalProperties: false }, output_schema: { type: 'object' }, risk: 'read', requires_approval: false, enabled: true, metadata: {} },
  { tool_id: 'find', namespace: 'builtin', description: 'Find files in the selected project', adapter: 'internal', target: 'pi', operation: 'find', input_schema: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' }, limit: { type: 'number' } }, required: ['pattern'], additionalProperties: false }, output_schema: { type: 'object' }, risk: 'read', requires_approval: false, enabled: true, metadata: {} },
  { tool_id: 'ls', namespace: 'builtin', description: 'List files in the selected project', adapter: 'internal', target: 'pi', operation: 'ls', input_schema: { type: 'object', properties: { path: { type: 'string' }, limit: { type: 'number' } }, additionalProperties: false }, output_schema: { type: 'object' }, risk: 'read', requires_approval: false, enabled: true, metadata: {} },
  { tool_id: 'write', namespace: 'builtin', description: 'Write files in the selected project', adapter: 'internal', target: 'pi', operation: 'write', input_schema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'], additionalProperties: false }, output_schema: { type: 'object' }, risk: 'write', requires_approval: true, enabled: true, metadata: {} },
  { tool_id: 'edit', namespace: 'builtin', description: 'Edit files in the selected project', adapter: 'internal', target: 'pi', operation: 'edit', input_schema: { type: 'object', properties: { path: { type: 'string' }, edits: { type: 'array' } }, required: ['path', 'edits'], additionalProperties: false }, output_schema: { type: 'object' }, risk: 'write', requires_approval: true, enabled: true, metadata: {} },
  { tool_id: 'bash', namespace: 'builtin', description: 'Execute commands in the selected project', adapter: 'internal', target: 'pi', operation: 'bash', input_schema: { type: 'object', properties: { command: { type: 'string' }, timeout: { type: 'number' } }, required: ['command'], additionalProperties: false }, output_schema: { type: 'object' }, risk: 'external', requires_approval: true, enabled: true, metadata: {} },
]

function recordObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function toTool(value: unknown): ToolDefinition {
  const record = recordObject(value)
  const adapter = String(record.adapter)
  const risk = String(record.risk)
  return {
    id: typeof record.id === 'string' ? record.id : undefined,
    tool_id: canonicalToolId(String(record.tool_id), adapter as ToolAdapter, String(record.namespace ?? '')),
    namespace: String(record.namespace ?? ''),
    description: String(record.description ?? ''),
    adapter: adapter === 'http' || adapter === 'openapi' || adapter === 'mcp' ? adapter : 'internal',
    target: String(record.target ?? ''),
    operation: String(record.operation ?? ''),
    input_schema: recordObject(record.input_schema),
    output_schema: recordObject(record.output_schema),
    risk: risk === 'write' || risk === 'delete' || risk === 'external' ? risk : 'read',
    requires_approval: record.requires_approval === true,
    enabled: record.enabled !== false,
    metadata: recordObject(record.metadata),
    created_at: typeof record.created_at === 'number' ? record.created_at : undefined,
    updated_at: typeof record.updated_at === 'number' ? record.updated_at : undefined,
  }
}

function toAgent(value: unknown): AgentDefinition {
  const record = recordObject(value)
  const template = record.template === 'general' || record.template === 'coding' || record.template === 'plan' || record.template === 'reviewer' ? record.template : undefined
  const fallback = templateDefaults(template)
  const modes = normalizeToolModes(record.tool_context_modes ?? fallback.tool_context_modes)
  const skillModes = normalizeSkillModes(record.skill_context_modes ?? fallback.skill_context_modes)
  return {
    id: String(record.id),
    user_id: String(record.user_id),
    name: String(record.name),
    description: String(record.description ?? ''),
    mode: record.mode === 'subagent' ? 'subagent' : 'primary',
    prompt: String(record.prompt ?? ''),
    system_prompt: String(record.systemPrompt ?? record.system_prompt ?? ''),
    enabled: record.enabled !== false,
    template,
    model: typeof record.model === 'string' ? record.model : fallback.model,
    thinking: validThinking(record.thinking) ?? fallback.thinking,
    approval_mode: validApproval(record.approval_mode) ?? fallback.approval_mode,
    policies: normalizePolicies(record.policies ?? fallback.policies),
    project_overrides: normalizeProjectOverrides(record.project_overrides),
    tool_context_modes: modes,
    skill_context_modes: skillModes,
    effective_source: normalizeSources(record.effective_source, template),
    created_at: typeof record.created_at === 'number' ? record.created_at : undefined,
    updated_at: typeof record.updated_at === 'number' ? record.updated_at : undefined,
  }
}

function validThinking(value: unknown): AgentDefinition['thinking'] | undefined {
  return value === 'off' || value === 'minimal' || value === 'low' || value === 'medium' || value === 'high' ? value : undefined
}
function validApproval(value: unknown): AgentApprovalMode | undefined {
  return value === 'auto' || value === 'ask' || value === 'deny' ? value : undefined
}
function normalizeToolModes(value: unknown): Record<string, ToolContextMode> {
  const source = recordObject(value); const result: Record<string, ToolContextMode> = {}
  for (const [id, mode] of Object.entries(source)) if (TOOL_CONTEXT_MODES.includes(mode as ToolContextMode)) result[canonicalToolId(id)] = mode as ToolContextMode
  return result
}
function normalizeSkillModes(value: unknown): Record<string, SkillContextMode> {
  const source = recordObject(value); const result: Record<string, SkillContextMode> = {}
  for (const [id, mode] of Object.entries(source)) if (SKILL_CONTEXT_MODES.includes(mode as SkillContextMode)) result[id] = mode as SkillContextMode
  return result
}
function normalizePolicies(value: unknown): AgentPolicySet {
  const source = recordObject(value); const registered = recordObject(source.registered); const builtin = recordObject(source.builtin)
  const booleans = (input: Record<string, unknown>): Record<string, boolean> => Object.fromEntries(Object.entries(input).filter(([, v]) => typeof v === 'boolean')) as Record<string, boolean>
  return { builtin: booleans(builtin), registered: booleans(registered), browser: source.browser === true, memory: source.memory === true, subagent: source.subagent === true }
}
function normalizeProjectOverrides(value: unknown): Record<string, AgentProjectOverride> {
  const result: Record<string, AgentProjectOverride> = {}
  for (const [project, raw] of Object.entries(recordObject(value))) {
    const item = recordObject(raw)
    result[project] = { tools: normalizeToolModes(item.tools), skills: normalizeSkillModes(item.skills), policies: normalizePolicies(item.policies) }
  }
  return result
}
function templateDefaults(template?: AgentDefinition['template']): Pick<AgentDefinition, 'model' | 'thinking' | 'approval_mode' | 'policies' | 'tool_context_modes' | 'skill_context_modes'> {
  const readOnly = template === 'coding' || template === 'plan' || template === 'reviewer'
  const tool_context_modes: Record<string, ToolContextMode> = { read: 'always', grep: 'always', find: 'always', ls: 'always', 'search-tool': 'discoverable' }
  if (!template || !readOnly) Object.assign(tool_context_modes, { write: 'always', edit: 'always', bash: 'always' })
  else Object.assign(tool_context_modes, { write: 'disabled', edit: 'disabled', bash: 'disabled' })
  return { model: '', thinking: 'medium', approval_mode: readOnly ? 'auto' : 'ask', policies: { builtin: {}, registered: {}, browser: false, memory: false, subagent: false }, tool_context_modes, skill_context_modes: {} }
}
function normalizeSources(value: unknown, template: AgentDefinition['template']): AgentEffectiveSource {
  const source = recordObject(value); const base = template ? 'template' : 'default'
  const pick = (key: keyof AgentEffectiveSource): AgentEffectiveSource[typeof key] => source[key] === 'agent' || source[key] === 'template' || source[key] === 'project' ? source[key] as AgentEffectiveSource[typeof key] : base
  return { model: pick('model') as AgentEffectiveSource['model'], thinking: pick('thinking') as AgentEffectiveSource['thinking'], approval: pick('approval') as AgentEffectiveSource['approval'], tools: pick('tools') as AgentEffectiveSource['tools'], skills: pick('skills') as AgentEffectiveSource['skills'] }
}

function toApproval(value: unknown): Approval {
  const record = recordObject(value)
  const status = String(record.status)
  return {
    id: String(record.id),
    user_id: String(record.user_id),
    agent_id: String(record.agent_id),
    session_id: typeof record.session_id === 'string' ? record.session_id : undefined,
    tool_id: String(record.tool_id),
    input: redactSensitive(record.input),
    status: status === 'approved' || status === 'rejected' || status === 'expired' ? status : 'pending',
    reason: redactSensitiveText(String(record.reason ?? '')),
    created_at: Number(record.created_at ?? Date.now()),
    resolved_at: typeof record.resolved_at === 'number' ? record.resolved_at : undefined,
  }
}

function requiredInputError(schema: Record<string, unknown>, input: unknown): string | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return 'Tool input must be a JSON object'
  const required = Array.isArray(schema.required) ? schema.required : []
  for (const key of required) {
    if (!(String(key) in input)) return `Missing required field: ${String(key)}`
  }
  return null
}

const legacyToolIds: Record<string, string> = {
  'tools.list': 'search-tool',
  'pi.read': 'read',
  'pi.write': 'write',
  'pi.edit': 'edit',
  'pi.bash': 'bash',
  'pi.grep': 'grep',
  'pi.find': 'find',
  'pi.ls': 'ls',
}

export function canonicalToolId(toolId: string, adapter?: ToolAdapter, namespace?: string): string {
  const legacy = legacyToolIds[toolId]
  if (legacy) return legacy
  if (adapter && adapter !== 'internal' && namespace && !toolId.includes('/')) {
    const operation = toolId.includes('.') ? toolId.slice(toolId.lastIndexOf('.') + 1) : toolId
    return `${namespace}/${operation}`
  }
  return toolId
}

function generatedSkillName(toolId: string): string {
  return `tool-${toolId.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`
}

async function findAgent(client: PocketBase, userId: string, nameOrId: string): Promise<AgentDefinition | null> {
  const safeUser = escapeFilter(userId)
  const safeName = escapeFilter(nameOrId)
  const record = await client.collection('agents').getFirstListItem(`user_id = "${safeUser}" && (id = "${safeName}" || name = "${safeName}")`).catch(() => null)
  return record ? toAgent(record) : null
}

export async function ensureToolRegistry(client: PocketBase): Promise<void> {
  const existingTools = await client.collection('tool_registry').getFullList()
  for (const record of existingTools) {
    const oldId = String(record.tool_id ?? '')
    const nextId = canonicalToolId(oldId, String(record.adapter) as ToolAdapter, String(record.namespace ?? ''))
    if (nextId === oldId) continue
    const conflict = existingTools.find((candidate) => String(candidate.tool_id) === nextId)
    if (!conflict) await client.collection('tool_registry').update(record.id, { tool_id: nextId, namespace: String(record.namespace ?? 'builtin'), updated_at: Date.now() })
    else await client.collection('tool_registry').delete(record.id)
    const policies = await client.collection('agent_tool_policies').getFullList({ filter: `tool_id = "${escapeFilter(oldId)}"` }).catch(() => [])
    for (const policy of policies) await client.collection('agent_tool_policies').update(policy.id, { tool_id: nextId, updated_at: Date.now() })
  }

  for (const seed of toolSeeds) {
    const safeId = escapeFilter(seed.tool_id)
    const existing = await client.collection('tool_registry').getFirstListItem(`tool_id = "${safeId}"`).catch(() => null)
    const data = { ...seed, updated_at: Date.now() }
    if (existing) await client.collection('tool_registry').update(existing.id, data)
    else await client.collection('tool_registry').create({ ...data, created_at: Date.now() })
  }
}

export async function upsertRegisteredTool(client: PocketBase, definition: Omit<ToolDefinition, 'id' | 'created_at' | 'updated_at'>): Promise<ToolDefinition> {
  const tool_id = canonicalToolId(definition.tool_id, definition.adapter, definition.namespace)
  const data = { ...definition, tool_id, updated_at: Date.now() }
  const existing = await client.collection('tool_registry').getFirstListItem(`tool_id = "${escapeFilter(tool_id)}"`).catch(() => null)
  const record = existing
    ? await client.collection('tool_registry').update(existing.id, data)
    : await client.collection('tool_registry').create({ ...data, created_at: Date.now() })
  return toTool(record)
}

export async function ensureUserDefaults(client: PocketBase, userId: string): Promise<AgentDefinition> {
  const existing = await findAgent(client, userId, 'master')
  const now = Date.now()
  const agent = existing ?? toAgent(await client.collection('agents').create({
    user_id: userId,
    name: 'master',
    description: 'Full-access Pi agent controlled by the tool policy layer',
    mode: 'primary',
    prompt: '',
    system_prompt: '',
    enabled: true,
    created_at: now,
    updated_at: now,
  }))

  // Templates are ordinary owned records. They can be edited, disabled, or
  // deleted like any other profile; only their initial values are special.
  for (const template of ['general', 'coding', 'plan', 'reviewer'] as const) {
    const name = template[0].toUpperCase() + template.slice(1)
    const exists = await findAgent(client, userId, name)
    if (exists) continue
    const defaults = templateDefaults(template)
    await client.collection('agents').create({ user_id: userId, name, description: `${name} agent template`, mode: 'primary', prompt: '', system_prompt: '', enabled: true, template, ...defaults, created_at: now, updated_at: now })
  }

  const policies = await client.collection('agent_tool_policies').getFullList({ filter: `user_id = "${escapeFilter(userId)}" && agent_id = "${escapeFilter(agent.id)}"` })
  const existingTools = new Set(policies.map((item) => String(item.tool_id)))
  for (const seed of toolSeeds) {
    if (existingTools.has(seed.tool_id)) continue
    await client.collection('agent_tool_policies').create({
      user_id: userId,
      agent_id: agent.id,
      tool_id: seed.tool_id,
      effect: seed.requires_approval ? 'approval' : 'allow',
      created_at: now,
      updated_at: now,
    })
  }
  return agent
}

export async function listAgents(client: PocketBase, userId: string): Promise<AgentDefinition[]> {
  await ensureUserDefaults(client, userId)
  const records = await client.collection('agents').getFullList({ filter: `user_id = "${escapeFilter(userId)}"`, sort: 'name' })
  return records.map(toAgent)
}

export function agentTemplateDefaults(template: AgentDefinition['template']): Pick<AgentDefinition, 'model' | 'thinking' | 'approval_mode' | 'policies' | 'tool_context_modes' | 'skill_context_modes'> {
  return templateDefaults(template)
}

export function effectiveAgentConfiguration(agent: AgentDefinition, projectId?: string): AgentDefinition {
  const override = projectId ? agent.project_overrides[projectId] : undefined
  if (!override) return agent
  const reduceMode = (base: ToolContextMode, next: ToolContextMode): ToolContextMode => {
    const order = { disabled: 0, 'on-demand': 1, discoverable: 2, always: 3 }
    return order[next] < order[base] ? next : base
  }
  const tools = { ...agent.tool_context_modes }
  for (const [id, mode] of Object.entries(override.tools ?? {})) tools[id] = reduceMode(tools[id] ?? 'disabled', mode)
  const skills = { ...agent.skill_context_modes, ...override.skills }
  return { ...agent, tool_context_modes: tools, skill_context_modes: skills, policies: { ...agent.policies, ...override.policies, builtin: { ...agent.policies.builtin, ...(override.policies?.builtin ?? {}) }, registered: { ...agent.policies.registered, ...(override.policies?.registered ?? {}) } }, effective_source: { ...agent.effective_source, tools: 'project', skills: 'project' } }
}

export function agentToolContextMode(agent: AgentDefinition, toolId: string): ToolContextMode {
  return toolContextMode(agent, toolId)
}

export function skillIsExposed(agent: AgentDefinition, skillId: string, explicit = false): boolean {
  const mode = agent.skill_context_modes[skillId] ?? 'disabled'
  if (mode === 'disabled') return false
  if (mode === 'explicit-only') return explicit
  return mode === 'always-loaded' || mode === 'discoverable'
}

function toolContextMode(agent: AgentDefinition, toolId: string): ToolContextMode {
  // Records created before context modes existed retain their policy behavior.
  // New templates remain fail-closed for IDs not explicitly configured.
  return agent.tool_context_modes[toolId] ?? (agent.template ? 'disabled' : 'always')
}

export async function listToolsForAgent(client: PocketBase, userId: string, agentName = 'master', projectId?: string): Promise<Array<{ id: string; description: string; inputSchema: Record<string, unknown>; requiresApproval: boolean }>> {
  let agent = agentName === 'master'
    ? await findAgent(client, userId, agentName) ?? await ensureUserDefaults(client, userId)
    : await findAgent(client, userId, agentName)
  if (!agent || !agent.enabled) return []
  agent = effectiveAgentConfiguration(agent, projectId)
  const policies = await client.collection('agent_tool_policies').getFullList({ filter: `user_id = "${escapeFilter(userId)}" && agent_id = "${escapeFilter(agent.id)}"` })
  const policyMap = new Map(policies.map((item) => [String(item.tool_id), String(item.effect) as ToolEffect]))
  const tools = await client.collection('tool_registry').getFullList({ filter: 'enabled = true', sort: 'namespace,tool_id' })
  return tools.flatMap((record) => {
    const tool = toTool(record)
    const contextMode = toolContextMode(agent, tool.tool_id)
    const effect = policyMap.get(tool.tool_id)
    if (contextMode === 'disabled' || contextMode === 'on-demand' || effect === 'deny' || (!effect && !agent.name.startsWith('master'))) return []
    return [{ id: tool.tool_id, description: tool.description, inputSchema: tool.input_schema, requiresApproval: tool.requires_approval || effect === 'approval' }]
  })
}

export async function describeToolForAgent(client: PocketBase, userId: string, agentName: string, toolId: string) {
  const canonicalId = canonicalToolId(toolId)
  const tools = await listToolsForAgent(client, userId, agentName)
  const tool = tools.find((item) => item.id === canonicalId)
  if (!tool) return null
  const record = await client.collection('tool_registry').getFirstListItem(`tool_id = "${escapeFilter(canonicalId)}" && enabled = true`).catch(() => null)
  if (!record) return null
  const definition = toTool(record)
  return { ...tool, outputSchema: definition.output_schema, risk: definition.risk, examples: definition.metadata.examples ?? [] }
}

async function getTool(client: PocketBase, toolId: string): Promise<ToolDefinition | null> {
  const record = await client.collection('tool_registry').getFirstListItem(`tool_id = "${escapeFilter(toolId)}" && enabled = true`).catch(() => null)
  return record ? toTool(record) : null
}

async function writeAudit(client: PocketBase, data: Record<string, unknown>): Promise<void> {
  const safe = redactSensitive(data)
  await client.collection('tool_call_audit').create({ ...(safe && typeof safe === 'object' && !Array.isArray(safe) ? safe : {}), created_at: Date.now() })
}


export async function listPendingApprovals(client: PocketBase, userId: string, sessionId?: string): Promise<Approval[]> {
  const result = await createApprovalFlow(client).pending({ userId }, sessionId)
  return result.approvals.map(toApproval)
}

export async function respondToApproval(client: PocketBase, userId: string, approvalId: string, decision: boolean | 'approve' | 'approved' | 'reject' | 'rejected', sessionId: string): Promise<Approval | null> {
  if (!sessionId.trim()) return null
  const resolved = await createApprovalFlow(client).resolve({ userId, sessionId }, approvalId, decision)
  if (!resolved.ok || (resolved.state !== 'approved' && resolved.state !== 'rejected')) return null
  if (resolved.state === 'rejected') discardPendingApprovalInput(resolved.approval.id)
  return toApproval(resolved.approval)
}



async function invokeInternalTool(tool: ToolDefinition, input: unknown, cwd: string, callId: string, context?: ToolGatewayContext): Promise<unknown> {
  if (tool.target === 'subagent' && tool.operation === 'run') {
    if (!subagentToolRunner) throw new Error('Subagent execution host is unavailable')
    return subagentToolRunner(input, { ...context, cwd, callId } as ToolGatewayContext)
  }
  const definitions = {
    read: createReadToolDefinition(cwd),
    write: createWriteToolDefinition(cwd),
    edit: createEditToolDefinition(cwd),
    bash: createBashToolDefinition(cwd),
    grep: createGrepToolDefinition(cwd),
    find: createFindToolDefinition(cwd),
    ls: createLsToolDefinition(cwd),
  } as const
  const definition = definitions[tool.operation as keyof typeof definitions]
  if (!definition) throw new Error(`Unknown internal tool operation: ${tool.operation}`)
  return definition.execute(callId, input as never, undefined, undefined, undefined as never)
}

async function invokeExternalTool(tool: ToolDefinition, input: unknown, cwd: string, callId: string, context?: ToolGatewayContext): Promise<unknown> {
  if (tool.adapter === 'internal') {
    if (tool.target === 'pi') return invokeInternalTool(tool, input, cwd, callId, context)
    return { routed: true, toolId: tool.tool_id, operation: tool.operation, input }
  }
  if (tool.adapter === 'mcp') {
    const reference: McpToolReference = {
      tool_id: tool.tool_id,
      namespace: tool.namespace,
      description: tool.description,
      target: tool.target,
      operation: tool.operation,
      metadata: tool.metadata,
    }
    const timeoutMs = typeof tool.metadata.timeoutMs === 'number' ? tool.metadata.timeoutMs : undefined
    const result = await mcpAdapter.invoke(reference, input, { timeoutMs })
    return {
      content: result.content,
      details: {
        isError: result.isError,
        ...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }),
      },
    }
  }

  const metadata = tool.metadata
  let configuredUrl = typeof metadata.url === 'string' ? metadata.url : tool.target
  if (!configuredUrl || !/^https?:\/\//i.test(configuredUrl)) throw new Error(`No HTTP endpoint configured for ${tool.tool_id}`)
  const method = typeof metadata.method === 'string' ? metadata.method.toUpperCase() : 'POST'
  const headers = recordObject(metadata.headers)
  const requestHeaders: Record<string, string> = { accept: 'application/json' }
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === 'string') requestHeaders[key] = value
    else if (recordObject(value).env && typeof recordObject(value).env === 'string') {
      const resolved = process.env[String(recordObject(value).env)]
      if (resolved !== undefined) requestHeaders[key] = resolved
    }
  }
  const args = recordObject(input)
  const parameters = Array.isArray(metadata.parameters) ? metadata.parameters : []
  const query = new URLSearchParams()
  for (const parameter of parameters) {
    const item = recordObject(parameter)
    const name = typeof item.name === 'string' ? item.name : ''
    const location = typeof item.in === 'string' ? item.in : ''
    if (!name || args[name] === undefined) continue
    const value = Array.isArray(args[name]) ? args[name].join(',') : String(args[name])
    if (location === 'path') configuredUrl = configuredUrl.replace(`{${name}}`, encodeURIComponent(value))
    else if (location === 'query') query.set(name, value)
    else if (location === 'header') requestHeaders[name] = value
  }
  const requestUrl = new URL(configuredUrl)
  query.forEach((value, key) => requestUrl.searchParams.set(key, value))
  const requestBody = args.body === undefined ? (parameters.length ? undefined : input) : args.body
  if (requestBody !== undefined) requestHeaders['content-type'] = 'application/json'
  const serializedBody = requestBody === undefined ? undefined : JSON.stringify(requestBody ?? {})
  if (serializedBody !== undefined && new TextEncoder().encode(serializedBody).byteLength > 1 * 1024 * 1024) {
    throw new Error('External tool request body exceeds the configured limit')
  }
  const networkPolicy = networkPolicyFromMetadata(metadata)
  const response = await fetchWithNetworkPolicy(requestUrl, {
    method,
    headers: requestHeaders,
    body: method === 'GET' || method === 'HEAD' ? undefined : serializedBody,
  }, networkPolicy)
  const text = await readBoundedResponse(response, networkPolicy.maxResponseBytes ?? 4 * 1024 * 1024)
  if (!response.ok) throw new Error(`External tool returned HTTP ${response.status}: ${redactSensitiveText(text.slice(0, 500))}`)
  try { return JSON.parse(text) } catch { return text }
}

export async function callTool(client: PocketBase, userId: string, agentName: string, toolId: string, input: unknown, sessionId?: string, override?: PermissionOverride, options: { cwd?: string; callId?: string; waitForApproval?: boolean; onApproval?: (approval: Approval) => void | Promise<void>; capabilities?: readonly string[] } = {}) {
  const canonicalId = canonicalToolId(toolId)
  if (options.capabilities?.some((capability) => !(DECLARED_CAPABILITIES as readonly string[]).includes(capability))) {
    return { ok: false as const, toolId: canonicalId, error: { code: 'CAPABILITY_INVALID', message: 'Unknown execution capability' } }
  }
  if (!sessionId?.trim()) {
    await writeAudit(client, { user_id: userId, tool_id: canonicalId, input, status: 'denied', error_code: 'SESSION_REQUIRED' })
    return { ok: false as const, toolId: canonicalId, error: { code: 'SESSION_REQUIRED', message: 'An owned session is required for tool execution' } }
  }
  const persistedSession = await createProjectSessionRepository(client).getSessionById(sessionId)
  if (!persistedSession || persistedSession.userId !== userId) {
    await writeAudit(client, { user_id: userId, session_id: sessionId, tool_id: canonicalId, input, status: 'denied', error_code: 'SESSION_NOT_FOUND' })
    return { ok: false as const, toolId: canonicalId, error: { code: 'SESSION_NOT_FOUND', message: 'The session is not owned by the requesting user' } }
  }
  const tool = await getTool(client, canonicalId)
  if (!tool) {
    await writeAudit(client, { user_id: userId, session_id: sessionId, tool_id: canonicalId, input, status: 'error', error_code: 'UNKNOWN_TOOL' })
    return { ok: false as const, toolId: canonicalId, error: { code: 'UNKNOWN_TOOL', message: 'Tool does not exist or is disabled' } }
  }

  const agent = agentName === 'master'
    ? await findAgent(client, userId, agentName) ?? await ensureUserDefaults(client, userId)
    : await findAgent(client, userId, agentName)
  if (!agent || !agent.enabled) {
    await writeAudit(client, { user_id: userId, session_id: sessionId, tool_id: canonicalId, input, status: 'denied', error_code: 'UNKNOWN_AGENT' })
    return { ok: false as const, toolId: canonicalId, error: { code: 'UNKNOWN_AGENT', message: 'Agent is disabled or does not exist' } }
  }
  const effective = effectiveAgentConfiguration(agent, persistedSession.projectId ? String(persistedSession.projectId) : undefined)
  const validationError = requiredInputError(tool.input_schema, input)
  if (validationError) {
    await writeAudit(client, { user_id: userId, agent_id: agent.id, session_id: sessionId, tool_id: canonicalId, input, status: 'error', error_code: 'VALIDATION_FAILED' })
    return { ok: false as const, toolId: canonicalId, error: { code: 'VALIDATION_FAILED', message: validationError } }
  }

  const policies = await client.collection('agent_tool_policies').getFullList({ filter: `user_id = "${escapeFilter(userId)}" && agent_id = "${escapeFilter(agent.id)}"` })
  const matching = policies.filter((item) => item.tool_id === canonicalId || item.tool_id === '*')
  const mode = toolContextMode(effective, canonicalId)
  if (mode === 'disabled' || matching.some((item) => item.effect === 'deny') || override === 'none' || effective.approval_mode === 'deny') {
    await writeAudit(client, { user_id: userId, agent_id: agent.id, session_id: sessionId, tool_id: canonicalId, input, status: 'denied', error_code: 'PERMISSION_DENIED' })
    return { ok: false as const, toolId: canonicalId, error: { code: 'PERMISSION_DENIED', message: `Agent is not allowed to use ${canonicalId}` } }
  }

  const needsApproval = effective.approval_mode === 'ask' || override === 'ask' || (override !== 'allow_all' && (tool.requires_approval || matching.some((item) => item.effect === 'approval')))
  if (needsApproval) {
    const created = await createApprovalFlow(client).create({ userId, agentId: agent.id, sessionId, toolId: canonicalId, input, reason: `${canonicalId} requires approval` })
    retainPendingApprovalInput(created.approval.id, input)
    const approval: Approval = {
      id: created.approval.id,
      user_id: created.approval.user_id,
      agent_id: created.approval.agent_id,
      session_id: created.approval.session_id,
      tool_id: created.approval.tool_id,
      input: created.approval.input,
      status: created.approval.status,
      reason: created.approval.reason,
      created_at: created.approval.created_at,
      resolved_at: created.approval.resolved_at,
    }
    await writeAudit(client, { user_id: userId, agent_id: agent.id, session_id: sessionId, tool_id: canonicalId, input, status: 'approval_required', approval_id: approval.id })
    await options.onApproval?.(approval)
    if (canonicalId === 'subagent/run' && subagentToolRunner) {
      const task = await subagentToolRunner({ ...recordObject(input), approvalId: approval.id }, { userId, agentName, sessionId, cwd: options.cwd, callId: options.callId, permissionOverride: override, capabilities: options.capabilities })
      return { ok: false as const, toolId: canonicalId, approvalRequired: true, approvalId: approval.id, message: approval.reason, task } as never
    }
    // Approval is now resumable. Never hold a model or HTTP request open while
    // polling PocketBase; callers continue it through continueApprovedTool().
    return { ok: false as const, toolId: canonicalId, approvalRequired: true, approvalId: approval.id, message: approval.reason }
  }

  const explicitlyAllowed = matching.some((item) => item.effect === 'allow' || item.effect === 'approval')
  if (override !== 'allow_all' && !explicitlyAllowed && agent.name !== 'master' && !matching.some((item) => item.tool_id === generatedSkillName(canonicalId))) {
    await writeAudit(client, { user_id: userId, agent_id: agent.id, session_id: sessionId, tool_id: canonicalId, input, status: 'denied', error_code: 'PERMISSION_DENIED' })
    return { ok: false as const, toolId: canonicalId, error: { code: 'PERMISSION_DENIED', message: `Agent is not allowed to use ${canonicalId}` } }
  }

  try {
    const result = await invokeExternalTool(tool, input, options.cwd ?? process.cwd(), options.callId ?? crypto.randomUUID(), { userId, agentName, sessionId, permissionOverride: override, capabilities: options.capabilities })
    await writeAudit(client, { user_id: userId, agent_id: agent.id, session_id: sessionId, tool_id: canonicalId, input, status: 'success', result_summary: `Executed ${tool.adapter} tool` })
    return { ok: true as const, toolId: canonicalId, result }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Tool execution failed'
    await writeAudit(client, { user_id: userId, agent_id: agent.id, session_id: sessionId, tool_id: canonicalId, input, status: 'error', error_code: 'TOOL_EXECUTION_FAILED', error_message: message })
    return { ok: false as const, toolId: canonicalId, error: { code: 'TOOL_EXECUTION_FAILED', message: redactSensitiveText(message) } }
  }
}

function shortDescription(description: string): string {
  const short = description.trim().split(/(?<=[.!?])\s+/)[0] ?? description.trim()
  return short.length > 120 ? `${short.slice(0, 117).trimEnd()}...` : short
}

function toolUsage(tool: ToolDefinition): string {
  const properties = Object.keys(recordObject(tool.input_schema.properties))
  const args = properties.slice(0, 4).map((name) => `${name}: ...`).join(', ')
  if (tool.namespace === 'builtin') return `${tool.tool_id}({${args}})`
  return `subpolar-tools({action: "call", toolId: "${tool.tool_id}", input: {${args}}})`
}

export async function searchToolsForAgent(client: PocketBase, userId: string, agentName: string, query: string): Promise<Array<{ tool: string; description: string; usage: string }>> {
  const normalized = query.trim().toLocaleLowerCase()
  if (!normalized) throw new Error('A non-empty query is required')
  const visible = await listToolsForAgent(client, userId, agentName)
  const records = await client.collection('tool_registry').getFullList({ filter: 'enabled = true' })
  const definitions = new Map(records.map((record) => [canonicalToolId(String(record.tool_id), String(record.adapter) as ToolAdapter, String(record.namespace ?? '')), toTool(record)]))
  return visible
    .map((item) => definitions.get(item.id))
    .filter((tool): tool is ToolDefinition => Boolean(tool))
    .map((tool) => {
      const haystack = `${tool.tool_id} ${tool.namespace} ${tool.operation} ${tool.description}`.toLocaleLowerCase()
      const terms = normalized.split(/\s+/).filter(Boolean)
      const score = terms.reduce((total, term) => total + (haystack.includes(term) ? (tool.tool_id.toLocaleLowerCase().includes(term) ? 3 : 1) : 0), 0)
      return { tool, score }
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.tool.tool_id.localeCompare(b.tool.tool_id))
    .slice(0, 12)
    .map(({ tool }) => ({ tool: tool.tool_id, description: shortDescription(tool.description), usage: toolUsage(tool) }))
}

export async function continueApprovedTool(client: PocketBase, userId: string, approvalId: string, options: { sessionId?: string; cwd?: string; callId?: string } = {}) {
  if (!options.sessionId?.trim()) return { ok: false as const, error: { code: 'SESSION_REQUIRED', message: 'An owned session is required for tool execution' } }
  const repository = createProjectSessionRepository(client)
  const context = await repository.getSessionContext(userId, options.sessionId)
  if (!context) return { ok: false as const, error: { code: 'SESSION_NOT_FOUND', message: 'The session is not owned by the requesting user or its project context is invalid' } }
  const flow = createApprovalFlow(client)
  let continued
  try {
    continued = await flow.continue({ userId, sessionId: options.sessionId }, approvalId, async (approval) => {
      const executableInput = takePendingApprovalInput(approval.id)
      if (executableInput === undefined) return { ok: false as const, toolId: approval.tool_id, error: { code: 'APPROVAL_INTERRUPTED', message: 'Approval input is unavailable; it cannot be resumed after a restart' } }
      const current = await repository.getSessionContext(userId, options.sessionId!)
      if (!current) return { ok: false as const, toolId: approval.tool_id, error: { code: 'APPROVAL_INTERRUPTED', message: 'The persisted session or project context changed; create a new approval' } }
      return executeApprovedTool(client, userId, approval, executableInput, current, options.callId ?? crypto.randomUUID())
    })
  } catch (error) {
    return { ok: false as const, error: { code: 'APPROVAL_INTERRUPTED', message: redactSensitiveText(error instanceof Error ? error.message : 'Approval continuation failed') } }
  }
  if (!continued.ok) return { ok: false as const, error: continued.error }
  if (continued.state === 'pending') return { ok: false as const, toolId: continued.approval.tool_id, approvalRequired: true, approvalId: continued.approval.id, message: continued.approval.reason }
  if (continued.state === 'rejected' || continued.state === 'expired') {
    discardPendingApprovalInput(continued.approval.id)
    return { ok: false as const, toolId: continued.approval.tool_id, error: { code: 'APPROVAL_REJECTED', message: `Approval ${continued.state}` } }
  }
  if (continued.state === 'approved') return { ok: false as const, toolId: continued.approval.tool_id, approvalRequired: true, approvalId: continued.approval.id, message: 'Approval granted; continue execution' }
  if (continued.state !== 'continued') return { ok: false as const, error: { code: 'APPROVAL_INVALID_STATE', message: 'Approval is not ready to continue' } }
  return continued.result
}

async function executeApprovedTool(
  client: PocketBase,
  userId: string,
  approval: ApprovalFlowApproval,
  input: unknown,
  context: SessionContext,
  callId: string,
) {
  const session = context.session
  const toolId = canonicalToolId(approval.tool_id)
  const tool = await getTool(client, toolId)
  if (!tool) return { ok: false as const, toolId, error: { code: 'UNKNOWN_TOOL', message: 'Tool does not exist or is disabled' } }
  const agent = await findAgent(client, userId, session.profile?.trim() || approval.agent_id)
  if (!agent || !agent.enabled || agent.id !== approval.agent_id) {
    await writeAudit(client, { user_id: userId, agent_id: approval.agent_id, session_id: session.id, tool_id: toolId, input, status: 'denied', error_code: 'PERMISSION_DENIED' })
    return { ok: false as const, toolId, error: { code: 'PERMISSION_DENIED', message: 'The approved agent or session policy has changed' } }
  }
  if (tool.tool_id !== toolId) return { ok: false as const, toolId, error: { code: 'UNKNOWN_TOOL', message: 'Approved tool no longer matches the registered tool' } }
  const validationError = requiredInputError(tool.input_schema, input)
  if (validationError) return { ok: false as const, toolId, error: { code: 'VALIDATION_FAILED', message: validationError } }
  const policies = await client.collection('agent_tool_policies').getFullList({ filter: `user_id = "${escapeFilter(userId)}" && agent_id = "${escapeFilter(agent.id)}"` })
  const matching = policies.filter((item) => item.tool_id === toolId || item.tool_id === '*')
  const explicitlyAllowed = matching.some((item) => item.effect === 'allow' || item.effect === 'approval')
  if (session.permissionOverride === 'none' || matching.some((item) => item.effect === 'deny')
    || (agent.name !== 'master' && !explicitlyAllowed && !matching.some((item) => item.tool_id === generatedSkillName(toolId)))) {
    await writeAudit(client, { user_id: userId, agent_id: agent.id, session_id: session.id, tool_id: toolId, input, status: 'denied', error_code: 'PERMISSION_DENIED' })
    return { ok: false as const, toolId, error: { code: 'PERMISSION_DENIED', message: 'Current permission policy does not allow the approved tool' } }
  }
  const cwd = session.directory ? assertPathWithinWorkspace(session.directory) : context.project?.path ?? configuredWorkspaceRoot()
  try {
    const resumedInput = toolId === 'subagent/run' ? { ...recordObject(input), approvalId: approval.id } : input
    const requestedCapabilities = recordObject(input).capabilities
    const result = await invokeExternalTool(tool, resumedInput, cwd, callId, {
      userId,
      agentName: agent.name,
      sessionId: session.id,
      cwd,
      permissionOverride: session.permissionOverride,
      capabilities: Array.isArray(requestedCapabilities) ? requestedCapabilities.filter((value: unknown): value is string => typeof value === 'string') : undefined,
    })
    await writeAudit(client, { user_id: userId, agent_id: agent.id, session_id: session.id, tool_id: toolId, input, status: 'success', result_summary: `Executed ${tool.adapter} tool` })
    return { ok: true as const, toolId, result }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Tool execution failed'
    await writeAudit(client, { user_id: userId, agent_id: agent.id, session_id: session.id, tool_id: toolId, input, status: 'error', error_code: 'TOOL_EXECUTION_FAILED', error_message: message })
    return { ok: false as const, toolId, error: { code: 'TOOL_EXECUTION_FAILED', message: redactSensitiveText(message) } }
  }
}

export function mapPiToolName(toolName: string): string | null {
  return piToolIds[toolName] ?? null
}

export async function authorizePiToolCall(client: PocketBase, input: { userId: string; agentName: string; sessionId: string; toolName: string; input: unknown; permissionOverride?: PermissionOverride }) {
  if (!input.sessionId.trim()) return { ok: false as const, decision: 'deny' as const, message: 'An owned session is required' }
  const session = await createProjectSessionRepository(client).getSessionById(input.sessionId)
  if (!session || session.userId !== input.userId) return { ok: false as const, decision: 'deny' as const, message: 'Session not found' }
  const toolId = mapPiToolName(input.toolName)
  if (!toolId) return { ok: false as const, decision: 'deny' as const, message: `Unknown Pi tool: ${input.toolName}` }
  const result = await callTool(client, input.userId, input.agentName, toolId, input.input, input.sessionId, input.permissionOverride)
  if (result.ok) return { ok: true as const, decision: 'allow' as const }
  if ('approvalRequired' in result && result.approvalRequired) return { ok: false as const, decision: 'approval' as const, approvalId: result.approvalId, message: result.message }
  return { ok: false as const, decision: 'deny' as const, message: result.error?.message ?? 'Tool call was denied' }
}

export type { PocketBase }
