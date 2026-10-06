import { expect, it } from 'vitest'
import type PocketBase from 'pocketbase'
import { loadAgentRuntime } from '../application/runtime/agent-runtime.ts'
import { listToolsForAgent } from '../application/tools/tools.ts'

it('runtime exposure and discovery respect profile/project ceilings despite wildcard grants', async () => {
  const ids = ['read', 'memory/query', 'browser/read', 'subagent', 'acme/read']
  const agent: Record<string, unknown> = {
    id: 'a', user_id: 'alice', name: 'master', enabled: true, mode: 'primary',
    approval_mode: 'auto', policies: { memory: false, browser: false, subagent: false, builtin: { read: false }, registered: { 'acme/read': false } },
    tool_context_modes: Object.fromEntries(ids.map(id => [id, 'always'])),
    project_overrides: { p: { policies: { memory: true, browser: true, subagent: true, builtin: { read: true }, registered: { 'acme/read': true } } } },
  }
  const client = { collection(name: string) { return {
    async getFirstListItem() { return agent },
    async getFullList() {
      if (name === 'agent_tool_policies') return [{ user_id: 'alice', agent_id: 'a', tool_id: '*', effect: 'allow' }]
      if (name === 'tool_registry') return ids.map(tool_id => ({ tool_id, enabled: true, namespace: 'builtin', adapter: 'internal', target: 'pi', metadata: {} }))
      throw new Error(name)
    },
  } } } as unknown as PocketBase
  const runtime = await loadAgentRuntime(client, 'alice', 'master', 'p')
  expect(runtime.toolPolicy.allowedToolIds).toEqual([])
  expect(new Set(runtime.toolPolicy.deniedToolIds)).toEqual(new Set(ids))
  expect(await listToolsForAgent(client, 'alice', 'master', 'p', true, 'allow_all')).toEqual([])
  agent.policies = { memory: true, browser: true, subagent: true, builtin: {}, registered: {} }
  agent.project_overrides = { p: { tools: { read: 'disabled' } } }
  expect(new Set((await loadAgentRuntime(client, 'alice', 'master', 'p')).toolPolicy.allowedToolIds)).toEqual(new Set(ids.filter(id => id !== 'read')))
  agent.approval_mode = 'deny'
  agent.project_overrides = {}
  expect((await loadAgentRuntime(client, 'alice', 'master')).toolPolicy.allowedToolIds).toEqual([])
})
