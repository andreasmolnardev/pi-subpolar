import { describe, expect, it } from 'bun:test'
import { InMemorySkillRepository } from '../../../packages/subpolar-contracts/src/index.ts'
import { resolveSkillRuntimeContext, type AgentDefinition } from '../application/tools/tools.ts'

function agent(skill_context_modes: AgentDefinition['skill_context_modes'] = {}): AgentDefinition {
  return {
    id: 'agent-a', user_id: 'owner-a', name: 'builder', description: '', mode: 'primary', prompt: '', system_prompt: '',
    enabled: true, model: '', thinking: 'medium', approval_mode: 'auto', policies: { builtin: {}, registered: {}, browser: false, memory: false, subagent: false },
    project_overrides: {}, tool_context_modes: {}, skill_context_modes, effective_source: { model: 'default', thinking: 'default', approval: 'default', tools: 'default', skills: 'default' },
  }
}

describe('durable skill runtime context', () => {
  it('keeps owners and projects isolated, and exposes only metadata until explicit selection', async () => {
    const repository = new InMemorySkillRepository()
    await repository.create('owner-a', { id: 'docs', name: 'docs', scope: 'global', mode: 'discoverable', body: 'owner-a secret', metadata: { description: 'Owner A docs' } })
    await repository.create('owner-a', { id: 'docs', name: 'docs', scope: 'project', projectId: 'project-a', mode: 'always-loaded', body: 'project secret' })
    await repository.create('owner-b', { id: 'docs', name: 'docs', scope: 'global', mode: 'always-loaded', body: 'owner-b secret' })

    const audit: unknown[] = []
    const context = await resolveSkillRuntimeContext(repository, 'owner-a', agent(), { projectId: 'project-a', audit: (event) => { audit.push(event) } })
    expect(context[0]).toMatchObject({ id: 'docs', mode: 'always-loaded', body: 'project secret' })
    expect(JSON.stringify(audit)).not.toContain('secret')
    await expect(resolveSkillRuntimeContext(repository, 'owner-b', agent())).resolves.toMatchObject([{ body: 'owner-b secret' }])

    const selected = await resolveSkillRuntimeContext(repository, 'owner-a', agent({ docs: 'explicit-only' }), { projectId: 'project-a', explicitSkillIds: ['docs'] })
    expect(selected[0]?.body).toBe('project secret')
  })

  it('never lets project configuration increase an agent restriction', async () => {
    const repository = new InMemorySkillRepository()
    await repository.create('owner-a', { id: 'guide', name: 'guide', scope: 'global', mode: 'always-loaded', body: 'secret' })
    const result = await resolveSkillRuntimeContext(repository, 'owner-a', agent({ guide: 'discoverable' }))
    expect(result).toMatchObject([{ id: 'guide', mode: 'discoverable', body: '' }])
  })
})
