import type PocketBase from 'pocketbase'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
} from '@earendil-works/pi-coding-agent'
import { escapeFilter } from '../../persistence/pocketbase.ts'
import { createApprovalFlow } from './approval-flow.ts'
import { createMcpAdapter, type McpToolReference } from './mcp-adapter.ts'
import { fetchWithNetworkPolicy, networkPolicyFromMetadata, readBoundedResponse } from '../../core/network-policy.ts'
import { redactSensitive, redactSensitiveText } from '../../core/security-redaction.ts'
import { decryptApprovalInput, encryptApprovalInput, takePendingApprovalInput } from './approval-execution.ts'
type ToolExecutionContext = {
  userId: string
  agentName: string
  sessionId?: string
  cwd?: string
  callId?: string
  permissionOverride?: PermissionOverride
  capabilities?: readonly string[]
  agentId?: string
  projectId?: string
}
import { PocketBaseMemoryService, type MemoryContext, type MemoryScope } from '../../persistence/memory.ts'
import { BrowserSessionService, BrowserRuntimeError, browserProfileAllows, type BrowserContext } from '../../browser/index.ts'
import { webFetch, webSearch, type WebFetchInput, type WebSearchInput } from './web-search.ts'
import type { SkillRepository } from '../../../../packages/subpolar-contracts/src/index.ts'
import { createGateway as createCoreGateway } from '../../../../packages/subpolar-core/src/index.ts'
import type {
  ApprovalDecision,
  ApprovalRecord as CoreApprovalRecord,
  ApprovalRequest,
  ApprovalStore,
  AuditPort,

  JsonValue,
  PolicyResolver,
  ToolDefinition as CoreToolDefinition,
  ToolExecutor,

} from '../../../../packages/subpolar-contracts/src/index.ts'
import {
  createPocketBaseAdapter,
  createPocketBaseAuditPort,
  createPocketBaseIdempotencyPort,
  type PocketBaseClientPort,
  type PocketBaseStoredRecord,
} from '../../../../packages/subpolar-adapter-pocketbase/src/index.ts'
import type { ToolGateway as CoreToolGateway } from '../../../../packages/subpolar-core/src/index.ts'

export type ToolAdapter = 'internal' | 'http' | 'openapi' | 'mcp'
export type ToolEffect = 'allow' | 'deny' | 'approval'
export type ToolRisk = 'read' | 'write' | 'delete' | 'external'
export type PermissionOverride = 'ask' | 'none' | 'allow_all'
export type ToolContextMode = 'always' | 'discoverable' | 'on-demand' | 'disabled'
export type SkillContextMode = 'always-loaded' | 'discoverable' | 'explicit-only' | 'disabled'
export type AgentApprovalMode = 'auto' | 'ask' | 'deny'

export const TOOL_CONTEXT_MODES: readonly ToolContextMode[] = ['always', 'discoverable', 'on-demand', 'disabled']
export const SKILL_CONTEXT_MODES: readonly SkillContextMode[] = ['always-loaded', 'discoverable', 'explicit-only', 'disabled']

const memoryMutationTools = new Set(['memory/write', 'memory/update', 'memory/delete'])
const profileManagementTools = new Set(['list_agent_profiles', 'create_agent_profile', 'edit_agent_profile', 'delete_agent_profile'])
const toolManagementTools = new Set(['list_registered_tools', 'create_registered_tool', 'update_registered_tool', 'delete_registered_tool'])
const cliManagementTools = new Set(['create_cli_tool'])
const manualApprovalToolTargets = new Set(['cli'])
const execFileAsync = promisify(execFile)
const allowedCliExecutables = new Set(['bun', 'cargo', 'git', 'go', 'node', 'npm', 'pnpm', 'pytest', 'python', 'python3', 'rustc'])
const browserMutationGroups = new Set(['form-interaction', 'upload', 'download', 'submit', 'destructive'])
export function memoryPolicyAllows(agent: { policies: Pick<AgentPolicySet, 'memory'>; template?: AgentDefinition['template'] }, toolId: string): boolean {
  return agent.policies.memory === true && !(memoryMutationTools.has(toolId) && (agent.template === 'plan' || agent.template === 'reviewer'))
}

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
  context_mode?: ToolContextMode
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
  expires_at: number
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
type SubagentToolRunner = (input: unknown, context: ToolExecutionContext) => Promise<unknown>
let subagentToolRunner: SubagentToolRunner | undefined

export function configureSubagentToolRunner(runner: SubagentToolRunner | undefined): void {
  subagentToolRunner = runner
}

const toolSeeds: Array<Omit<ToolDefinition, 'id' | 'created_at' | 'updated_at'>> = [
  { tool_id: 'subagent/run', namespace: 'builtin', description: 'Run an authorized isolated subagent task', adapter: 'internal', target: 'subagent', operation: 'run', input_schema: { type: 'object', properties: { targetAgent: { type: 'string', minLength: 1 }, prompt: { type: 'string', minLength: 1 }, capabilities: { type: 'array', items: { type: 'string' } }, coding: { type: 'boolean' } }, required: ['targetAgent', 'prompt'], additionalProperties: false }, output_schema: { type: 'object' }, risk: 'write', requires_approval: true, enabled: true, metadata: { capability: 'subagent/run' } },
  { tool_id: 'list_agent_profiles', namespace: 'builtin', description: 'List agent profiles owned by the current user', adapter: 'internal', target: 'agent-profiles', operation: 'list', input_schema: { type: 'object', properties: {}, additionalProperties: false }, output_schema: { type: 'array' }, risk: 'read', requires_approval: false, enabled: true, metadata: { capability: 'agent-profiles' } },
  { tool_id: 'create_agent_profile', namespace: 'builtin', description: 'Create an owned agent profile', adapter: 'internal', target: 'agent-profiles', operation: 'create', input_schema: { type: 'object', properties: { name: { type: 'string', minLength: 1, maxLength: 80 }, description: { type: 'string', maxLength: 1000 }, mode: { type: 'string', enum: ['primary', 'subagent'] }, prompt: { type: 'string', maxLength: 100000 }, systemPrompt: { type: 'string', maxLength: 100000 }, enabled: { type: 'boolean' }, template: { type: 'string', enum: ['general', 'coding', 'plan', 'reviewer'] }, model: { type: 'string', maxLength: 200 }, thinking: { type: 'string', enum: ['off', 'minimal', 'low', 'medium', 'high'] }, approval_mode: { type: 'string', enum: ['auto', 'ask', 'deny'] }, policies: { type: 'object' }, project_overrides: { type: 'object' }, tool_context_modes: { type: 'object' }, skill_context_modes: { type: 'object' } }, required: ['name'], additionalProperties: false }, output_schema: { type: 'object' }, risk: 'write', requires_approval: true, enabled: true, metadata: { capability: 'agent-profiles' } },
  { tool_id: 'edit_agent_profile', namespace: 'builtin', description: 'Edit an owned agent profile', adapter: 'internal', target: 'agent-profiles', operation: 'edit', input_schema: { type: 'object', properties: { agentId: { type: 'string', minLength: 1, maxLength: 100 }, name: { type: 'string', minLength: 1, maxLength: 80 }, description: { type: 'string', maxLength: 1000 }, mode: { type: 'string', enum: ['primary', 'subagent'] }, prompt: { type: 'string', maxLength: 100000 }, systemPrompt: { type: 'string', maxLength: 100000 }, enabled: { type: 'boolean' }, template: { type: 'string', enum: ['general', 'coding', 'plan', 'reviewer'] }, model: { type: 'string', maxLength: 200 }, thinking: { type: 'string', enum: ['off', 'minimal', 'low', 'medium', 'high'] }, approval_mode: { type: 'string', enum: ['auto', 'ask', 'deny'] }, policies: { type: 'object' }, project_overrides: { type: 'object' }, tool_context_modes: { type: 'object' }, skill_context_modes: { type: 'object' } }, required: ['agentId'], additionalProperties: false }, output_schema: { type: 'object' }, risk: 'write', requires_approval: true, enabled: true, metadata: { capability: 'agent-profiles' } },
  { tool_id: 'delete_agent_profile', namespace: 'builtin', description: 'Delete an owned agent profile', adapter: 'internal', target: 'agent-profiles', operation: 'delete', input_schema: { type: 'object', properties: { agentId: { type: 'string', minLength: 1, maxLength: 100 } }, required: ['agentId'], additionalProperties: false }, output_schema: { type: 'object' }, risk: 'delete', requires_approval: true, enabled: true, metadata: { capability: 'agent-profiles' } },
  { tool_id: 'list_registered_tools', namespace: 'builtin', description: 'List registered tools owned by the current user', adapter: 'internal', target: 'tool-registry', operation: 'list', input_schema: { type: 'object', properties: {}, additionalProperties: false }, output_schema: { type: 'array' }, risk: 'read', requires_approval: false, enabled: true, metadata: { capability: 'tool-registry' } },
  { tool_id: 'create_registered_tool', namespace: 'builtin', description: 'Register an owned HTTP, OpenAPI, or MCP tool', adapter: 'internal', target: 'tool-registry', operation: 'create', input_schema: { type: 'object', properties: { tool_id: { type: 'string', maxLength: 160 }, namespace: { type: 'string', maxLength: 64 }, description: { type: 'string', maxLength: 1000 }, adapter: { type: 'string', enum: ['http', 'openapi', 'mcp'] }, target: { type: 'string', maxLength: 2000 }, operation: { type: 'string', maxLength: 128 }, input_schema: { type: 'object' }, output_schema: { type: 'object' }, risk: { type: 'string', enum: ['read', 'write', 'delete', 'external'] }, requires_approval: { type: 'boolean' }, enabled: { type: 'boolean' }, context_mode: { type: 'string', enum: ['always', 'discoverable', 'on-demand', 'disabled'] }, metadata: { type: 'object' } }, required: ['tool_id', 'namespace', 'description', 'adapter', 'target', 'operation', 'input_schema', 'output_schema', 'risk'], additionalProperties: false }, output_schema: { type: 'object' }, risk: 'write', requires_approval: true, enabled: true, metadata: { capability: 'tool-registry' } },
  { tool_id: 'update_registered_tool', namespace: 'builtin', description: 'Update an owned registered tool', adapter: 'internal', target: 'tool-registry', operation: 'update', input_schema: { type: 'object', properties: { tool_id: { type: 'string', maxLength: 160 }, description: { type: 'string', maxLength: 1000 }, target: { type: 'string', maxLength: 2000 }, operation: { type: 'string', maxLength: 128 }, input_schema: { type: 'object' }, output_schema: { type: 'object' }, risk: { type: 'string', enum: ['read', 'write', 'delete', 'external'] }, requires_approval: { type: 'boolean' }, enabled: { type: 'boolean' }, context_mode: { type: 'string', enum: ['always', 'discoverable', 'on-demand', 'disabled'] }, metadata: { type: 'object' } }, required: ['tool_id'], additionalProperties: false }, output_schema: { type: 'object' }, risk: 'write', requires_approval: true, enabled: true, metadata: { capability: 'tool-registry' } },
  { tool_id: 'delete_registered_tool', namespace: 'builtin', description: 'Delete an owned registered tool', adapter: 'internal', target: 'tool-registry', operation: 'delete', input_schema: { type: 'object', properties: { tool_id: { type: 'string', minLength: 1, maxLength: 160 } }, required: ['tool_id'], additionalProperties: false }, output_schema: { type: 'object' }, risk: 'delete', requires_approval: true, enabled: true, metadata: { capability: 'tool-registry' } },
  { tool_id: 'create_cli_tool', namespace: 'builtin', description: 'Create an approved workspace-bounded CLI tool', adapter: 'internal', target: 'tool-registry', operation: 'create-cli', input_schema: { type: 'object', properties: { tool_id: { type: 'string', maxLength: 160 }, namespace: { type: 'string', maxLength: 64 }, description: { type: 'string', maxLength: 1000 }, executable: { type: 'string', enum: [...allowedCliExecutables] }, fixed_args: { type: 'array', maxItems: 32, items: { type: 'string', maxLength: 256 } }, max_args: { type: 'integer', minimum: 0, maximum: 32 }, timeout_ms: { type: 'integer', minimum: 100, maximum: 120000 }, max_output_bytes: { type: 'integer', minimum: 1024, maximum: 1048576 } }, required: ['tool_id', 'namespace', 'description', 'executable'], additionalProperties: false }, output_schema: { type: 'object' }, risk: 'write', requires_approval: true, enabled: true, metadata: { capability: 'tool-registry' } },
  { tool_id: 'search-tool', namespace: 'builtin', description: 'Search tools available to the active agent', adapter: 'internal', target: 'tool-router', operation: 'search', input_schema: { type: 'object', properties: { query: { type: 'string', minLength: 1 } }, required: ['query'], additionalProperties: false }, output_schema: { type: 'array' }, risk: 'read', requires_approval: false, enabled: true, metadata: {} },
  { tool_id: 'web.search', namespace: 'builtin', description: 'Search the public web using the configured search provider', adapter: 'internal', target: 'web', operation: 'search', input_schema: { type: 'object', properties: { query: { type: 'string', minLength: 1, maxLength: 1000 }, resultCount: { type: 'integer', minimum: 1, maximum: 10 }, contextSize: { type: 'integer', minimum: 1, maximum: 32000 } }, required: ['query'], additionalProperties: false }, output_schema: { type: 'object', properties: { results: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, url: { type: 'string' }, snippet: { type: 'string' } }, required: ['title', 'url', 'snippet'] } } }, required: ['results'] }, risk: 'external', requires_approval: false, enabled: true, metadata: { capability: 'web' } },
  { tool_id: 'web.fetch', namespace: 'builtin', description: 'Fetch bounded text content from a public web page', adapter: 'internal', target: 'web', operation: 'fetch', input_schema: { type: 'object', properties: { url: { type: 'string', minLength: 1, maxLength: 2048 }, maxCharacters: { type: 'integer', minimum: 1, maximum: 20000 } }, required: ['url'], additionalProperties: false }, output_schema: { type: 'object', properties: { url: { type: 'string' }, title: { type: 'string' }, content: { type: 'string' } }, required: ['url', 'title', 'content'] }, risk: 'external', requires_approval: true, enabled: true, metadata: { capability: 'web' } },
  { tool_id: 'read', namespace: 'builtin', description: 'Read files from the selected project', adapter: 'internal', target: 'pi', operation: 'read', input_schema: { type: 'object', properties: { path: { type: 'string' }, offset: { type: 'number' }, limit: { type: 'number' } }, required: ['path'], additionalProperties: false }, output_schema: { type: 'object' }, risk: 'read', requires_approval: false, enabled: true, metadata: {} },
  { tool_id: 'grep', namespace: 'builtin', description: 'Search file contents in the selected project', adapter: 'internal', target: 'pi', operation: 'grep', input_schema: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' }, glob: { type: 'string' }, ignoreCase: { type: 'boolean' }, literal: { type: 'boolean' }, context: { type: 'number' }, limit: { type: 'number' } }, required: ['pattern'], additionalProperties: false }, output_schema: { type: 'object' }, risk: 'read', requires_approval: false, enabled: true, metadata: {} },
  { tool_id: 'find', namespace: 'builtin', description: 'Find files in the selected project', adapter: 'internal', target: 'pi', operation: 'find', input_schema: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' }, limit: { type: 'number' } }, required: ['pattern'], additionalProperties: false }, output_schema: { type: 'object' }, risk: 'read', requires_approval: false, enabled: true, metadata: {} },
  { tool_id: 'ls', namespace: 'builtin', description: 'List files in the selected project', adapter: 'internal', target: 'pi', operation: 'ls', input_schema: { type: 'object', properties: { path: { type: 'string' }, limit: { type: 'number' } }, additionalProperties: false }, output_schema: { type: 'object' }, risk: 'read', requires_approval: false, enabled: true, metadata: {} },
  { tool_id: 'write', namespace: 'builtin', description: 'Write files in the selected project', adapter: 'internal', target: 'pi', operation: 'write', input_schema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'], additionalProperties: false }, output_schema: { type: 'object' }, risk: 'write', requires_approval: true, enabled: true, metadata: {} },
  { tool_id: 'edit', namespace: 'builtin', description: 'Edit files in the selected project', adapter: 'internal', target: 'pi', operation: 'edit', input_schema: { type: 'object', properties: { path: { type: 'string' }, edits: { type: 'array' } }, required: ['path', 'edits'], additionalProperties: false }, output_schema: { type: 'object' }, risk: 'write', requires_approval: true, enabled: true, metadata: {} },
  { tool_id: 'bash', namespace: 'builtin', description: 'Execute commands in the selected project', adapter: 'internal', target: 'pi', operation: 'bash', input_schema: { type: 'object', properties: { command: { type: 'string' }, timeout: { type: 'number' } }, required: ['command'], additionalProperties: false }, output_schema: { type: 'object' }, risk: 'external', requires_approval: true, enabled: true, metadata: {} },
  { tool_id: 'memory/query', namespace: 'builtin', description: 'Query explicitly requested scoped memory; results are never injected automatically', adapter: 'internal', target: 'memory', operation: 'query', input_schema: { type: 'object', properties: { scope: { type: 'string', enum: ['user', 'agent', 'project'] }, query: { type: 'string' }, limit: { type: 'number' } }, additionalProperties: false }, output_schema: { type: 'array' }, risk: 'read', requires_approval: false, enabled: true, metadata: { capability: 'memory/query' } },
  { tool_id: 'memory/write', namespace: 'builtin', description: 'Write an explicitly scoped memory record', adapter: 'internal', target: 'memory', operation: 'write', input_schema: { type: 'object', properties: { scope: { type: 'string', enum: ['user', 'agent', 'project'] }, content: { type: 'string' }, metadata: { type: 'object' }, idempotencyKey: { type: 'string' } }, required: ['scope', 'content'], additionalProperties: false }, output_schema: { type: 'object' }, risk: 'write', requires_approval: true, enabled: true, metadata: { capability: 'memory/write' } },
  { tool_id: 'memory/update', namespace: 'builtin', description: 'Update an explicitly scoped memory record by version', adapter: 'internal', target: 'memory', operation: 'update', input_schema: { type: 'object', properties: { id: { type: 'string' }, content: { type: 'string' }, metadata: { type: 'object' }, version: { type: 'number' } }, required: ['id', 'version'], additionalProperties: false }, output_schema: { type: 'object' }, risk: 'write', requires_approval: true, enabled: true, metadata: { capability: 'memory/update' } },
  { tool_id: 'memory/delete', namespace: 'builtin', description: 'Tombstone an explicitly scoped memory record by version', adapter: 'internal', target: 'memory', operation: 'delete', input_schema: { type: 'object', properties: { id: { type: 'string' }, version: { type: 'number' } }, required: ['id', 'version'], additionalProperties: false }, output_schema: { type: 'object' }, risk: 'delete', requires_approval: true, enabled: true, metadata: { capability: 'memory/delete' } },
  ...(['open', 'navigate', 'back', 'forward', 'tabs', 'read', 'find', 'screenshot', 'wait'] as const).map((operation) => ({ tool_id: `browser/${operation}`, namespace: 'builtin', description: `Browser ${operation} capability (read/navigation only)`, adapter: 'internal' as const, target: 'browser', operation, input_schema: { type: 'object', properties: { browserSessionId: { type: 'string', minLength: 1 }, url: { type: 'string' }, tabId: { type: 'string' }, query: { type: 'string' }, milliseconds: { type: 'number' } }, required: ['browserSessionId'], additionalProperties: false }, output_schema: { type: 'object' }, risk: 'read' as const, requires_approval: false, enabled: true, metadata: { policyGroup: operation === 'open' || operation === 'navigate' || operation === 'back' || operation === 'forward' ? 'navigation' : 'read' } })),
]

function recordObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function toTool(value: unknown): ToolDefinition {
  const record = recordObject(value)
  const adapter = String(record.adapter)
  const risk = String(record.risk)
  const metadata = redactToolMetadata(recordObject(record.metadata))
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
    metadata,
    context_mode: validToolContextMode(record.context_mode) ?? validToolContextMode(metadata.contextMode) ?? 'discoverable',
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
  const tool_context_modes: Record<string, ToolContextMode> = { read: 'always', grep: 'always', find: 'always', ls: 'always', 'search-tool': 'discoverable', 'web.search': 'always', 'web.fetch': 'always' }
  if (!template || !readOnly) Object.assign(tool_context_modes, { write: 'always', edit: 'always', bash: 'always' })
  else Object.assign(tool_context_modes, { write: 'disabled', edit: 'disabled', bash: 'disabled' })
  if (template === 'plan' || template === 'reviewer') tool_context_modes['memory/query'] = 'discoverable'
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
    expires_at: typeof record.expires_at === 'number' ? record.expires_at : Number(record.created_at ?? Date.now()) + 5 * 60 * 1000,
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

function memoryContext(context: ToolExecutionContext, agentId: string, projectId?: string): MemoryContext {
  return { ownerId: context.userId, agentId, ...(projectId ? { projectId } : {}) }
}

const migrationToolIds: Record<string, string> = {
  'web-search': 'web.search',
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
  if (adapter && adapter !== 'internal' && namespace && !toolId.includes('/')) {
    const operation = toolId.includes('.') ? toolId.slice(toolId.lastIndexOf('.') + 1) : toolId
    return `${namespace}/${operation}`
  }
  return toolId
}

export function requiresManualApproval(toolId: string, target: string): boolean {
  return manualApprovalToolTargets.has(target) || toolManagementTools.has(toolId) || cliManagementTools.has(toolId)
}

const registryName = /^[a-z][a-z0-9._-]{0,63}$/
const registryOperation = /^[a-z][a-z0-9._:-]{0,127}$/
const registryAdapters = new Set<ToolAdapter>(['internal', 'http', 'openapi', 'mcp'])
const registryRisks = new Set<ToolRisk>(['read', 'write', 'delete', 'external'])

function validToolContextMode(value: unknown): ToolContextMode | undefined {
  return TOOL_CONTEXT_MODES.includes(value as ToolContextMode) ? value as ToolContextMode : undefined
}

function validSchema(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be a JSON object`)
  const schema = value as Record<string, unknown>
  if (JSON.stringify(schema).length > 1 * 1024 * 1024) throw new Error(`${label} exceeds the configured size limit`)
  return schema
}

function redactToolMetadata(value: Record<string, unknown>): Record<string, unknown> {
  const headers = recordObject(value.headers)
  const safeHeaders = Object.fromEntries(Object.entries(headers).map(([name, header]) => [
    name,
    /authorization|cookie|token|secret|password|api[-_]?key|credential/i.test(name) ? '[REDACTED]' : header,
  ]))
  return redactSensitive({ ...value, ...(Object.keys(headers).length ? { headers: safeHeaders } : {}) }) as Record<string, unknown>
}

export function validateToolDefinition(definition: Omit<ToolDefinition, 'id' | 'created_at' | 'updated_at'>): Omit<ToolDefinition, 'id' | 'created_at' | 'updated_at'> {
  if (!registryAdapters.has(definition.adapter)) throw new Error(`Unsupported tool adapter: ${String(definition.adapter)}`)
  if (!registryRisks.has(definition.risk)) throw new Error(`Unsupported tool risk: ${String(definition.risk)}`)
  if (!registryName.test(definition.namespace)) throw new Error('Tool namespace is malformed')
  if (!registryOperation.test(definition.operation)) throw new Error('Tool operation is malformed')
  const tool_id = canonicalToolId(definition.tool_id, definition.adapter, definition.namespace)
  if (definition.adapter !== 'internal' && tool_id !== `${definition.namespace}/${definition.operation}`) throw new Error('Tool ID must be namespace/operation')
  if (definition.adapter === 'internal' && !tool_id) throw new Error('Tool ID is required')
  if (definition.adapter !== 'internal' && !/^https?:\/\//i.test(definition.target) && definition.adapter !== 'mcp') throw new Error('HTTP tools require an HTTP(S) target')
  if (!definition.target.trim()) throw new Error('Tool target is required')
  return {
    ...definition,
    tool_id,
    input_schema: validSchema(definition.input_schema, 'Input schema'),
    output_schema: validSchema(definition.output_schema, 'Output schema'),
    context_mode: validToolContextMode(definition.context_mode) ?? 'discoverable',
    metadata: redactToolMetadata(definition.metadata),
  }
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

function migrateToolId(toolId: string, adapter?: ToolAdapter, namespace?: string): string {
  return canonicalToolId(migrationToolIds[toolId] ?? toolId, adapter, namespace)
}

export async function ensureToolRegistry(client: PocketBase): Promise<void> {
  const existingTools = await client.collection('tool_registry').getFullList()
  for (const record of existingTools) {
    const oldId = String(record.tool_id ?? '')
    const nextId = migrateToolId(oldId, String(record.adapter) as ToolAdapter, String(record.namespace ?? ''))
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
  let validated: Omit<ToolDefinition, 'id' | 'created_at' | 'updated_at'>
  try {
    validated = validateToolDefinition(definition)
  } catch (error) {
    await writeAudit(client, { user_id: 'system', tool_id: String(definition.tool_id), status: 'error', error_code: 'REGISTRATION_REJECTED', error_message: redactSensitiveText(error instanceof Error ? error.message : 'Tool registration rejected') })
    throw error
  }
  const data = { ...validated, tool_id: validated.tool_id, updated_at: Date.now(), metadata: { ...validated.metadata, contextMode: validated.context_mode } }
  const existing = await client.collection('tool_registry').getFirstListItem(`tool_id = "${escapeFilter(validated.tool_id)}"`).catch(() => null)
  const record = existing
    ? await client.collection('tool_registry').update(existing.id, data)
    : await client.collection('tool_registry').create({ ...data, created_at: Date.now() })
  const result = toTool(record)
  await writeAudit(client, { user_id: 'system', tool_id: result.tool_id, status: 'success', result_summary: `Registered ${result.adapter} tool` })
  return result
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
  if (agent.name === 'master') {
    const legacyWebSearchPolicy = policies.find((policy) => policy.tool_id === 'web.search' && policy.effect === 'approval')
    if (legacyWebSearchPolicy) {
      await client.collection('agent_tool_policies').update(legacyWebSearchPolicy.id, { effect: 'allow', updated_at: now })
    }
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
  const skills = { ...agent.skill_context_modes }
  const skillOrder = { disabled: 0, 'explicit-only': 1, discoverable: 2, 'always-loaded': 3 }
  for (const [id, mode] of Object.entries(override.skills ?? {})) {
    const current = skills[id] ?? 'always-loaded'
    skills[id] = skillOrder[mode] < skillOrder[current] ? mode : current
  }
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

export type SkillRuntimeContext = {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly metadata: Record<string, string>
  readonly mode: SkillContextMode
  readonly body: string
  readonly reference?: string
  readonly scope: 'global' | 'agent' | 'project'
  readonly version: number
}

export function renderSkillRuntimeContext(skills: readonly SkillRuntimeContext[]): string {
  const metadata = skills.filter((skill) => !skill.body).map((skill) => `- ${skill.name}: ${skill.description}`).join('\n')
  const bodies = skills.filter((skill) => skill.body).map((skill) => `### ${skill.name}\n\n${skill.body}`).join('\n\n')
  return [metadata ? `## Available skills\n${metadata}` : '', bodies ? `## Loaded skills\n${bodies}` : ''].filter(Boolean).join('\n\n')
}

export type SkillContextAudit = (event: {
  action: 'discovery' | 'load'
  ownerId: string
  agentId: string
  projectId?: string
  skillId: string
  mode: SkillContextMode
}) => Promise<void> | void

export function createSkillContextAudit(client: PocketBase): SkillContextAudit {
  return async (event) => {
    await client.collection('tool_call_audit').create({
      user_id: event.ownerId,
      action: `skill.${event.action}`,
      skill_id: event.skillId,
      agent_id: event.agentId,
      ...(event.projectId ? { project_id: event.projectId } : {}),
      mode: event.mode,
      status: 'success',
      result_summary: `Skill ${event.action}: ${event.skillId}`,
      created_at: Date.now(),
    })
  }
}

const skillModeRank: Record<SkillContextMode, number> = { disabled: 0, 'explicit-only': 1, discoverable: 2, 'always-loaded': 3 }

function restrictSkillMode(repositoryMode: SkillContextMode, configuredMode?: SkillContextMode): SkillContextMode {
  if (!configuredMode) return repositoryMode
  return skillModeRank[configuredMode] < skillModeRank[repositoryMode] ? configuredMode : repositoryMode
}

/** Resolves durable skills for one authenticated runtime without exposing raw records. */
export async function resolveSkillRuntimeContext(
  repository: SkillRepository,
  ownerId: string,
  agent: AgentDefinition,
  options: { projectId?: string; explicitSkillIds?: readonly string[]; audit?: SkillContextAudit } = {},
): Promise<readonly SkillRuntimeContext[]> {
  const effective = await repository.resolve(ownerId, {
    agentId: agent.id,
    ...(options.projectId ? { projectId: options.projectId } : {}),
    explicitSkillIds: options.explicitSkillIds,
  })
  const explicit = new Set(options.explicitSkillIds ?? [])
  const result: SkillRuntimeContext[] = []
  for (const skill of effective) {
    const mode = restrictSkillMode(skill.exposure, agent.skill_context_modes[skill.id])
    if (mode === 'disabled' || (mode === 'explicit-only' && !explicit.has(skill.id))) continue
    const body = mode === 'always-loaded' || explicit.has(skill.id) ? skill.body : ''
    const context: SkillRuntimeContext = {
      id: skill.id,
      name: skill.name,
      description: skill.metadata.description ?? skill.name,
      metadata: { ...skill.metadata },
      mode,
      body,
      ...(skill.reference ? { reference: skill.reference } : {}),
      scope: skill.scope,
      version: skill.version,
    }
    await options.audit?.({ action: body ? 'load' : 'discovery', ownerId, agentId: agent.id, ...(options.projectId ? { projectId: options.projectId } : {}), skillId: skill.id, mode })
    result.push(context)
  }
  return result
}

function toolContextMode(agent: AgentDefinition, toolId: string): ToolContextMode {
  // Keep the provider-neutral web capabilities available to existing profiles
  // created before these tools were added; an explicit profile mode still wins.
  if (agent.tool_context_modes[toolId]) return agent.tool_context_modes[toolId]
  if (toolId === 'web.search' || toolId === 'web.fetch') return 'always'
  // Records created before context modes existed retain their policy behavior.
  // New templates remain fail-closed for IDs not explicitly configured.
  return agent.template ? 'disabled' : 'always'
}

export async function listToolsForAgent(client: PocketBase, userId: string, agentName = 'master', projectId?: string): Promise<Array<{ id: string; description: string; inputSchema: Record<string, unknown>; requiresApproval: boolean; contextMode: ToolContextMode }>> {
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
    if (tool.tool_id.startsWith('memory/') && !memoryPolicyAllows(agent, tool.tool_id)) return []
    if (tool.tool_id.startsWith('browser/') && agent.policies.browser !== true) return []
    const contextMode = toolContextMode(agent, tool.tool_id)
    const effect = policyMap.get(tool.tool_id)
    if (contextMode === 'disabled' || contextMode === 'on-demand' || effect === 'deny' || (!effect && !agent.name.startsWith('master'))) return []
    return [{ id: tool.tool_id, description: tool.description, inputSchema: tool.input_schema, requiresApproval: tool.requires_approval || effect === 'approval', contextMode: tool.context_mode ?? contextMode }]
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


async function writeAudit(client: PocketBase, data: Record<string, unknown>): Promise<void> {
  const memoryAudit = typeof data.tool_id === 'string' && data.tool_id.startsWith('memory/')
    ? { ...data, input: { ...recordObject(data.input), ...(recordObject(data.input).content !== undefined ? { content: '[REDACTED]' } : {}) } }
    : data
  const safe = redactSensitive(memoryAudit)
  await client.collection('tool_call_audit').create({ ...(safe && typeof safe === 'object' && !Array.isArray(safe) ? safe : {}), created_at: Date.now() })
}



function profileProjection(record: Record<string, unknown>): Record<string, unknown> {
  return {
    id: record.id,
    user_id: record.user_id,
    name: record.name,
    description: record.description ?? '',
    mode: record.mode ?? 'primary',
    prompt: record.prompt ?? '',
    system_prompt: record.system_prompt ?? record.systemPrompt ?? '',
    enabled: record.enabled !== false,
    ...(record.template ? { template: record.template } : {}),
    ...(record.model ? { model: record.model } : {}),
    ...(record.thinking ? { thinking: record.thinking } : {}),
    ...(record.approval_mode ? { approval_mode: record.approval_mode } : {}),
    ...(record.policies ? { policies: record.policies } : {}),
    ...(record.project_overrides ? { project_overrides: record.project_overrides } : {}),
    ...(record.tool_context_modes ? { tool_context_modes: record.tool_context_modes } : {}),
    ...(record.skill_context_modes ? { skill_context_modes: record.skill_context_modes } : {}),
    created_at: record.created_at,
    updated_at: record.updated_at,
  }
}

function profileFields(input: Record<string, unknown>, partial: boolean): Record<string, unknown> {
  const name = typeof input.name === 'string' ? input.name.trim() : undefined
  if (!partial && (!name || !/^[a-zA-Z0-9_-]+$/.test(name))) throw new Error('A valid agent profile name is required')
  if (partial && name !== undefined && (!name || !/^[a-zA-Z0-9_-]+$/.test(name))) throw new Error('A valid agent profile name is required')
  const fields: Record<string, unknown> = {}
  if (name !== undefined) fields.name = name
  for (const key of ['description', 'prompt', 'system_prompt', 'model'] as const) {
    const value = input[key] ?? (key === 'system_prompt' ? input.systemPrompt : undefined)
    if (value !== undefined) {
      if (typeof value !== 'string') throw new Error(`Agent profile ${key} must be text`)
      fields[key] = value
    }
  }
  if (typeof input.mode === 'string' && (input.mode === 'primary' || input.mode === 'subagent')) fields.mode = input.mode
  if (typeof input.enabled === 'boolean') fields.enabled = input.enabled
  if (typeof input.template === 'string' && ['general', 'coding', 'plan', 'reviewer'].includes(input.template)) fields.template = input.template
  if (typeof input.thinking === 'string' && ['off', 'minimal', 'low', 'medium', 'high'].includes(input.thinking)) fields.thinking = input.thinking
  if (typeof input.approval_mode === 'string' && ['auto', 'ask', 'deny'].includes(input.approval_mode)) fields.approval_mode = input.approval_mode
  for (const key of ['policies', 'project_overrides', 'tool_context_modes', 'skill_context_modes'] as const) {
    if (input[key] !== undefined) {
      if (!input[key] || typeof input[key] !== 'object' || Array.isArray(input[key])) throw new Error(`Agent profile ${key} must be an object`)
      fields[key] = input[key]
    }
  }
  return fields
}

export async function manageAgentProfile(client: PocketBase, operation: string, input: unknown, userId: string): Promise<unknown> {
  const args = recordObject(input)
  if (operation === 'list') {
    const agents = await listAgents(client, userId)
    return agents.map((agent) => profileProjection(agent as unknown as Record<string, unknown>))
  }
  const agentId = typeof args.agentId === 'string' ? args.agentId.trim() : ''
  if (operation === 'delete') {
    if (!agentId) throw new Error('agentId is required')
    const existing = await client.collection('agents').getOne(agentId).catch(() => null)
    if (!existing || existing.user_id !== userId) throw new Error('Agent profile not found')
    if (existing.name === 'master') throw new Error('The master profile cannot be deleted')
    await client.collection('agents').delete(agentId)
    return { deleted: true, agentId }
  }
  if (operation === 'edit') {
    if (!agentId) throw new Error('agentId is required')
    const existing = await client.collection('agents').getOne(agentId).catch(() => null)
    if (!existing || existing.user_id !== userId) throw new Error('Agent profile not found')
    const update = { ...profileFields(args, true), updated_at: Date.now() }
    const record = await client.collection('agents').update(agentId, update)
    return profileProjection(record)
  }
  const fields = profileFields(args, false)
  const duplicate = await client.collection('agents').getFirstListItem(`user_id = "${escapeFilter(userId)}" && name = "${escapeFilter(String(fields.name))}"`).catch(() => null)
  if (duplicate) throw new Error('An agent profile with this name already exists')
  const now = Date.now()
  const record = await client.collection('agents').create({ user_id: userId, description: '', mode: 'primary', prompt: '', system_prompt: '', enabled: true, ...fields, created_at: now, updated_at: now })
  return profileProjection(record)
}

function registeredToolProjection(record: Record<string, unknown>): ToolDefinition {
  return toTool(record)
}

function safeCliArgument(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 256 && !/[\0\r\n;|&><`$(){}]/.test(value)
}

function cliMetadata(value: unknown): { executable: string; fixedArgs: string[]; maxArgs: number; timeoutMs: number; maxOutputBytes: number } {
  const input = recordObject(value)
  const executable = typeof input.executable === 'string' ? input.executable : ''
  const fixedArgs = Array.isArray(input.fixedArgs) ? input.fixedArgs : []
  const maxArgs = typeof input.maxArgs === 'number' && Number.isInteger(input.maxArgs) ? input.maxArgs : 0
  const timeoutMs = typeof input.timeoutMs === 'number' && Number.isInteger(input.timeoutMs) ? input.timeoutMs : 30_000
  const maxOutputBytes = typeof input.maxOutputBytes === 'number' && Number.isInteger(input.maxOutputBytes) ? input.maxOutputBytes : 256 * 1024
  if (!allowedCliExecutables.has(executable)) throw new Error('CLI executable is not in the approved executable set')
  if (fixedArgs.length > 32 || fixedArgs.some((arg) => !safeCliArgument(arg))) throw new Error('CLI fixed arguments are invalid or exceed the limit')
  if (maxArgs < 0 || maxArgs > 32 || timeoutMs < 100 || timeoutMs > 120_000 || maxOutputBytes < 1024 || maxOutputBytes > 1_048_576) throw new Error('CLI limits are outside the allowed range')
  return { executable, fixedArgs: [...fixedArgs] as string[], maxArgs, timeoutMs, maxOutputBytes }
}

export async function executeCliTool(tool: ToolDefinition, input: unknown, cwd: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const spec = cliMetadata(recordObject(tool.metadata).cli)
  const args = recordObject(input).args
  if (!Array.isArray(args) || args.length > spec.maxArgs || args.some((arg) => !safeCliArgument(arg))) throw new Error('CLI arguments are invalid or exceed the configured limit')
  try {
    const result = await execFileAsync(spec.executable, [...spec.fixedArgs, ...args as string[]], { cwd, shell: false, timeout: spec.timeoutMs, maxBuffer: spec.maxOutputBytes, windowsHide: true })
    return { stdout: String(result.stdout), stderr: String(result.stderr), exitCode: 0 }
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; code?: number | string; killed?: boolean }
    const message = failure.killed ? 'CLI tool timed out' : 'CLI tool failed'
    const output = `${String(failure.stdout ?? '')}${String(failure.stderr ?? '')}`.slice(0, spec.maxOutputBytes)
    throw new Error(`${message}${output ? `: ${redactSensitiveText(output)}` : ''}`)
  }
}

function registeredToolFields(input: Record<string, unknown>, existing?: ToolDefinition): Omit<ToolDefinition, 'id' | 'created_at' | 'updated_at'> {
  const value = (key: string, fallback: unknown) => input[key] === undefined ? fallback : input[key]
  const definition = {
    tool_id: existing?.tool_id ?? String(input.tool_id ?? ''),
    namespace: existing?.namespace ?? String(input.namespace ?? ''),
    description: String(value('description', existing?.description ?? '')),
    adapter: (existing?.adapter ?? input.adapter) as ToolAdapter,
    target: String(value('target', existing?.target ?? '')),
    operation: String(value('operation', existing?.operation ?? '')),
    input_schema: recordObject(value('input_schema', existing?.input_schema ?? {})),
    output_schema: recordObject(value('output_schema', existing?.output_schema ?? {})),
    risk: value('risk', existing?.risk ?? 'read') as ToolRisk,
    requires_approval: Boolean(value('requires_approval', existing?.requires_approval ?? true)),
    enabled: Boolean(value('enabled', existing?.enabled ?? true)),
    context_mode: value('context_mode', existing?.context_mode ?? 'discoverable') as ToolContextMode,
    metadata: recordObject(value('metadata', existing?.metadata ?? {})),
  }
  if (definition.adapter === 'internal' && definition.target !== 'cli') throw new Error('Only HTTP, OpenAPI, and MCP tools may be registered')
  if (definition.target === 'cli') {
    if (definition.adapter !== 'internal' || definition.operation !== 'run') throw new Error('CLI tools must use the internal cli/run operation')
    cliMetadata(definition.metadata.cli)
  }
  return validateToolDefinition(definition)
}

export async function manageRegisteredTool(client: PocketBase, operation: string, input: unknown, userId: string): Promise<unknown> {
  const args = recordObject(input)
  const ownedFilter = `owner_id = "${escapeFilter(userId)}"`
  if (operation === 'list') {
    const records = await client.collection('tool_registry').getFullList({ filter: ownedFilter, sort: 'namespace,tool_id' })
    return records.map((record) => registeredToolProjection(record))
  }
  const toolId = typeof args.tool_id === 'string' ? args.tool_id.trim() : ''
  if (!toolId) throw new Error('tool_id is required')
  const existing = await client.collection('tool_registry').getFirstListItem(`${ownedFilter} && tool_id = "${escapeFilter(toolId)}"`).catch(() => null)
  if (operation === 'delete') {
    if (!existing) throw new Error('Registered tool not found')
    await client.collection('tool_registry').delete(existing.id)
    return { deleted: true, tool_id: toolId }
  }
  if (operation === 'create-cli') {
    if (existing) throw new Error('A registered tool with this ID already exists')
    const spec = cliMetadata({ executable: args.executable, fixedArgs: args.fixed_args, maxArgs: args.max_args, timeoutMs: args.timeout_ms, maxOutputBytes: args.max_output_bytes })
    const validated = registeredToolFields({
      tool_id: toolId,
      namespace: String(args.namespace ?? ''),
      description: String(args.description ?? ''),
      adapter: 'internal',
      target: 'cli',
      operation: 'run',
      input_schema: { type: 'object', properties: { args: { type: 'array', maxItems: spec.maxArgs, items: { type: 'string', maxLength: 256 } } }, required: ['args'], additionalProperties: false },
      output_schema: { type: 'object' },
      risk: 'external',
      requires_approval: true,
      enabled: true,
      context_mode: 'discoverable',
      metadata: { cli: spec },
    })
    const now = Date.now()
    const record = await client.collection('tool_registry').create({ ...validated, owner_id: userId, created_at: now, updated_at: now })
    return registeredToolProjection(record)
  }
  if (operation === 'update' && !existing) throw new Error('Registered tool not found')
  const validated = registeredToolFields(args, existing ? toTool(existing) : undefined)
  const data = { ...validated, owner_id: userId, metadata: { ...validated.metadata, contextMode: validated.context_mode }, updated_at: Date.now() }
  const record = operation === 'update'
    ? await client.collection('tool_registry').update(existing!.id, data)
    : await client.collection('tool_registry').create({ ...data, owner_id: userId, created_at: Date.now() })
  return registeredToolProjection(record)
}



function pocketBaseClientPort(client: PocketBase): PocketBaseClientPort {
  return {
    collection(name) {
      const collection = client.collection(name)
      return {
        async list() { return await collection.getFullList() as PocketBaseStoredRecord[] },
        async get(id) { return await collection.getOne(id).catch(() => undefined) as PocketBaseStoredRecord | undefined },
        async create(data) { return await collection.create(data) as PocketBaseStoredRecord },
        async update(id, data) { return await collection.update(id, data).catch(() => undefined) as PocketBaseStoredRecord | undefined },
      }
    },
  }
}

function coreToolRisk(risk: ToolRisk): CoreToolDefinition['risk'] {
  return risk === 'read' ? 'low' : risk === 'external' ? 'high' : 'medium'
}

function coreToolDefinition(tool: ToolDefinition): CoreToolDefinition {
  return {
    id: tool.tool_id,
    namespace: tool.namespace,
    description: tool.description,
    inputSchema: tool.input_schema as JsonValue,
    enabled: tool.enabled,
    risk: coreToolRisk(tool.risk),
    metadata: {
      webuiDefinition: JSON.stringify(tool),
      adapter: tool.adapter,
      target: tool.target,
      operation: tool.operation,
    },
  }
}

async function coreToolDefinitions(client: PocketBase): Promise<CoreToolDefinition[]> {
  const records = await client.collection('tool_registry').getFullList({ filter: 'enabled = true', sort: 'namespace,tool_id' })
  return records.map((record) => coreToolDefinition(toTool(record)))
}

export function validateToolInput(input: unknown, definition: CoreToolDefinition): { valid: true } | { valid: false; errors: string[] } {
  const schema = recordObject(definition.inputSchema)
  const error = requiredInputError(schema, input)
  return error ? { valid: false, errors: [error] } : { valid: true }
}

function coreDefinitionTool(definition: CoreToolDefinition): ToolDefinition {
  try {
    const parsed = JSON.parse(definition.metadata?.webuiDefinition ?? '')
    return toTool(parsed)
  } catch {
    throw new Error(`Tool definition is missing its WebUI execution metadata: ${definition.id}`)
  }
}

function coreApprovalRecord(record: Record<string, unknown>, approvalId: string, fallback?: ApprovalRequest): CoreApprovalRecord {
  const status = String(record.status ?? '')
  const input = fallback?.call.input ?? record.input
  return {
    approvalId,
    callId: String(record.call_id ?? fallback?.call.callId ?? ''),
    toolId: String(record.tool_id ?? fallback?.call.toolId ?? ''),
    ...(fallback?.runId ? { runId: fallback.runId } : {}),
    request: redactSensitive({
      input,
      callId: String(record.call_id ?? fallback?.call.callId ?? ''),
      toolId: String(record.tool_id ?? fallback?.call.toolId ?? ''),
      sessionId: record.session_id ?? fallback?.context.sessionId,
      agentId: fallback?.context.agentId,
    }) as JsonValue,
    status: status === 'approved' ? 'approved' : status === 'rejected' || status === 'denied' ? 'denied' : 'pending',
    ...(typeof record.reason === 'string' ? { reason: redactSensitiveText(record.reason) } : {}),
    createdAt: new Date(Number(record.created_at ?? Date.now())).toISOString(),
    ...(typeof record.resolved_at === 'number' ? { decidedAt: new Date(record.resolved_at).toISOString() } : {}),
  }
}

function createWebUiApprovalStore(client: PocketBase, ownerId: string, onApproval?: (approval: CoreApprovalRecord) => void | Promise<void>): ApprovalStore {
  const flow = createApprovalFlow(client)
  const find = async (approvalId: string): Promise<Record<string, unknown> | undefined> => {
    const byId = await client.collection('tool_approvals').getOne(approvalId).catch(() => null)
    if (byId) return byId as Record<string, unknown>
    return await client.collection('tool_approvals').getFirstListItem(`approval_key = "${escapeFilter(approvalId)}" && user_id = "${escapeFilter(ownerId)}"`).catch(() => undefined) as Record<string, unknown> | undefined
  }
  return {
    async load(approvalId) {
      const record = await find(approvalId)
      if (!record || record.user_id !== ownerId) return undefined
      return coreApprovalRecord(record, String(record.approval_key ?? approvalId))
    },
    async create(request) {
      const created = await flow.create({
        userId: ownerId,
        agentId: request.context.agentId ?? request.context.metadata?.agentName ?? 'master',
        sessionId: request.context.sessionId,
        toolId: request.call.toolId,
        input: request.call.input,
        reason: request.decision.reason,
      })
      const encryptedInput = encryptApprovalInput(request.call.input)
      const patch = {
        approval_key: request.approvalId,
        call_id: request.call.callId,
        ...(encryptedInput ? { executable_input: encryptedInput } : {}),
      }
      let stored: Record<string, unknown>
      try {
        stored = await client.collection('tool_approvals').update(created.approval.id, patch) as Record<string, unknown>
      } catch {
        const existing = await find(request.approvalId)
        if (!existing) throw new Error('Approval could not be durably created')
        return coreApprovalRecord(existing, request.approvalId, request)
      }
      const approval = coreApprovalRecord({ ...created.approval, ...stored }, request.approvalId, request)
      await onApproval?.(approval)
      return approval
    },
    async decide(approvalId, decision: ApprovalDecision) {
      const record = await find(approvalId)
      if (!record || record.user_id !== ownerId) throw new Error('Approval was not found')
      const resolved = await flow.resolve({ userId: ownerId, sessionId: typeof record.session_id === 'string' ? record.session_id : undefined }, String(record.id), decision.approved ? 'approve' : 'reject')
      if (!resolved.ok || !('approval' in resolved)) throw new Error(resolved.error.message)
      return coreApprovalRecord({ ...record, ...resolved.approval }, String(record.approval_key ?? approvalId))
    },
  }
}

export type CoreGatewayOptions = {
  onApproval?: (approval: CoreApprovalRecord) => void | Promise<void>
}

export async function createCoreToolGateway(client: PocketBase, ownerId: string, options: CoreGatewayOptions = {}): Promise<CoreToolGateway> {
  const definitions = await coreToolDefinitions(client)
  const adapter = createPocketBaseAdapter({
    client: pocketBaseClientPort(client),
    collections: { audits: 'subpolar_tool_audits', callClaims: 'subpolar_call_claims' },
  })
  const auditPort: AuditPort = createPocketBaseAuditPort(adapter, ownerId)
  const idempotency = createPocketBaseIdempotencyPort(adapter, ownerId)
  const approvalStore = createWebUiApprovalStore(client, ownerId, options.onApproval)
  const resolvePolicy: PolicyResolver = async (definition, context) => {
    const agentName = context.metadata?.agentName ?? context.agentId ?? 'master'
    const agent = agentName === 'master'
      ? await findAgent(client, ownerId, agentName) ?? await ensureUserDefaults(client, ownerId)
      : await findAgent(client, ownerId, agentName)
    if (!agent || !agent.enabled) return { deny: true, reason: 'Agent is disabled or does not exist' }
    const effective = effectiveAgentConfiguration(agent, context.projectId)
    const webTool = coreDefinitionTool(definition)
    const override = context.metadata?.permissionOverride as PermissionOverride | undefined
    const policies = await client.collection('agent_tool_policies').getFullList({ filter: `user_id = "${escapeFilter(ownerId)}" && agent_id = "${escapeFilter(agent.id)}"` })
    const matching = policies.filter((item) => item.tool_id === definition.id || item.tool_id === '*')
    const mode = toolContextMode(effective, definition.id)
    if (mode === 'disabled' || matching.some((item) => item.effect === 'deny') || override === 'none' || effective.approval_mode === 'deny') return { deny: true, reason: `Agent is not allowed to use ${definition.id}` }
    if (profileManagementTools.has(definition.id) && agent.name !== 'master') return { deny: true, reason: 'Agent profile management requires the master agent' }
    if (toolManagementTools.has(definition.id) && agent.name !== 'master') return { deny: true, reason: 'Registered tool management requires the master agent' }
    if (cliManagementTools.has(definition.id) && agent.name !== 'master') return { deny: true, reason: 'CLI tool management requires the master agent' }
    if (definition.id.startsWith('memory/') && !memoryPolicyAllows(effective, definition.id)) return { deny: true, reason: 'Memory is disabled for this agent' }
    if (definition.id.startsWith('browser/') && (effective.policies.browser !== true || (browserMutationGroups.has(String(webTool.metadata.policyGroup)) && !browserProfileAllows(String(webTool.metadata.policyGroup), agent.template === 'plan' || agent.template === 'reviewer')))) return { deny: true, reason: 'Browser capability is not allowed for this agent' }
    if (memoryMutationTools.has(definition.id) && (agent.template === 'plan' || agent.template === 'reviewer')) return { deny: true, reason: 'This agent profile is query-only for memory' }
    const explicitlyAllowed = matching.some((item) => item.effect === 'allow' || item.effect === 'approval')
    if (override !== 'allow_all' && !explicitlyAllowed && agent.name !== 'master' && !matching.some((item) => item.tool_id === generatedSkillName(definition.id))) return { deny: true, reason: `Agent is not allowed to use ${definition.id}` }
    const masterWebSearch = agent.name === 'master' && definition.id === 'web.search'
    const needsApproval = !masterWebSearch && (requiresManualApproval(definition.id, webTool.target) || effective.approval_mode === 'ask' || override === 'ask' || (override !== 'allow_all' && (webTool.requires_approval || matching.some((item) => item.effect === 'approval'))))
    return needsApproval ? { requiresApproval: true, allow: true, reason: `${definition.id} requires approval` } : { allow: true }
  }
  const execute: ToolExecutor = async (call, definition, context) => {
    const tool = coreDefinitionTool(definition)
    try {
      const value = await invokeExternalTool(client, tool, call.input, context.cwd ?? process.cwd(), call.callId, {
        userId: context.principal.id,
        agentName: context.metadata?.agentName ?? context.agentId ?? 'master',
        agentId: context.agentId,
        projectId: context.projectId,
        sessionId: context.sessionId,
        cwd: context.cwd,
        callId: call.callId,
        capabilities: context.metadata?.capabilities?.split(',').filter(Boolean),
      })
      return { ok: true, value }
    } catch (error) {
      return { ok: false, error: { code: 'TOOL_EXECUTION_FAILED', message: redactSensitiveText(error instanceof Error ? error.message : 'Tool execution failed') } }
    }
  }
  return createCoreGateway({ tools: definitions, validateInput: validateToolInput, resolvePolicy, approvalStore, idempotency, auditPort, execute })
}

async function invokeInternalTool(client: PocketBase, tool: ToolDefinition, input: unknown, cwd: string, callId: string, context?: ToolExecutionContext): Promise<unknown> {
  if (tool.target === 'subagent' && tool.operation === 'run') {
    if (!subagentToolRunner) throw new Error('Subagent execution host is unavailable')
    return subagentToolRunner(input, { ...context, cwd, callId } as ToolExecutionContext)
  }
  if (tool.target === 'memory') {
    if (!context?.agentId) throw new Error('Memory requires an active agent')
    const service = new PocketBaseMemoryService(client)
    const scoped = memoryContext(context, context.agentId, context.projectId)
    const args = recordObject(input)
    if (tool.operation === 'query') return service.query(scoped, { scope: args.scope as MemoryScope | undefined, query: typeof args.query === 'string' ? args.query : undefined, limit: typeof args.limit === 'number' ? args.limit : undefined })
    if (tool.operation === 'write') return service.write(scoped, { scope: args.scope as MemoryScope, content: String(args.content ?? ''), metadata: recordObject(args.metadata), idempotencyKey: typeof args.idempotencyKey === 'string' ? args.idempotencyKey : undefined })
    if (tool.operation === 'update') return service.update(scoped, String(args.id), { content: typeof args.content === 'string' ? args.content : undefined, metadata: args.metadata === undefined ? undefined : recordObject(args.metadata), version: Number(args.version) })
    if (tool.operation === 'delete') return service.tombstone(scoped, String(args.id), Number(args.version))
  }
  if (tool.target === 'browser') {
    if (!context?.userId || !context.sessionId) throw new BrowserRuntimeError('BROWSER_SESSION_NOT_FOUND', 'Browser tools require an owned tool session')
    const args = recordObject(input)
    const browserSessionId = typeof args.browserSessionId === 'string' ? args.browserSessionId : ''
    const browser = new BrowserSessionService(client)
    const browserContext: BrowserContext = { ownerId: context.userId, projectId: context.projectId, sessionId: context.sessionId, agentName: context.agentName, readOnly: context.agentName === 'plan' || context.agentName === 'reviewer' }
    return browser.execute(browserContext, tool.operation, { ...args, browserSessionId })
  }
  if (tool.target === 'agent-profiles') {
    if (context?.agentName !== 'master' || !context.userId) throw new Error('Agent profile management requires the master agent')
    return manageAgentProfile(client, tool.operation, input, context.userId)
  }
  if (tool.target === 'tool-registry') {
    if (context?.agentName !== 'master' || !context.userId) throw new Error('Registered tool management requires the master agent')
    return manageRegisteredTool(client, tool.operation, input, context.userId)
  }
  if (tool.target === 'cli' && tool.operation === 'run') return executeCliTool(tool, input, cwd)
  if (tool.target === 'web' && tool.operation === 'search') return webSearch(input as WebSearchInput, { networkPolicy: networkPolicyFromMetadata(tool.metadata) })
  if (tool.target === 'web' && tool.operation === 'fetch') return webFetch(input as WebFetchInput, { networkPolicy: networkPolicyFromMetadata(tool.metadata) })
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

export async function invokeExternalTool(client: PocketBase, tool: ToolDefinition, input: unknown, cwd: string, callId: string, context?: ToolExecutionContext): Promise<unknown> {
  if (tool.adapter === 'internal') {
    if (['pi', 'memory', 'browser', 'web', 'web-search', 'subagent', 'agent-profiles', 'tool-registry', 'cli'].includes(tool.target)) return invokeInternalTool(client, tool, input, cwd, callId, context)
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
  const hasRequestBody = metadata.requestBody === true
  const requestBody = args.body !== undefined
    ? args.body
    : hasRequestBody || parameters.length > 0
      ? undefined
      : input
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


function shortDescription(description: string): string {
  const short = description.trim().split(/(?<=[.!?])\s+/)[0] ?? description.trim()
  return short.length > 120 ? `${short.slice(0, 117).trimEnd()}...` : short
}

function toolUsage(tool: ToolDefinition): string {
  const properties = Object.keys(recordObject(tool.input_schema.properties))
  const args = properties.slice(0, 4).map((name) => `${name}: ...`).join(', ')
  const directlyCallable = Object.hasOwn(piToolIds, tool.tool_id) || tool.tool_id === 'search-tool'
  if (directlyCallable) return `${tool.tool_id}({${args}})`
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

export async function listPendingCoreApprovals(client: PocketBase, userId: string, sessionId?: string): Promise<Approval[]> {
  const pending = await createApprovalFlow(client).pending({ userId }, sessionId)
  return Promise.all(pending.approvals.map(async (approval) => {
    const record = await client.collection('tool_approvals').getOne(approval.id).catch(() => null) as Record<string, unknown> | null
    const key = typeof record?.approval_key === 'string' ? record.approval_key : approval.id
    return { ...toApproval(approval), id: key }
  }))
}

export async function respondToCoreApproval(client: PocketBase, userId: string, approvalId: string, decision: boolean | 'approve' | 'approved' | 'reject' | 'rejected', sessionId: string): Promise<Approval | null> {
  const record = await client.collection('tool_approvals').getOne(approvalId).catch(() => null)
    ?? await client.collection('tool_approvals').getFirstListItem(`approval_key = "${escapeFilter(approvalId)}" && user_id = "${escapeFilter(userId)}"`).catch(() => null)
  if (!record || record.user_id !== userId || (record.session_id && record.session_id !== sessionId)) return null
  const resolved = await createApprovalFlow(client).resolve({ userId, sessionId }, String(record.id), decision)
  if (!resolved.ok || !('approval' in resolved)) return null
  const approval = toApproval(resolved.approval)
  return { ...approval, id: typeof record.approval_key === 'string' ? record.approval_key : approval.id }
}

export async function continueCoreApprovedTool(client: PocketBase, userId: string, approvalId: string, options: { sessionId: string; cwd?: string; agentName?: string; projectId?: string; permissionOverride?: PermissionOverride; callId?: string } ): Promise<unknown> {
  const record = await client.collection('tool_approvals').getOne(approvalId).catch(() => null)
    ?? await client.collection('tool_approvals').getFirstListItem(`approval_key = "${escapeFilter(approvalId)}" && user_id = "${escapeFilter(userId)}"`).catch(() => null)
  if (!record || record.user_id !== userId || record.session_id !== options.sessionId) return { ok: false, error: { code: 'APPROVAL_NOT_FOUND', message: 'Approval was not found' } }
  if (record.status !== 'approved') return { ok: false, toolId: String(record.tool_id), approvalRequired: true, approvalId, message: 'Tool approval is still pending' }
  const input = takePendingApprovalInput(String(record.id)) ?? decryptApprovalInput(record.executable_input)
  if (input === undefined) return { ok: false, toolId: String(record.tool_id), error: { code: 'APPROVAL_INTERRUPTED', message: 'Approval input is unavailable; configure SUBPOLAR_APPROVAL_KEY or recreate the approval' } }
  const gateway = await createCoreToolGateway(client, userId)
  const callId = options.callId ?? String(record.call_id ?? crypto.randomUUID())
  return gateway.call(
    { callId, toolId: String(record.tool_id), input, idempotencyKey: `tool-call:${callId}` },
    {
      requestId: callId,
      principal: { id: userId, kind: 'user' },
      sessionId: options.sessionId,
      projectId: options.projectId,
      agentId: options.agentName,
      cwd: options.cwd,
      metadata: {
        agentName: options.agentName ?? 'master',
        ...(options.permissionOverride === undefined ? {} : { permissionOverride: options.permissionOverride }),
      },
    },
  )
}




export type { PocketBase }
