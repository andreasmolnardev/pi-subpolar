import { describe, expect, it } from 'vitest'
import type PocketBase from 'pocketbase'
import { InMemorySkillRepository } from '../../../packages/subpolar-contracts/src/index.ts'
import { loadAgentRuntime } from '../application/runtime/agent-runtime.ts'
import { agentTemplateDefaults, agentToolContextMode, effectiveAgentConfiguration } from '../application/tools/tools.ts'
import { listToolsForAgent } from '../application/tools/tools.ts'

type TestRecord = Record<string, unknown>

type TestData = {
  agent: TestRecord
  policies: TestRecord[]
  tools: TestRecord[]
}

function clientFor(data: TestData): PocketBase {
  return {
    collection(name: string) {
      return {
        async getFirstListItem() {
          if (name !== 'agents') throw new Error(`Unexpected getFirstListItem(${name})`)
          if (!data.agent) throw Object.assign(new Error('not found'), { status: 404 })
          return data.agent
        },
        async getFullList() {
          if (name === 'agent_tool_policies') return data.policies
          if (name === 'tool_registry') return data.tools
          throw new Error(`Unexpected getFullList(${name})`)
        },
      }
    },
  } as unknown as PocketBase
}

function baseData(overrides: Partial<TestData> = {}): TestData {
  return {
    agent: {
      id: 'agent_1',
      user_id: 'user_1',
      name: 'builder',
      mode: 'primary',
      prompt: 'Prefer small, safe changes.',
      systemPrompt: 'You are the builder agent.',
      enabled: true,
    },
    policies: [],
    tools: [],
    ...overrides,
  }
}

describe('PocketBase agent runtime adapter', () => {
  it('provides bounded template defaults and never lets a project increase exposure', () => {
    const plan = agentTemplateDefaults('plan')
    expect(plan.tool_context_modes.write).toBe('disabled')
    expect(plan.approval_mode).toBe('auto')
    const agent = {
      ...baseData().agent,
      template: 'plan',
      model: '',
      thinking: 'medium',
      approval_mode: 'auto',
      policies: plan.policies,
      project_overrides: { project_1: { tools: { write: 'always' } } },
      tool_context_modes: plan.tool_context_modes,
      skill_context_modes: {},
      effective_source: { model: 'template', thinking: 'template', approval: 'template', tools: 'template', skills: 'template' },
    }
    const effective = effectiveAgentConfiguration(agent as never, 'project_1')
    expect(agentToolContextMode(effective, 'write')).toBe('disabled')
    expect(effective.effective_source.tools).toBe('project')
  })

  it('projects owned agent prompts and policies into routed Pi tools', async () => {
    const runtime = await loadAgentRuntime(clientFor(baseData({
      policies: [
        { id: 'p_read', user_id: 'user_1', agent_id: 'agent_1', tool_id: 'read', effect: 'allow' },
        { id: 'p_write', user_id: 'user_1', agent_id: 'agent_1', tool_id: 'write', effect: 'approval' },
        { id: 'p_bash', user_id: 'user_1', agent_id: 'agent_1', tool_id: 'bash', effect: 'deny' },
        { id: 'p_external', user_id: 'user_1', agent_id: 'agent_1', tool_id: 'acme/lookup', effect: 'allow' }
      ],
      tools: [
        { id: 't_read', tool_id: 'read', namespace: 'builtin', enabled: true },
        { id: 't_write', tool_id: 'write', namespace: 'builtin', requires_approval: false, enabled: true },
        { id: 't_bash', tool_id: 'bash', namespace: 'builtin', enabled: true },
        { id: 't_external', tool_id: 'acme.lookup', namespace: 'acme', adapter: 'http', enabled: true },
      ],
    })), 'user_1', 'builder')

    expect(runtime.agent.name).toBe('builder')
    expect(runtime.systemPrompt).toBe('You are the builder agent.')
    expect(runtime.prompt).toBe('Prefer small, safe changes.')
    expect(runtime.toolPolicy.allowedToolIds).toEqual(['read', 'write', 'acme/lookup'])
    expect(runtime.toolPolicy.deniedToolIds).toEqual(['bash'])
    expect(runtime.toolPolicy.approvalToolIds).toEqual(['write'])
    expect(runtime.pi.profile).toEqual({
      systemPrompt: 'You are the builder agent.',
      tools: ['read', 'write', 'subpolar-tools'],
    })
    expect(runtime.pi.excludedToolNames).toEqual(['bash'])
  })

  it('routes profile-allowed web search through the external gateway', async () => {
    const runtime = await loadAgentRuntime(clientFor(baseData({
      agent: { ...baseData().agent, permission: { websearch: 'allow' } },
      tools: [{ id: 't_web_search', tool_id: 'web.search', namespace: 'builtin', enabled: true }],
    })), 'user_1', 'builder')

    expect(runtime.toolPolicy.allowedToolIds).toEqual(['web.search'])
    expect(runtime.pi.initialActiveToolNames).toContain('web_search')
  })

  it('lists profile-granted web search in debug and enables its Pi wrapper', async () => {
    const data = baseData({
      agent: { ...baseData().agent, name: 'researcher', toolAccess: [{ type: 'builtin', id: 'web.search', permission: 'allow' }] },
      tools: [{ id: 'web', tool_id: 'web.search', namespace: 'builtin', adapter: 'internal', description: 'Search', enabled: true, input_schema: {} }],
    })
    const runtime = await loadAgentRuntime(clientFor(data), 'user_1', 'researcher')
    expect(runtime.pi.allowedToolNames).toContain('web_search')
    const listed = await listToolsForAgent(clientFor(data), 'user_1', 'researcher')
    expect(listed.map((tool) => tool.id)).toContain('web.search')
  })

  it('renders durable skill metadata and bodies using repository and project precedence', async () => {
    const repository = new InMemorySkillRepository()
    await repository.create('user_1', {
      id: 'review-guidance', name: 'review-guidance', scope: 'global', mode: 'always-loaded',
      metadata: { description: 'Global guidance', secret: 'metadata-only' }, body: 'Global body',
    })
    await repository.create('user_1', {
      id: 'project-guidance', name: 'project-guidance', scope: 'project', projectId: 'project_1', mode: 'discoverable',
      metadata: { description: 'Project metadata' }, body: 'Project body',
    })

    const runtime = await loadAgentRuntime(clientFor(baseData({
      agent: { ...baseData().agent, id: 'agent_1', skill_context_modes: { 'project-guidance': 'always-loaded' } },
    })), 'user_1', 'builder', 'project_1', { skillRepository: repository })

    expect(runtime.skillContext).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'review-guidance', body: 'Global body', metadata: { description: 'Global guidance', secret: 'metadata-only' } }),
      expect.objectContaining({ id: 'project-guidance', body: '', mode: 'discoverable' }),
    ]))
    expect(runtime.systemPrompt).toContain('Global body')
    expect(runtime.systemPrompt).toContain('Project metadata')
  })

  it('renders only policy-accessible linked tool descriptions without changing runtime authority', async () => {
    const repository = new InMemorySkillRepository()
    await repository.create('user_1', {
      id: 'guide', name: 'guide', scope: 'global', mode: 'always-loaded', body: 'Use relevant tools carefully.',
      toolIds: ['acme/search', 'acme/secret', 'missing/tool'],
    })
    await repository.create('user_1', {
      id: 'discoverable-guide', name: 'discoverable-guide', scope: 'global', mode: 'discoverable', body: 'Not loaded yet.',
      toolIds: ['acme/search'],
    })
    const tools = [
      { id: 'tool_search', tool_id: 'acme/search', namespace: 'acme', adapter: 'http', target: 'https://example.test', operation: 'search', description: 'Search the authorized index', input_schema: { type: 'object' }, output_schema: {}, risk: 'external', requires_approval: true, enabled: true, owner_id: 'user_1' },
      { id: 'tool_secret', tool_id: 'acme/secret', namespace: 'acme', adapter: 'http', target: 'https://example.test', operation: 'secret', description: 'Must not be disclosed', input_schema: { type: 'object' }, output_schema: {}, risk: 'external', requires_approval: false, enabled: true, owner_id: 'user_1' },
    ]
    const data = baseData({
      agent: { ...baseData().agent, tool_context_modes: { 'acme/search': 'always', 'acme/secret': 'always' }, skill_context_modes: { guide: 'always-loaded' } },
      policies: [
        { id: 'allow-search', user_id: 'user_1', agent_id: 'agent_1', tool_id: 'acme/search', effect: 'approval' },
        { id: 'deny-secret', user_id: 'user_1', agent_id: 'agent_1', tool_id: 'acme/secret', effect: 'deny' },
      ],
      tools,
    })
    const runtime = await loadAgentRuntime(clientFor(data), 'user_1', 'builder', undefined, { skillRepository: repository })

    expect(runtime.systemPrompt).toContain('acme/search: Search the authorized index')
    expect(runtime.systemPrompt).not.toContain('Must not be disclosed')
    expect(runtime.systemPrompt).not.toContain('missing/tool')
    expect(runtime.systemPrompt).not.toContain('discoverable-guide tool references')
    expect(runtime.toolPolicy.allowedToolIds).toEqual(['acme/search'])
    expect(runtime.toolPolicy.deniedToolIds).toEqual(['acme/secret'])
    expect(runtime.toolPolicy.approvalToolIds).toEqual(['acme/search'])
    expect(runtime.pi.allowedToolNames).toEqual(['subpolar-tools'])

    const noHintsForSession = await loadAgentRuntime(clientFor(data), 'user_1', 'builder', undefined, { skillRepository: repository, permissionOverride: 'none' })
    expect(noHintsForSession.systemPrompt).not.toContain('acme/search: Search the authorized index')
    expect(noHintsForSession.pi.allowedToolNames).toEqual(runtime.pi.allowedToolNames)
  })

  it('explicit profile selection loads the Development Workflow skill instructions only', async () => {
    const repository = new InMemorySkillRepository()
    const { DEVELOPMENT_WORKFLOW_SKILL } = await import('../../../packages/subpolar-contracts/src/index.ts')
    await repository.create('user_1', DEVELOPMENT_WORKFLOW_SKILL)
    const runtime = await loadAgentRuntime(clientFor(baseData({
      agent: { ...baseData().agent, skill_context_modes: { 'development-workflow': 'explicit-only' } },
    })), 'user_1', 'builder', undefined, { skillRepository: repository })

    expect(runtime.systemPrompt).toContain('## Development workflow')
    expect(runtime.skillContext[0]).toMatchObject({ id: 'development-workflow', body: DEVELOPMENT_WORKFLOW_SKILL.body })
    expect(runtime.toolPolicy.allowedToolIds).toEqual([])
    expect(runtime.pi.allowedToolNames).toEqual([])
  })

  it('fails closed for an agent returned with another owner', async () => {
    const promise = loadAgentRuntime(clientFor(baseData({
      agent: { ...baseData().agent, user_id: 'other_user' },
    })), 'user_1', 'builder')

    await expect(promise).rejects.toMatchObject({ code: 'AGENT_NOT_OWNED' })
  })

  it('rejects disabled agents before loading policies or tools', async () => {
    const promise = loadAgentRuntime(clientFor(baseData({
      agent: { ...baseData().agent, enabled: false },
    })), 'user_1', 'builder')

    await expect(promise).rejects.toMatchObject({ code: 'AGENT_DISABLED' })
  })
})
