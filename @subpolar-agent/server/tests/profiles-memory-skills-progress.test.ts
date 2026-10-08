import { describe, expect, test } from 'bun:test'
import type PocketBase from 'pocketbase'
import { createSessionContextResolver, type ProjectRecord, type AgentRecord, type SessionRecord } from '../application/session-context.ts'
import { handleAgentsRoute } from '../routes/agents.ts'
import { createOwnerBoundSkillStore } from '../persistence/subpolar-skill-store.ts'
import { PocketBaseMemoryService } from '../persistence/memory.ts'
import type { AgentDefinition, agentTemplateDefaults as TemplateDefaults } from '../application/tools/tools.ts'

// Deliberately returns unfiltered rows: consumers must still enforce owner/scope boundaries.
function database() {
  const rows = new Map<string, Record<string, any>[]>()
  const writes: string[] = []
  let sequence = 0
  const client = {
    collection(name: string) {
      if (!rows.has(name)) rows.set(name, [])
      const items = rows.get(name)!
      return {
        async getFullList() { return items.map((item) => ({ ...item })) },
        async getOne(id: string) { return items.find((item) => item.id === id) ?? null },
        async create(data: Record<string, unknown>) { writes.push(name); const item = { ...data, id: `record-${++sequence}` }; items.push(item); return item },
        async update(id: string, data: Record<string, unknown>) { writes.push(name); const item = items.find((item) => item.id === id)!; Object.assign(item, data); return item },
      }
    },
  } as unknown as PocketBase
  return { client, rows, writes }
}
const agent: AgentRecord = { id: 'agent-a', name: 'master', user_id: 'alice', enabled: true }
const project: ProjectRecord = { name: 'workspace', path: '/workspace', userId: 'alice' }
function resolver(overrides: { project?: ProjectRecord; agent?: AgentRecord; session?: SessionRecord } = {}) {
  return createSessionContextResolver({
    sessions: { getProject: () => overrides.project ?? project, getSession: () => overrides.session },
    agents: { getAgent: () => overrides.agent ?? agent },
    canonicalizePath: (path) => path,
  })
}
function definition(agentTemplateDefaults: typeof TemplateDefaults, template: AgentDefinition['template'] = 'general'): AgentDefinition {
  return { ...agent, description: '', mode: 'primary', prompt: '', system_prompt: '', enabled: true, template,
    ...agentTemplateDefaults(template), project_overrides: {},
    effective_source: { model: 'template', thinking: 'template', approval: 'template', tools: 'template', skills: 'template' },
  } as AgentDefinition
}
async function route(db: ReturnType<typeof database>, method: string, input?: unknown, id?: string, user = 'alice') {
  const url = new URL(`http://localhost/api/agents${id ? `/${id}` : ''}`)
  return handleAgentsRoute({ request: new Request(url.toString(), { method }), url, path: url.pathname.split('/').filter(Boolean), authenticatedUser: { id: user }, deps: {
    applicationDatabase: async () => db.client, ensureUserDefaults: async () => {}, body: async () => input,
    json: (value: unknown, status = 200) => Response.json(value, { status }), redactedDiagnostic: () => 'error',
  } } as never)
}

describe('profiles/memory/skills progress boundaries', () => {
  test('context defaults to ask and rejects cross-owner projects, agents, sessions and wrong selectors', async () => {
    expect((await resolver().resolve({ identity: 'alice', project: 'workspace' })).permissionOverride).toBe('ask')
    await expect(resolver({ project: { ...project, userId: 'bob' } }).resolve({ identity: 'alice', project: 'workspace' })).rejects.toMatchObject({ code: 'PROJECT_NOT_OWNED' })
    await expect(resolver({ agent: { ...agent, user_id: 'bob' } }).resolve({ identity: 'alice', project: 'workspace' })).rejects.toMatchObject({ code: 'AGENT_NOT_OWNED' })
    await expect(resolver().resolve({ identity: 'alice', project: 'workspace', agent: 'reviewer' })).rejects.toMatchObject({ code: 'INVALID_AGENT' })
    const session: SessionRecord = { id: 's', project: 'workspace', title: '', createdAt: 1, updatedAt: 1, userId: 'bob' }
    await expect(resolver({ session }).resolve({ identity: 'alice', sessionId: 's' })).rejects.toMatchObject({ code: 'SESSION_NOT_OWNED' })
    await expect(resolver({ agent: { ...agent, enabled: false } }).resolve({ identity: 'alice', project: 'workspace' })).rejects.toMatchObject({ code: 'AGENT_DISABLED' })
  })

  test('stored permissions cannot be elevated by request hints', async () => {
    for (const permissionOverride of ['ask', 'none', 'allow_all'] as const) {
      const context = resolver({ session: { id: 's', project: 'workspace', title: '', createdAt: 1, updatedAt: 1, userId: 'alice', profile: 'master', permissionOverride } })
      expect((await context.resolve({ identity: 'alice', sessionId: 's', agentId: agent.id })).permissionOverride).toBe(permissionOverride)
      const changed = permissionOverride === 'allow_all' ? 'ask' : 'allow_all'
      await expect(context.resolve({ identity: 'alice', sessionId: 's', permissionOverride: changed })).rejects.toMatchObject({ code: 'PERMISSION_MISMATCH' })
      await expect(context.resolve({ identity: 'alice', sessionId: 's', project: 'other' })).rejects.toMatchObject({ code: 'SESSION_PROJECT_MISMATCH' })
    }
  })

  test('profile writes preserve explicit primary/subagent configuration without granting opt-in policies', async () => {
    const db = database()
    for (const mode of ['primary', 'subagent']) {
      const response = await route(db, 'POST', { name: `profile-${mode}`, mode, template: 'reviewer', model: 'provider/model', skill_context_modes: { docs: 'explicit-only' } })
      expect(response?.status).toBe(201)
      expect(await response!.json()).toMatchObject({ user_id: 'alice', mode, template: 'reviewer', model: 'provider/model', skill_context_modes: { docs: 'explicit-only' } })
    }
    expect(db.rows.get('agents')!.every((item) => item.policies === undefined)).toBe(true)
    const id = db.rows.get('agents')![0].id
    const before = db.writes.length
    for (const method of ['PATCH', 'DELETE']) expect((await route(db, method, { name: 'stolen' }, id, 'bob'))?.status).toBe(404)
    expect(db.writes).toHaveLength(before)

  })

  test('malformed profile settings fail before persistence instead of silently broadening defaults', async () => {
    const db = database()
    const created = await route(db, 'POST', { name: 'valid' })
    const { id } = await created!.json() as { id: string }
    const before = db.writes.length
    for (const input of [ { name: '' }, { name: 'bad name' }, { mode: 'all' }, { policies: [] }, { policies: { memory: 'true' } }, { tool_context_modes: { write: 'typo' } }, { skill_context_modes: { docs: 'always' } }, { project_overrides: { p: { tools: { bash: 'typo' } } } } ]) {
      expect((await route(db, 'PATCH', input, id))?.status).toBe(400)
      expect((await route(db, 'POST', { name: 'new', ...input }))?.status).toBe(400)
    }
    expect(db.writes).toHaveLength(before)
  })

  test('memory defaults are opt-in and plan/reviewer are query-only', async () => {
    const { agentTemplateDefaults, memoryPolicyAllows } = await import('../application/tools/tools.ts')
    for (const template of ['general', 'coding', 'plan', 'reviewer'] as const) {
      const defaults = agentTemplateDefaults(template)
      expect(defaults.policies).toMatchObject({ memory: false, browser: false, subagent: false, registered: {} })
      expect(memoryPolicyAllows({ policies: defaults.policies, template }, 'memory/query')).toBe(false)
      if (template === 'plan' || template === 'reviewer') {
        expect(defaults.tool_context_modes.write).toBe('disabled')
        expect(memoryPolicyAllows({ policies: { memory: true }, template }, 'memory/query')).toBe(true)
        for (const tool of ['memory/write', 'memory/update', 'memory/delete']) expect(memoryPolicyAllows({ policies: { memory: true }, template }, tool)).toBe(false)
      }
    }
  })

  test('durable memory excludes cross-owner, agent and project reads and mutations', async () => {
    const db = database()
    const service = new PocketBaseMemoryService(db.client)
    const context = { ownerId: 'alice', agentId: 'agent-a', projectId: 'project-a' }
    const user = await service.write(context, { scope: 'user', content: 'user' })
    const scopedAgent = await service.write(context, { scope: 'agent', content: 'agent' })
    const scopedProject = await service.write(context, { scope: 'project', content: 'project' })
    expect((await service.query({ ...context, agentId: 'agent-b', projectId: 'project-b' }, {})).map((item) => item.id)).toEqual([user.id])
    expect(await service.query({ ...context, ownerId: 'bob' }, {})).toEqual([])
    for (const [record, foreign] of [[user, { ...context, ownerId: 'bob' }], [scopedAgent, { ...context, agentId: 'agent-b' }], [scopedProject, { ...context, projectId: 'project-b' }]] as const) {
      await expect(service.update(foreign, record.id, { version: 1, content: 'forged' })).rejects.toMatchObject({ code: 'MEMORY_SCOPE_DENIED' })
      await expect(service.tombstone(foreign, record.id, 1)).rejects.toMatchObject({ code: 'MEMORY_SCOPE_DENIED' })
    }
  })

  test('durable skill repository isolates owners and scopes across all four modes', async () => {
    const db = database()
    const store = createOwnerBoundSkillStore(db.client, 'alice')
    for (const mode of ['always-loaded', 'discoverable', 'explicit-only', 'disabled'] as const) await store.create('alice', { id: mode, name: mode, scope: 'global', mode, body: `${mode} body` })
    await store.create('alice', { id: 'agent-guide', name: 'agent-guide', scope: 'agent', agentId: 'other-agent', mode: 'always-loaded', body: 'foreign agent' })
    await store.create('alice', { id: 'project-guide', name: 'project-guide', scope: 'project', projectId: 'other-project', mode: 'always-loaded', body: 'foreign project' })
    await expect(store.list('bob')).rejects.toThrow('owner scope')
    expect(await createOwnerBoundSkillStore(db.client, 'bob').list('bob')).toEqual([])
    const resolved = await store.resolve('alice', { agentId: 'agent-a', projectId: 'project-a', explicitSkillIds: ['disabled', 'agent-guide', 'project-guide'] })
    expect(resolved.map((skill) => skill.id).sort()).toEqual(['always-loaded', 'discoverable'])
    expect(resolved.find((skill) => skill.id === 'always-loaded')?.body).toBe('always-loaded body')
    expect(resolved.find((skill) => skill.id === 'discoverable')?.body).toBe('')
    const explicit = await store.resolve('alice', { agentId: 'agent-a', projectId: 'project-a', explicitSkillIds: ['explicit-only', 'discoverable'] })
    expect(explicit.find((skill) => skill.id === 'explicit-only')?.body).toBe('explicit-only body')
  })

  test('durable skills isolate owners/agent/project scopes and expose bodies only according to mode', async () => {
    const { agentTemplateDefaults, effectiveAgentConfiguration, resolveSkillRuntimeContext } = await import('../application/tools/tools.ts')
    const db = database()
    const store = createOwnerBoundSkillStore(db.client, 'alice')
    for (const mode of ['always-loaded', 'discoverable', 'explicit-only', 'disabled'] as const) await store.create('alice', { id: mode, name: mode, scope: 'global', mode, body: `${mode} body` })
    await store.create('alice', { id: 'agent-guide', name: 'agent-guide', scope: 'agent', agentId: 'other-agent', mode: 'always-loaded', body: 'foreign agent' })
    await store.create('alice', { id: 'project-guide', name: 'project-guide', scope: 'project', projectId: 'other-project', mode: 'always-loaded', body: 'foreign project' })
    await expect(store.list('bob')).rejects.toThrow('owner scope')
    expect(await createOwnerBoundSkillStore(db.client, 'bob').list('bob')).toEqual([])
    const runtime = await resolveSkillRuntimeContext(store, 'alice', definition(agentTemplateDefaults), { projectId: 'project-a' })
    expect(runtime.map((skill) => skill.id).sort()).toEqual(['always-loaded', 'discoverable'])
    expect(runtime.find((skill) => skill.id === 'always-loaded')?.body).toBe('always-loaded body')
    expect(runtime.find((skill) => skill.id === 'discoverable')?.body).toBe('')
    const explicit = await resolveSkillRuntimeContext(store, 'alice', definition(agentTemplateDefaults), { projectId: 'project-a', explicitSkillIds: ['discoverable', 'explicit-only', 'disabled', 'agent-guide', 'project-guide'] })
    expect(explicit.map((skill) => skill.id).sort()).toEqual(['always-loaded', 'discoverable', 'explicit-only'])
    expect(explicit.find((skill) => skill.id === 'explicit-only')?.body).toBe('explicit-only body')
    const restricted = definition(agentTemplateDefaults)
    restricted.skill_context_modes = { 'always-loaded': 'disabled', discoverable: 'explicit-only' }
    expect(await resolveSkillRuntimeContext(store, 'alice', restricted, {})).toEqual([])
    restricted.project_overrides = { p: { tools: { write: 'always' }, skills: { 'always-loaded': 'always-loaded' } } }
    const effective = effectiveAgentConfiguration(restricted, 'p')
    expect(effective.skill_context_modes['always-loaded']).toBe('disabled')
    expect(effective.model).toBe(restricted.model)
    expect(effectiveAgentConfiguration(restricted, 'other')).toBe(restricted)
  })
})
