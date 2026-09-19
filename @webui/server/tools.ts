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
import { createApprovalFlow } from './approval-flow.ts'
import { createMcpAdapter, type McpToolReference } from './mcp-adapter.ts'

export type ToolAdapter = 'internal' | 'http' | 'openapi' | 'mcp'
export type ToolEffect = 'allow' | 'deny' | 'approval'
export type ToolRisk = 'read' | 'write' | 'delete' | 'external'
export type PermissionOverride = 'ask' | 'none' | 'allow_all'

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

const toolSeeds: Array<Omit<ToolDefinition, 'id' | 'created_at' | 'updated_at'>> = [
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
  return {
    id: String(record.id),
    user_id: String(record.user_id),
    name: String(record.name),
    description: String(record.description ?? ''),
    mode: record.mode === 'subagent' ? 'subagent' : 'primary',
    prompt: String(record.prompt ?? ''),
    system_prompt: String(record.systemPrompt ?? record.system_prompt ?? ''),
    enabled: record.enabled !== false,
    created_at: typeof record.created_at === 'number' ? record.created_at : undefined,
    updated_at: typeof record.updated_at === 'number' ? record.updated_at : undefined,
  }
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
    input: record.input,
    status: status === 'approved' || status === 'rejected' || status === 'expired' ? status : 'pending',
    reason: String(record.reason ?? ''),
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

export async function listToolsForAgent(client: PocketBase, userId: string, agentName = 'master'): Promise<Array<{ id: string; description: string; inputSchema: Record<string, unknown>; requiresApproval: boolean }>> {
  const agent = agentName === 'master'
    ? await findAgent(client, userId, agentName) ?? await ensureUserDefaults(client, userId)
    : await findAgent(client, userId, agentName)
  if (!agent || !agent.enabled) return []
  const policies = await client.collection('agent_tool_policies').getFullList({ filter: `user_id = "${escapeFilter(userId)}" && agent_id = "${escapeFilter(agent.id)}"` })
  const policyMap = new Map(policies.map((item) => [String(item.tool_id), String(item.effect) as ToolEffect]))
  const tools = await client.collection('tool_registry').getFullList({ filter: 'enabled = true', sort: 'namespace,tool_id' })
  return tools.flatMap((record) => {
    const tool = toTool(record)
    const effect = policyMap.get(tool.tool_id)
    if (effect === 'deny' || (!effect && !agent.name.startsWith('master'))) return []
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
  await client.collection('tool_call_audit').create({ ...data, created_at: Date.now() })
}


export async function listPendingApprovals(client: PocketBase, userId: string, sessionId?: string): Promise<Approval[]> {
  const filters = [`user_id = "${escapeFilter(userId)}"`, 'status = "pending"']
  if (sessionId) filters.push(`session_id = "${escapeFilter(sessionId)}"`)
  const records = await client.collection('tool_approvals').getFullList({ filter: filters.join(' && '), sort: '-created_at' })
  return records.map(toApproval)
}

export async function respondToApproval(client: PocketBase, userId: string, approvalId: string, approved: boolean): Promise<Approval | null> {
  const existing = await client.collection('tool_approvals').getOne(approvalId).catch(() => null)
  if (!existing || String(existing.user_id) !== userId || String(existing.status) !== 'pending') return null
  return toApproval(await client.collection('tool_approvals').update(approvalId, { status: approved ? 'approved' : 'rejected', resolved_at: Date.now() }))
}



async function invokeInternalTool(tool: ToolDefinition, input: unknown, cwd: string, callId: string): Promise<unknown> {
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

async function invokeExternalTool(tool: ToolDefinition, input: unknown, cwd: string, callId: string): Promise<unknown> {
  if (tool.adapter === 'internal') {
    if (tool.target === 'pi') return invokeInternalTool(tool, input, cwd, callId)
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
  const response = await fetch(requestUrl, {
    method,
    headers: requestHeaders,
    body: method === 'GET' || method === 'HEAD' ? undefined : JSON.stringify(requestBody ?? {}),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`External tool returned HTTP ${response.status}: ${text.slice(0, 500)}`)
  try { return JSON.parse(text) } catch { return text }
}

export async function callTool(client: PocketBase, userId: string, agentName: string, toolId: string, input: unknown, sessionId?: string, override?: PermissionOverride, options: { cwd?: string; callId?: string; waitForApproval?: boolean; onApproval?: (approval: Approval) => void | Promise<void> } = {}) {
  const canonicalId = canonicalToolId(toolId)
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
  const validationError = requiredInputError(tool.input_schema, input)
  if (validationError) {
    await writeAudit(client, { user_id: userId, agent_id: agent.id, session_id: sessionId, tool_id: canonicalId, input, status: 'error', error_code: 'VALIDATION_FAILED' })
    return { ok: false as const, toolId: canonicalId, error: { code: 'VALIDATION_FAILED', message: validationError } }
  }

  const policies = await client.collection('agent_tool_policies').getFullList({ filter: `user_id = "${escapeFilter(userId)}" && agent_id = "${escapeFilter(agent.id)}"` })
  const matching = policies.filter((item) => item.tool_id === canonicalId || item.tool_id === '*')
  if (matching.some((item) => item.effect === 'deny') || override === 'none') {
    await writeAudit(client, { user_id: userId, agent_id: agent.id, session_id: sessionId, tool_id: canonicalId, input, status: 'denied', error_code: 'PERMISSION_DENIED' })
    return { ok: false as const, toolId: canonicalId, error: { code: 'PERMISSION_DENIED', message: `Agent is not allowed to use ${canonicalId}` } }
  }

  const needsApproval = override === 'ask' || (override !== 'allow_all' && (tool.requires_approval || matching.some((item) => item.effect === 'approval')))
  if (needsApproval) {
    const created = await createApprovalFlow(client).create({ userId, agentId: agent.id, sessionId, toolId: canonicalId, input, reason: `${canonicalId} requires approval` })
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
    const result = await invokeExternalTool(tool, input, options.cwd ?? process.cwd(), options.callId ?? crypto.randomUUID())
    await writeAudit(client, { user_id: userId, agent_id: agent.id, session_id: sessionId, tool_id: canonicalId, input, status: 'success', result_summary: `Executed ${tool.adapter} tool` })
    return { ok: true as const, toolId: canonicalId, result }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Tool execution failed'
    await writeAudit(client, { user_id: userId, agent_id: agent.id, session_id: sessionId, tool_id: canonicalId, input, status: 'error', error_code: 'TOOL_EXECUTION_FAILED' })
    return { ok: false as const, toolId: canonicalId, error: { code: 'TOOL_EXECUTION_FAILED', message } }
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
  const flow = createApprovalFlow(client)
  const continued = await flow.continue({ userId, sessionId: options.sessionId }, approvalId, async (approval) => {
    return callTool(client, userId, approval.agent_id, approval.tool_id, approval.input, approval.session_id, 'allow_all', {
      cwd: options.cwd,
      callId: options.callId,
      waitForApproval: false,
    })
  })
  if (!continued.ok) return { ok: false as const, error: continued.error }
  if (continued.state === 'pending') return { ok: false as const, toolId: continued.approval.tool_id, approvalRequired: true, approvalId: continued.approval.id, message: continued.approval.reason }
  if (continued.state === 'rejected' || continued.state === 'expired') return { ok: false as const, toolId: continued.approval.tool_id, error: { code: 'APPROVAL_REJECTED', message: `Approval ${continued.state}` } }
  if (continued.state === 'approved') return { ok: false as const, toolId: continued.approval.tool_id, approvalRequired: true, approvalId: continued.approval.id, message: 'Approval granted; continue execution' }
  if (continued.state !== 'continued') return { ok: false as const, error: { code: 'APPROVAL_INVALID_STATE', message: 'Approval is not ready to continue' } }
  return continued.result
}

export function mapPiToolName(toolName: string): string | null {
  return piToolIds[toolName] ?? null
}

export async function authorizePiToolCall(client: PocketBase, input: { userId: string; agentName: string; sessionId: string; toolName: string; input: unknown; permissionOverride?: PermissionOverride }) {
  const toolId = mapPiToolName(input.toolName)
  if (!toolId) return { ok: false as const, decision: 'deny' as const, message: `Unknown Pi tool: ${input.toolName}` }
  const result = await callTool(client, input.userId, input.agentName, toolId, input.input, input.sessionId, input.permissionOverride)
  if (result.ok) return { ok: true as const, decision: 'allow' as const }
  if ('approvalRequired' in result && result.approvalRequired) return { ok: false as const, decision: 'approval' as const, approvalId: result.approvalId, message: result.message }
  return { ok: false as const, decision: 'deny' as const, message: result.error?.message ?? 'Tool call was denied' }
}

export type { PocketBase }
