import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type PocketBase from 'pocketbase'
import {
  canonicalToolId,
  type AgentDefinition,
  type ToolAdapter,
  type ToolDefinition,
  type ToolEffect,
  type ToolRisk,
  type AgentApprovalMode,
  type AgentPolicySet,
  type AgentEffectiveSource,
  agentTemplateDefaults,
  agentToolContextMode,
  effectiveAgentConfiguration,
  resolveSkillRuntimeContext,
  renderSkillRuntimeContext,
  type SkillContextAudit,
  type SkillRuntimeContext,
} from '../tools/tools.ts'
import type { SkillRepository } from '../../../../packages/subpolar-contracts/src/index.ts'

/** The only Pi tool names that can be activated by this adapter. */
export const PI_ROUTED_TOOL_NAMES = [
  'read',
  'write',
  'edit',
  'bash',
  'grep',
  'find',
  'ls',
  'search-tool',
  'subpolar-tools',
] as const

export type PiRoutedToolName = typeof PI_ROUTED_TOOL_NAMES[number]

/** The gateway used for registered tools that are not native Pi tools. */
export const PI_EXTERNAL_GATEWAY_TOOL = 'subpolar-tools' as const

/** Profile-management tools from the old filesystem extension are never granted by this adapter. */
export const LEGACY_MANAGEMENT_TOOL_NAMES = [
  'list_agent_profiles',
  'create_agent_profile',
  'edit_agent_profile',
  'manage_external_tools',
] as const

export type AgentRuntimeErrorCode =
  | 'INVALID_USER'
  | 'INVALID_AGENT_SELECTOR'
  | 'AGENT_NOT_FOUND'
  | 'AGENT_NOT_OWNED'
  | 'AGENT_DISABLED'
  | 'INVALID_AGENT'
  | 'AGENT_STORE_UNAVAILABLE'
  | 'POLICY_STORE_UNAVAILABLE'
  | 'TOOL_STORE_UNAVAILABLE'
  | 'INVALID_TOOL_POLICY'

export class AgentRuntimeError extends Error {
  readonly name = 'AgentRuntimeError'

  constructor(
    readonly code: AgentRuntimeErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options)
  }
}

export type AgentToolPolicy = {
  id?: string
  user_id: string
  agent_id: string
  /** Canonical tool ID, or `*` for a wildcard rule. */
  tool_id: string
  effect: ToolEffect
  created_at?: number
  updated_at?: number
}

export type AgentToolRuntime = {
  definition: ToolDefinition
  /** The most specific effective rule, or the default rule when no rule exists. */
  effect: ToolEffect
  /** Whether the agent may expose/call this enabled registry tool. */
  allowed: boolean
  requiresApproval: boolean
  /** Direct Pi wrapper for a native tool, or the external gateway. */
  piToolName: PiRoutedToolName
  matchingPolicies: readonly AgentToolPolicy[]
}

export type AgentToolPolicyRuntime = {
  policies: readonly AgentToolPolicy[]
  tools: readonly AgentToolRuntime[]
  allowedToolIds: readonly string[]
  deniedToolIds: readonly string[]
  approvalToolIds: readonly string[]
  unresolvedPolicyToolIds: readonly string[]
}

/** Shape consumed by the existing agent-profile extension and by Pi session setup. */
export type PiAgentProfile = {
  /** Undefined means keep Pi's normal generated system prompt. */
  systemPrompt?: string
  /** These are Pi wrapper names, never raw filesystem-provided names. */
  tools: readonly PiRoutedToolName[]
}

/** A projection compatible with createAgentSession's explicit tool allowlist. */
export type PiRuntimeConfiguration = {
  source: 'pocketbase'
  agentId: string
  agentName: string
  mode: AgentDefinition['mode']
  /** Explicit PocketBase system prompt, falling back to the agent prompt when needed. */
  systemPrompt?: string
  /** The original PocketBase prompt is retained separately for callers that need it. */
  prompt: string
  profile: PiAgentProfile
  allowedToolNames: readonly PiRoutedToolName[]
  initialActiveToolNames: readonly PiRoutedToolName[]
  excludedToolNames: readonly PiRoutedToolName[]
  effectiveSource: AgentEffectiveSource
  skillContext: readonly SkillRuntimeContext[]
}

export type AgentRuntime = {
  source: 'pocketbase'
  agent: AgentDefinition
  /** Exact normalized PocketBase fields exposed to the runtime. */
  systemPrompt?: string
  prompt: string
  toolPolicy: AgentToolPolicyRuntime
  pi: PiRuntimeConfiguration
  skillContext: readonly SkillRuntimeContext[]
  diagnostics: readonly string[]
}

type RecordValue = Record<string, unknown>

type PocketBaseCollection = {
  getFirstListItem: (filter: string) => Promise<unknown>
  getFullList: (options?: { filter?: string; sort?: string }) => Promise<unknown[]>
}

type PocketBaseCollections = {
  collection: (name: string) => PocketBaseCollection
}

export type PocketBaseAgentRuntimeAdapterOptions = {
  /** Defaults to `master`, matching the bridge and the existing tool router. */
  defaultAgentName?: string
  skillRepository?: SkillRepository
  skillAudit?: SkillContextAudit
}

function object(value: unknown): RecordValue {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {}
}

function nonBlank(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function escapeFilter(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
}

function collections(client: PocketBase): PocketBaseCollections {
  return client as unknown as PocketBaseCollections
}

function isNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const value = error as RecordValue
  return value.status === 404 || value.statusCode === 404
}

function toolAdapter(value: unknown): ToolAdapter {
  return value === 'http' || value === 'openapi' || value === 'mcp' ? value : 'internal'
}

function toolRisk(value: unknown): ToolRisk {
  return value === 'write' || value === 'delete' || value === 'external' ? value : 'read'
}

function toAgentDefinition(value: unknown): AgentDefinition {
  const record = object(value)
  const id = nonBlank(record.id)
  const userId = nonBlank(record.user_id)
  const name = nonBlank(record.name)
  if (!id || !userId || !name) {
    throw new AgentRuntimeError('INVALID_AGENT', 'PocketBase returned an invalid agent record')
  }

  const template = record.template === 'general' || record.template === 'coding' || record.template === 'plan' || record.template === 'reviewer' ? record.template : undefined
  const defaults = agentTemplateDefaults(template)
  const modes = object(record.tool_context_modes ?? defaults.tool_context_modes)
  const skills = object(record.skill_context_modes ?? defaults.skill_context_modes)
  const policies = object(record.policies ?? defaults.policies)
  const validThinking = record.thinking === 'off' || record.thinking === 'minimal' || record.thinking === 'low' || record.thinking === 'medium' || record.thinking === 'high' ? record.thinking : defaults.thinking
  const validApproval: AgentApprovalMode = record.approval_mode === 'auto' || record.approval_mode === 'ask' || record.approval_mode === 'deny' ? record.approval_mode : defaults.approval_mode
  return {
    id,
    user_id: userId,
    name,
    description: stringValue(record.description),
    mode: record.mode === 'subagent' ? 'subagent' : 'primary',
    prompt: stringValue(record.prompt),
    system_prompt: stringValue(record.systemPrompt ?? record.system_prompt),
    enabled: record.enabled !== false,
    template,
    model: typeof record.model === 'string' ? record.model : defaults.model,
    thinking: validThinking,
    approval_mode: validApproval,
    policies: {
      builtin: object(policies.builtin) as AgentPolicySet['builtin'],
      registered: object(policies.registered) as AgentPolicySet['registered'],
      browser: policies.browser === true,
      memory: policies.memory === true,
      subagent: policies.subagent === true,
    },
    project_overrides: object(record.project_overrides) as AgentDefinition['project_overrides'],
    tool_context_modes: modes as AgentDefinition['tool_context_modes'],
    skill_context_modes: skills as AgentDefinition['skill_context_modes'],
    effective_source: object(record.effective_source) as unknown as AgentEffectiveSource,
    created_at: finiteNumber(record.created_at),
    updated_at: finiteNumber(record.updated_at),
  }
}

function toToolDefinition(value: unknown): ToolDefinition | undefined {
  const record = object(value)
  const rawToolId = nonBlank(record.tool_id ?? record.toolId)
  if (!rawToolId) return undefined
  const adapter = toolAdapter(record.adapter)
  const namespace = stringValue(record.namespace)
  const toolId = canonicalToolId(rawToolId, adapter, namespace)
  if (!toolId) return undefined

  return {
    id: nonBlank(record.id),
    tool_id: toolId,
    namespace,
    description: stringValue(record.description),
    adapter,
    target: stringValue(record.target),
    operation: stringValue(record.operation),
    input_schema: object(record.input_schema ?? record.inputSchema),
    output_schema: object(record.output_schema ?? record.outputSchema),
    risk: toolRisk(record.risk),
    requires_approval: record.requires_approval === true || record.requiresApproval === true,
    enabled: record.enabled !== false,
    metadata: object(record.metadata),
    created_at: finiteNumber(record.created_at),
    updated_at: finiteNumber(record.updated_at),
  }
}

function policyEffect(value: unknown): ToolEffect | undefined {
  return value === 'allow' || value === 'deny' || value === 'approval' ? value : undefined
}

function toAgentToolPolicy(value: unknown, userId: string, agentId: string): AgentToolPolicy {
  const record = object(value)
  const policyUserId = nonBlank(record.user_id)
  const policyAgentId = nonBlank(record.agent_id)
  const rawToolId = nonBlank(record.tool_id ?? record.toolId)
  const effect = policyEffect(record.effect)
  if (!policyUserId || !policyAgentId || !rawToolId || !effect) {
    throw new AgentRuntimeError('INVALID_TOOL_POLICY', 'PocketBase returned an invalid agent tool policy')
  }
  if (policyUserId !== userId || policyAgentId !== agentId) {
    throw new AgentRuntimeError('INVALID_TOOL_POLICY', 'PocketBase returned an agent tool policy owned by another identity')
  }

  const toolId = rawToolId === '*'
    ? '*'
    : canonicalToolId(rawToolId)
  return {
    id: nonBlank(record.id),
    user_id: policyUserId,
    agent_id: policyAgentId,
    tool_id: toolId,
    effect,
    created_at: finiteNumber(record.created_at),
    updated_at: finiteNumber(record.updated_at),
  }
}

function nativePiToolName(tool: ToolDefinition): PiRoutedToolName {
  // The registry's canonical ID is the stable mapping. Namespace is metadata and
  // may be absent on older records, so it must not turn a native wrapper into a
  // gateway call.
  if ((PI_ROUTED_TOOL_NAMES as readonly string[]).includes(tool.tool_id)) {
    return tool.tool_id as PiRoutedToolName
  }
  return PI_EXTERNAL_GATEWAY_TOOL
}

function isMaster(agent: AgentDefinition): boolean {
  return agent.name.toLowerCase() === 'master'
}

function effectiveEffect(agent: AgentDefinition, toolId: string, policies: readonly AgentToolPolicy[]): ToolEffect {
  const matching = policies.filter((policy) => policy.tool_id === toolId || policy.tool_id === '*')
  // This mirrors the tool router's fail-closed precedence: deny wins, then approval,
  // then allow. Master has the existing default full registry access when no rule exists.
  if (matching.some((policy) => policy.effect === 'deny')) return 'deny'
  if (matching.some((policy) => policy.effect === 'approval')) return 'approval'
  if (matching.some((policy) => policy.effect === 'allow')) return 'allow'
  return isMaster(agent) ? 'allow' : 'deny'
}

function matchingPolicies(toolId: string, policies: readonly AgentToolPolicy[]): AgentToolPolicy[] {
  return policies.filter((policy) => policy.tool_id === toolId || policy.tool_id === '*')
}

function explicitGatewayEffect(policies: readonly AgentToolPolicy[]): ToolEffect | undefined {
  const matching = policies.filter((policy) => policy.tool_id === PI_EXTERNAL_GATEWAY_TOOL)
  if (matching.some((policy) => policy.effect === 'deny')) return 'deny'
  if (matching.some((policy) => policy.effect === 'approval')) return 'approval'
  if (matching.some((policy) => policy.effect === 'allow')) return 'allow'
  return undefined
}

function effectiveSystemPrompt(agent: AgentDefinition): string | undefined {
  // system_prompt is the explicit override used by the settings UI. The agent
  // prompt is the useful legacy-compatible fallback when that override is empty.
  return nonBlank(agent.system_prompt) ?? nonBlank(agent.prompt)
}

function buildToolPolicyRuntime(agent: AgentDefinition, policies: readonly AgentToolPolicy[], definitions: readonly ToolDefinition[]): AgentToolPolicyRuntime {
  const tools = definitions.map((definition): AgentToolRuntime => {
    const matching = matchingPolicies(definition.tool_id, policies)
    const effect = effectiveEffect(agent, definition.tool_id, policies)
    return {
      definition,
      effect,
      allowed: effect !== 'deny' && agentToolContextMode(agent, definition.tool_id) !== 'disabled',
      requiresApproval: effect === 'approval' || definition.requires_approval,
      piToolName: nativePiToolName(definition),
      matchingPolicies: matching,
    }
  })

  const registeredIds = new Set(definitions.map((tool) => tool.tool_id))
  const unresolvedPolicyToolIds = [...new Set(
    policies
      .map((policy) => policy.tool_id)
      .filter((toolId) => toolId !== '*' && !registeredIds.has(toolId)),
  )].sort()

  return {
    policies,
    tools,
    allowedToolIds: tools.filter((tool) => tool.allowed).map((tool) => tool.definition.tool_id),
    deniedToolIds: tools.filter((tool) => !tool.allowed).map((tool) => tool.definition.tool_id),
    approvalToolIds: tools.filter((tool) => tool.allowed && tool.requiresApproval).map((tool) => tool.definition.tool_id),
    unresolvedPolicyToolIds,
  }
}

function buildPiRuntimeConfiguration(agent: AgentDefinition, toolPolicy: AgentToolPolicyRuntime, skillContext: readonly SkillRuntimeContext[] = [], configuredSystemPrompt?: string): PiRuntimeConfiguration {
  const allowed = new Set<PiRoutedToolName>()
  const excluded = new Set<PiRoutedToolName>()

  for (const tool of toolPolicy.tools) {
    const mode = agentToolContextMode(agent, tool.definition.tool_id)
    if (tool.allowed && (mode === 'always' || mode === 'discoverable')) allowed.add(tool.piToolName)
    else excluded.add(tool.piToolName)
  }

  const hasAllowedExternalTool = toolPolicy.tools.some((tool) => tool.allowed && tool.piToolName === PI_EXTERNAL_GATEWAY_TOOL)
  const gatewayEffect = explicitGatewayEffect(toolPolicy.policies)
  if (hasAllowedExternalTool && gatewayEffect !== 'deny') allowed.add(PI_EXTERNAL_GATEWAY_TOOL)
  if (gatewayEffect === 'deny') {
    allowed.delete(PI_EXTERNAL_GATEWAY_TOOL)
    excluded.add(PI_EXTERNAL_GATEWAY_TOOL)
  }

  // If a wildcard or a direct gateway rule grants the synthetic gateway, expose it
  // even when no external registry record happens to exist yet.
  if (gatewayEffect === 'allow' || gatewayEffect === 'approval') {
    allowed.add(PI_EXTERNAL_GATEWAY_TOOL)
    excluded.delete(PI_EXTERNAL_GATEWAY_TOOL)
  }

  const activeToolNames = [...allowed]
  const systemPrompt = configuredSystemPrompt ?? effectiveSystemPrompt(agent)
  const profile: PiAgentProfile = { systemPrompt, tools: activeToolNames }
  return {
    source: 'pocketbase',
    agentId: agent.id,
    agentName: agent.name,
    mode: agent.mode,
    systemPrompt,
    prompt: agent.prompt,
    profile,
    allowedToolNames: activeToolNames,
    initialActiveToolNames: activeToolNames,
    excludedToolNames: [...excluded].filter((name) => !allowed.has(name)),
    effectiveSource: agent.effective_source,
    skillContext,
  }
}

async function getAgentRecord(client: PocketBase, userId: string, selector: string): Promise<unknown> {
  const filter = `user_id = "${escapeFilter(userId)}" && (id = "${escapeFilter(selector)}" || name = "${escapeFilter(selector)}")`
  try {
    return await collections(client).collection('agents').getFirstListItem(filter)
  } catch (error) {
    if (isNotFoundError(error)) {
      throw new AgentRuntimeError('AGENT_NOT_FOUND', `Agent "${selector}" was not found`)
    }
    throw new AgentRuntimeError('AGENT_STORE_UNAVAILABLE', 'PocketBase agent store is unavailable', { cause: error })
  }
}

async function getPolicies(client: PocketBase, userId: string, agentId: string): Promise<AgentToolPolicy[]> {
  const filter = `user_id = "${escapeFilter(userId)}" && agent_id = "${escapeFilter(agentId)}"`
  try {
    const records = await collections(client).collection('agent_tool_policies').getFullList({ filter })
    return records.map((record) => toAgentToolPolicy(record, userId, agentId))
  } catch (error) {
    if (error instanceof AgentRuntimeError) throw error
    throw new AgentRuntimeError('POLICY_STORE_UNAVAILABLE', 'PocketBase agent policy store is unavailable', { cause: error })
  }
}

async function getEnabledTools(client: PocketBase): Promise<{ definitions: ToolDefinition[]; diagnostics: string[] }> {
  try {
    const records = await collections(client).collection('tool_registry').getFullList({ filter: 'enabled = true', sort: 'namespace,tool_id' })
    const diagnostics: string[] = []
    const definitions: ToolDefinition[] = []
    const seen = new Set<string>()
    for (const record of records) {
      const definition = toToolDefinition(record)
      if (!definition) {
        diagnostics.push('Ignored an invalid tool registry record')
        continue
      }
      if (definition.enabled === false || seen.has(definition.tool_id)) continue
      seen.add(definition.tool_id)
      definitions.push(definition)
    }
    return { definitions, diagnostics }
  } catch (error) {
    throw new AgentRuntimeError('TOOL_STORE_UNAVAILABLE', 'PocketBase tool registry is unavailable', { cause: error })
  }
}

/**
 * Loads one owned, enabled PocketBase agent and projects its policy into Pi's
 * centrally routed tool names. This function never reads `.pi/agents.json`.
 */
export async function loadAgentRuntime(
  client: PocketBase,
  userId: string,
  agentSelector = 'master',
  projectId?: string,
  options: { skillRepository?: SkillRepository; skillAudit?: SkillContextAudit } = {},
): Promise<AgentRuntime> {
  const normalizedUserId = nonBlank(userId)
  if (!normalizedUserId) throw new AgentRuntimeError('INVALID_USER', 'A user ID is required')
  const selector = nonBlank(agentSelector)
  if (!selector) throw new AgentRuntimeError('INVALID_AGENT_SELECTOR', 'An agent name or ID is required')

  const record = await getAgentRecord(client, normalizedUserId, selector)
  const agent = effectiveAgentConfiguration(toAgentDefinition(record), projectId)
  if (agent.user_id !== normalizedUserId) {
    throw new AgentRuntimeError('AGENT_NOT_OWNED', 'Agent was not found')
  }
  if (!agent.enabled) {
    throw new AgentRuntimeError('AGENT_DISABLED', `Agent "${agent.name}" is disabled`)
  }

  const [policies, registry] = await Promise.all([
    getPolicies(client, normalizedUserId, agent.id),
    getEnabledTools(client),
  ])
  const skillContext = options.skillRepository
    ? await resolveSkillRuntimeContext(options.skillRepository, normalizedUserId, agent, { projectId, audit: options.skillAudit })
    : []
  const toolPolicy = buildToolPolicyRuntime(agent, policies, registry.definitions)
  const systemPrompt = [effectiveSystemPrompt(agent), renderSkillRuntimeContext(skillContext)].filter(Boolean).join('\n\n') || undefined
  const pi = buildPiRuntimeConfiguration(agent, toolPolicy, skillContext, systemPrompt)
  return {
    source: 'pocketbase',
    agent,
    systemPrompt,
    prompt: agent.prompt,
    toolPolicy,
    pi,
    skillContext,
    diagnostics: registry.diagnostics,
  }
}

export class PocketBaseAgentRuntimeAdapter {
  private readonly defaultAgentName: string
  private readonly skillRepository?: SkillRepository
  private readonly skillAudit?: SkillContextAudit

  constructor(
    private readonly client: PocketBase,
    private readonly userId: string,
    options: PocketBaseAgentRuntimeAdapterOptions = {},
  ) {
    this.defaultAgentName = nonBlank(options.defaultAgentName) ?? 'master'
    this.skillRepository = options.skillRepository
    this.skillAudit = options.skillAudit
  }

  load(agentSelector = this.defaultAgentName): Promise<AgentRuntime> {
    return loadAgentRuntime(this.client, this.userId, agentSelector, undefined, { skillRepository: this.skillRepository, skillAudit: this.skillAudit })
  }

  async list(): Promise<AgentDefinition[]> {
    const userId = nonBlank(this.userId)
    if (!userId) throw new AgentRuntimeError('INVALID_USER', 'A user ID is required')
    try {
      const records = await collections(this.client).collection('agents').getFullList({
        filter: `user_id = "${escapeFilter(userId)}"`,
        sort: 'name',
      })
      return records.map((record) => {
        const agent = toAgentDefinition(record)
        if (agent.user_id !== userId) throw new AgentRuntimeError('AGENT_NOT_OWNED', 'Agent was not found')
        return agent
      })
    } catch (error) {
      if (error instanceof AgentRuntimeError) throw error
      throw new AgentRuntimeError('AGENT_STORE_UNAVAILABLE', 'PocketBase agent store is unavailable', { cause: error })
    }
  }
}

export function createPocketBaseAgentRuntimeAdapter(
  client: PocketBase,
  userId: string,
  options?: PocketBaseAgentRuntimeAdapterOptions,
): PocketBaseAgentRuntimeAdapter {
  return new PocketBaseAgentRuntimeAdapter(client, userId, options)
}

export type LegacyPiProfile = {
  systemPrompt: string
  tools: readonly PiRoutedToolName[]
}

export type LegacyProfileConversion = {
  source: 'legacy-filesystem'
  authority: 'read-only-fallback'
  name: string
  profile: LegacyPiProfile
  warnings: readonly string[]
}

export type LegacyProfileReadResult = {
  source: 'legacy-filesystem'
  authority: 'read-only-fallback'
  profiles: Readonly<Record<string, LegacyProfileConversion>>
  files: readonly string[]
  diagnostics: readonly string[]
}

function isSafeLegacyName(name: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(name) && name.toLowerCase() !== 'omniscient' && name.toLowerCase() !== 'master'
}

function safePiToolNames(value: unknown, knownToolNames: readonly string[]): PiRoutedToolName[] {
  if (!Array.isArray(value)) return []
  const known = new Set<string>([...PI_ROUTED_TOOL_NAMES, ...knownToolNames])
  return [...new Set(value.filter((tool): tool is string => typeof tool === 'string'))]
    .filter((tool): tool is PiRoutedToolName => known.has(tool) && (PI_ROUTED_TOOL_NAMES as readonly string[]).includes(tool))
    .filter((tool) => !(LEGACY_MANAGEMENT_TOOL_NAMES as readonly string[]).includes(tool))
}

/**
 * Converts one old `agents.json` entry without granting it authority. The
 * result is deliberately tagged read-only and only contains centrally routed
 * Pi tools; it is suitable for migration UI or a temporary inspection view.
 */
export function convertLegacyPiProfile(
  name: string,
  value: unknown,
  options: { knownToolNames?: readonly string[] } = {},
): LegacyProfileConversion | undefined {
  if (!isSafeLegacyName(name)) return undefined
  const record = object(value)
  const systemPrompt = nonBlank(record.systemPrompt ?? record.system_prompt)
  if (!systemPrompt) return undefined
  const requestedTools = Array.isArray(record.tools) ? record.tools : []
  const tools = safePiToolNames(requestedTools, options.knownToolNames ?? [])
  const warnings: string[] = []
  const ignored = requestedTools.filter((tool) => typeof tool === 'string' && !tools.includes(tool as PiRoutedToolName))
  if (ignored.length) warnings.push(`Ignored non-routed or management tools: ${ignored.join(', ')}`)
  return {
    source: 'legacy-filesystem',
    authority: 'read-only-fallback',
    name,
    profile: { systemPrompt, tools },
    warnings,
  }
}

function parseLegacyProfiles(value: unknown, file: string, diagnostics: string[]): Record<string, LegacyProfileConversion> {
  const parsed = object(value)
  const result: Record<string, LegacyProfileConversion> = {}
  for (const [name, profile] of Object.entries(parsed)) {
    const converted = convertLegacyPiProfile(name, profile)
    if (converted) result[name] = converted
    else if (name.toLowerCase() !== 'master' && name.toLowerCase() !== 'omniscient') {
      diagnostics.push(`Ignored invalid legacy profile "${name}" in ${file}`)
    }
  }
  return result
}

/**
 * Read-only legacy inspector. It is intentionally separate from
 * `loadAgentRuntime`; no result from this function can masquerade as a
 * PocketBase runtime source, and it never writes or merges into PocketBase.
 */
export function readLegacyPiProfiles(
  cwd: string,
  options: { homeDirectory?: string } = {},
): LegacyProfileReadResult {
  const diagnostics: string[] = []
  const normalizedCwd = resolve(cwd)
  const homeDirectory = resolve(options.homeDirectory ?? homedir())
  const files = [
    join(homeDirectory, '.pi', 'agent', 'agents.json'),
    join(normalizedCwd, '.pi', 'agents.json'),
  ]
  const profiles: Record<string, LegacyProfileConversion> = {}
  for (const file of files) {
    if (!existsSync(file)) continue
    try {
      Object.assign(profiles, parseLegacyProfiles(JSON.parse(readFileSync(file, 'utf8')) as unknown, file, diagnostics))
    } catch {
      diagnostics.push(`Ignored unreadable legacy profile file ${file}`)
    }
  }
  return {
    source: 'legacy-filesystem',
    authority: 'read-only-fallback',
    profiles,
    files,
    diagnostics,
  }
}

/**
 * Produces a Pi-shaped read-only fallback from a legacy conversion. This is
 * not an `AgentRuntime` and must not be used for tool authorization.
 */
export function legacyProfileToPiConfiguration(conversion: LegacyProfileConversion): {
  source: 'legacy-filesystem'
  authority: 'read-only-fallback'
  agentName: string
  profile: PiAgentProfile
} {
  return {
    source: conversion.source,
    authority: conversion.authority,
    agentName: conversion.name,
    profile: conversion.profile,
  }
}
