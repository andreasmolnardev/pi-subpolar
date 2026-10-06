import { describe, expect, test } from 'bun:test'
import type PocketBase from 'pocketbase'
import { agentProfileToolEffect, agentTemplateDefaults, effectiveAgentConfiguration, evaluateAgentToolPolicy, type AgentDefinition, type ToolDefinition } from '../application/tools/tools.ts'
import { createOwnerBoundSkillStore } from '../persistence/subpolar-skill-store.ts'
import { handleSettingsRoute } from '../routes/settings.ts'
import { SkillConflictError, SkillNotFoundError, SkillValidationError } from '../../../packages/subpolar-contracts/src/index.ts'

function database() {
  const rows = new Map<string, any[]>()
  let sequence = 0
  const deleted: string[] = []
  const client = { collection(name: string) {
    if (!rows.has(name)) rows.set(name, [])
    const items = rows.get(name)!
    return {
      async getFullList() { return [...items] }, // Intentionally ignores filters.
      async getOne(id: string) { return items.find(row => row.id === id) },
      async create(data: any) { const row = { ...data, id: `${name}-${++sequence}` }; items.push(row); return row },
      async update(id: string, data: any) { const row = items.find(row => row.id === id); Object.assign(row, data); return row },
      async delete(id: string) { deleted.push(id); const index = items.findIndex(row => row.id === id); if (index >= 0) items.splice(index, 1) },
    }
  } } as unknown as PocketBase
  return { client, rows, deleted }
}
function agent(): AgentDefinition {
  return { id: 'a', user_id: 'alice', name: 'master', description: '', mode: 'primary', prompt: '', system_prompt: '', enabled: true,
    ...agentTemplateDefaults('general'), project_overrides: {}, tool_context_modes: {}, skill_context_modes: {},
    effective_source: { model: 'default', thinking: 'default', approval: 'default', tools: 'default', skills: 'default' } }
}
function tool(id: string): ToolDefinition {
  return { tool_id: id, namespace: 'builtin', description: '', adapter: 'internal', target: '', operation: '', input_schema: {}, output_schema: {}, risk: 'read', requires_approval: false, enabled: true, metadata: {} }
}
describe('security handoffs', () => {
  test('project policies intersect all capability ceilings and cannot create new grants', () => {
    const base = agent()
    base.policies.builtin = { read: false, write: true }
    base.policies.registered = { external: false, allowed: true }
    base.project_overrides.p = { policies: { memory: true, browser: true, subagent: true, builtin: { read: true, write: false, new: true }, registered: { external: true, allowed: false, new: true } } }
    const effective = effectiveAgentConfiguration(base, 'p')
    expect(effective.policies).toEqual({ memory: false, browser: false, subagent: false, builtin: { read: false, write: false }, registered: { external: false, allowed: false } })
    expect(base.policies.builtin.write).toBe(true)
    for (const id of ['memory/query', 'browser/read', 'subagent', 'read', 'write', 'external', 'allowed']) {
      effective.toolAccess = [{ id, permission: 'allow' }]
      expect(agentProfileToolEffect(effective, id)).toBe('deny')
      expect(evaluateAgentToolPolicy(effective, tool(id), [{ tool_id: '*', effect: 'allow' }], 'allow_all').deny).toBe(true)
    }
    base.policies.memory = base.policies.browser = base.policies.subagent = true
    base.project_overrides.p = { policies: { memory: false, browser: false, subagent: false } }
    expect(effectiveAgentConfiguration(base, 'p').policies).toMatchObject({ memory: false, browser: false, subagent: false })
    expect(effectiveAgentConfiguration(base).policies.memory).toBe(true)
  })
  test('shared runtime effect denies approval-deny and plan/reviewer memory mutation; legacy defaults remain', () => {
    const base = agent()
    expect(agentProfileToolEffect(base, 'read')).toBeUndefined()
    expect(evaluateAgentToolPolicy(base, tool('read'), []).allow).toBe(true)
    base.approval_mode = 'deny'
    expect(agentProfileToolEffect(base, 'read')).toBe('deny')
    for (const template of ['plan', 'reviewer'] as const) {
      base.approval_mode = 'auto'; base.template = template; base.policies.memory = true
      base.tool_context_modes = { 'memory/query': 'always', 'memory/write': 'always' }
      expect(agentProfileToolEffect(base, 'memory/query')).toBeUndefined()
      expect(agentProfileToolEffect(base, 'memory/write')).toBe('deny')
    }
  })
  test('scoped update cannot fall back; default CRUD and history select global; deletion rechecks unfiltered history', async () => {
    const db = database()
    const store = createOwnerBoundSkillStore(db.client, 'alice')
    const create = (scope: 'global' | 'agent', agentId?: string) => store.create('alice', { id: 'docs', name: 'docs', scope, agentId, mode: 'discoverable', body: scope + (agentId ?? '') })
    await create('agent', 'a')
    await expect(store.update('alice', { id: 'docs', scope: 'agent', agentId: 'wrong', version: 2, body: 'attack' })).rejects.toBeInstanceOf(SkillNotFoundError)
    await expect(store.delete('docs')).rejects.toBeInstanceOf(SkillNotFoundError)
    await create('global'); await create('agent', 'b')
    await expect(store.get('alice', 'docs', { scope: 'agent' })).rejects.toBeInstanceOf(SkillConflictError)
    await expect(store.update('alice', { id: 'docs', scope: 'agent', version: 2 })).rejects.toBeInstanceOf(SkillConflictError)
    await expect(store.delete('docs', { scope: 'agent' })).rejects.toBeInstanceOf(SkillConflictError)
    expect((await store.get('alice', 'docs', { version: 1 })).body).toBe('global')
    expect((await store.get('alice', 'docs', { scope: 'agent', agentId: 'b', version: 1 })).body).toBe('agentb')
    await store.update('alice', { id: 'docs', version: 2, body: 'global2' })
    const head = db.rows.get('skills')!.find(row => row.scope === 'global')
    const foreign = { ...db.rows.get('skill_versions')!.find(row => row.skillHeadId === head.id), id: 'foreign-history', ownerId: 'bob' }
    db.rows.get('skill_versions')!.push(foreign)
    await store.delete('docs')
    expect(db.deleted).not.toContain('foreign-history')
    expect((await store.list('alice')).map(row => row.agentId).sort()).toEqual(['a', 'b'])
    expect((await store.get('alice', 'docs', { scope: 'agent', agentId: 'a', version: 1 })).body).toBe('agenta')
  })
  test('settings reject invalid enums and foreign/missing references before scoped CRUD', async () => {
    const db = database()
    await db.client.collection('agents').create({ id: 'unused', user_id: 'bob' })
    const foreignAgent = db.rows.get('agents')![0].id
    let calls = 0
    const projects = [{ id: 'p', userId: 'alice' }, { id: 'foreign', userId: 'bob' }]
    const route = async (method: string, input: any = {}, query = '', detail = false) => {
      const url = new URL(`http://localhost/api/settings/skills${detail ? '/docs' : ''}${query}`)
      return handleSettingsRoute({ request: new Request(url.toString(), { method }), url, path: url.pathname.split('/').filter(Boolean), authenticatedUser: { id: 'alice' }, deps: {
        applicationDatabase: async () => db.client, createProjectSessionRepository: () => ({ getProject: async (_: string, id: string) => projects.find(p => p.id === id), listProjects: async () => projects }),
        createOwnerBoundSkillStore: () => ({ create: async (_: string, value: any) => { calls++; return { ...value, metadata: {}, version: 1 } }, list: async () => { calls++; return [] }, get: async () => { calls++; return { metadata: {} } }, update: async () => { calls++; return { metadata: {} } }, delete: async () => { calls++ } }),
        body: async () => input, json: (value: unknown, status = 200) => Response.json(value, { status }), redactedDiagnostic: () => '', SkillValidationError, SkillNotFoundError, SkillConflictError,
      } } as never)
    }
    for (const input of [{ scope: 'typo' }, { scope: 1 }, { mode: 'typo' }, { mode: null }, { agentId: foreignAgent }, { projectId: 'foreign' }, { projectId: 'missing' }, { repoId: 2 }, { repoId: 0 }]) {
      expect((await route('POST', { name: 'docs', ...input }))!.status).toBe(input.agentId || ['foreign', 'missing'].includes(input.projectId ?? '') || input.repoId === 2 ? 404 : 400)
    }
    for (const method of ['GET', 'PUT', 'DELETE']) {
      expect((await route(method, { version: 2 }, '?scope=typo', true))!.status).toBe(400)
      expect((await route(method, { version: 2 }, '?projectId=foreign', true))!.status).toBe(404)
    }
    expect(calls).toBe(0)
    expect((await route('POST', { name: 'docs', scope: 'project', repoId: 1 }))!.status).toBe(201)
    expect((await route('POST', { name: 'docs' }))!.status).toBe(201)
  })
})
