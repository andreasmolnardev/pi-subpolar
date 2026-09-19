import { describe, expect, it } from 'vitest'
import type PocketBase from 'pocketbase'
import {

  convertLegacyPiProfile,
  loadAgentRuntime,
  legacyProfileToPiConfiguration,

} from './agent-runtime.ts'
import { agentTemplateDefaults, agentToolContextMode, effectiveAgentConfiguration } from './tools.ts'

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

  it('converts legacy profiles as sanitized read-only data', () => {
    const conversion = convertLegacyPiProfile('legacy-builder', {
      systemPrompt: 'Legacy instructions',
      tools: ['read', 'subpolar-tools', 'create_agent_profile', 'not-a-tool'],
    })

    expect(conversion).toMatchObject({
      source: 'legacy-filesystem',
      authority: 'read-only-fallback',
      name: 'legacy-builder',
      profile: { systemPrompt: 'Legacy instructions', tools: ['read', 'subpolar-tools'] },
    })
    expect(legacyProfileToPiConfiguration(conversion!)).toMatchObject({
      source: 'legacy-filesystem',
      authority: 'read-only-fallback',
      agentName: 'legacy-builder',
    })
    expect(convertLegacyPiProfile('master', { systemPrompt: 'do not use' })).toBeUndefined()
  })
})
