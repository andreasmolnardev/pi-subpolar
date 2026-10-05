import { describe, expect, it, vi } from 'vitest'
import type PocketBase from 'pocketbase'
import { agentTemplateDefaults, evaluateAgentToolPolicy, listToolsForAgent, describeToolForAgent, searchToolsForAgent, createCoreToolGateway, type AgentDefinition, type ToolDefinition } from '../application/tools/tools.ts'
import { createMcpAdapter, type McpTransport } from '../application/tools/mcp-adapter.ts'
import { compareRegistrySnapshots } from '../application/tools/registry-comparison.ts'
import { proposeTools } from '../application/tools/tools-teach.ts'
import { handleExtensionsRoute } from '../routes/extensions.ts'


function agent(template?: 'plan' | 'reviewer'): AgentDefinition {
  return {
    id: 'agent-1', user_id: 'owner', name: template ?? 'builder', description: '', mode: 'primary', prompt: '', system_prompt: '', enabled: true,
    model: '', thinking: 'off', approval_mode: 'auto', policies: { builtin: {}, registered: {}, browser: true, memory: true, subagent: false },
    project_overrides: {}, tool_context_modes: {}, skill_context_modes: {},
    effective_source: { model: 'agent', thinking: 'agent', approval: 'agent', tools: 'agent', skills: 'agent' },
    ...(template ? { ...agentTemplateDefaults(template), template } : {}),
  }
}
function tool(id = 'acme/lookup', overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return { tool_id: id, namespace: 'acme', description: 'Lookup', adapter: 'openapi', target: 'https://example.test', operation: 'lookup', input_schema: { type: 'object' }, output_schema: {}, risk: 'read', requires_approval: false, enabled: true, metadata: {}, ...overrides }
}
function database(profile: AgentDefinition, tools: ToolDefinition[], policies: Array<{ tool_id: string; effect: string }>) {
  return { collection(name: string) { return {
    async getFirstListItem(filter: string) {
      if (name === 'agents') return profile
      if (name === 'tool_registry') return tools.find((item) => item.tool_id === /^tool_id = "([^"]+)"/.exec(filter)?.[1])
      throw new Error(name)
    },
    async getFullList() { if (name === 'agent_tool_policies') return policies; if (name === 'tool_registry') return tools; throw new Error(name) },
  } } } as unknown as PocketBase
}

describe('registry discovery policy parity', () => {
  it('keeps owner-private tools out of discovery and gateway definitions', async () => {
    const own = { ...tool('acme/own'), owner_id: 'owner' }
    const shared = tool('acme/shared')
    const foreign = { ...tool('acme/foreign'), owner_id: 'another-user' }
    const client = database(agent(), [own, shared, foreign], [{ tool_id: '*', effect: 'allow' }])
    expect((await listToolsForAgent(client, 'owner', 'builder')).map((item) => item.id)).toEqual(['acme/own', 'acme/shared'])
    const gateway = await createCoreToolGateway(client, 'owner')
    expect(gateway.tools.map((item) => item.id)).toEqual(['acme/own', 'acme/shared'])
    expect(gateway.lookup('acme/foreign')).toBeUndefined()
    await expect(gateway.call({ callId: 'foreign-call', toolId: 'acme/foreign', input: {} }, {
      requestId: 'test', principal: { id: 'owner', kind: 'user' }, agentId: 'builder', sessionId: 'session',
    })).resolves.toMatchObject({ ok: false, status: 'unknown_tool', error: { code: 'UNKNOWN_TOOL' } })
    expect(await describeToolForAgent(client, 'owner', 'builder', 'acme/own')).toMatchObject({ id: 'acme/own' })
    expect(await describeToolForAgent(client, 'owner', 'builder', 'acme/shared')).toMatchObject({ id: 'acme/shared' })
    expect(await describeToolForAgent(client, 'owner', 'builder', 'acme/foreign')).toBeNull()
    expect((await searchToolsForAgent(client, 'owner', 'builder', 'lookup')).map((item) => item.tool).sort()).toEqual(['acme/own', 'acme/shared'])
    expect(await searchToolsForAgent(client, 'owner', 'builder', 'foreign')).toEqual([])
  })
  it('honors wildcard grants and denies using the same decision as execution', async () => {
    const profile = agent()
    const definition = tool()
    const grants = [{ tool_id: '*', effect: 'approval' }]
    expect(evaluateAgentToolPolicy(profile, definition, grants)).toMatchObject({ allow: true, requiresApproval: true })
    expect(await listToolsForAgent(database(profile, [definition], grants), 'owner', 'builder')).toMatchObject([{ id: definition.tool_id, requiresApproval: true }])
    const denies = [...grants, { tool_id: definition.tool_id, effect: 'deny' }]
    expect(await listToolsForAgent(database(profile, [definition], denies), 'owner', 'builder')).toEqual([])
    expect(await listToolsForAgent(database(profile, [definition], grants), 'owner', 'builder', undefined, true, 'none')).toEqual([])
  })
  it('projects effective visibility rather than registry visibility and permits explicit on-demand inspection', async () => {
    const profile = agent()
    profile.tool_context_modes['acme/lookup'] = 'on-demand'
    const client = database(profile, [tool(undefined, { context_mode: 'always' })], [{ tool_id: '*', effect: 'allow' }])
    expect(await listToolsForAgent(client, 'owner', 'builder')).toEqual([])
    expect(await describeToolForAgent(client, 'owner', 'builder', 'acme/lookup')).toMatchObject({ contextMode: 'on-demand', inputSchema: { type: 'object' } })
  })
  it('does not permit a project to increase visibility', async () => {
    const profile = agent()
    profile.tool_context_modes['acme/lookup'] = 'discoverable'
    profile.project_overrides.project = { tools: { 'acme/lookup': 'disabled' } }
    const client = database(profile, [tool()], [{ tool_id: '*', effect: 'allow' }])
    expect(await listToolsForAgent(client, 'owner', 'builder', 'project', true)).toEqual([])
  })
  it('reports manual approval and session ask, and denies agent-wide deny', () => {
    const profile = agent()
    const grants = [{ tool_id: '*', effect: 'allow' }]
    expect(evaluateAgentToolPolicy(profile, tool(), grants, 'ask')).toMatchObject({ requiresApproval: true })
    expect(evaluateAgentToolPolicy({ ...profile, name: 'master' }, tool('create_registered_tool', { target: 'tool-management' }), grants, 'allow_all')).toMatchObject({ requiresApproval: true })
    expect(evaluateAgentToolPolicy({ ...profile, approval_mode: 'deny' }, tool(), grants, 'allow_all')).toMatchObject({ deny: true })
  })
})

for (const template of ['plan', 'reviewer'] as const) {
  describe(`${template} capabilities (independent regression)`, () => {
    it('allows granted read capabilities but not disabled file writes or memory mutations', () => {
      const profile = agent(template)
      const grants = [{ tool_id: '*', effect: 'allow' }]
      expect(evaluateAgentToolPolicy(profile, tool('read'), grants)).toMatchObject({ allow: true })
      expect(evaluateAgentToolPolicy(profile, tool('write', { risk: 'write' }), grants, 'allow_all')).toMatchObject({ deny: true })
      profile.policies.memory = true
      profile.tool_context_modes['memory/write'] = 'always'
      expect(evaluateAgentToolPolicy(profile, tool('memory/write'), grants, 'allow_all')).toMatchObject({ deny: true })
    })
  })
}

function route(path: string, deps: Record<string, unknown>, authenticatedUser: unknown = { id: 'owner' }) {
  const url = new URL(`http://localhost/api/extensions/${path}`)
  return handleExtensionsRoute({ request: new Request(url.toString()), url, path: url.pathname.split('/').filter(Boolean), authenticatedUser,
    deps: { json: (value: unknown, status = 200) => Response.json(value, { status }), ...deps },
  } as never)
}
describe('extension discovery context', () => {
  it('uses only owned session context including project and permission', async () => {
    const list = vi.fn(async () => [])
    const response = await route('tools?sessionId=s', {
      applicationDatabase: async () => ({}), ownedSessionRecord: async () => ({ id: 's' }),
      resolveToolSessionContext: async () => ({ agentName: 'reviewer', project: { id: 'p' }, permission: { source: 'session' }, permissionOverride: 'none' }),
      listToolsForAgent: list, sendRpc: async () => ({ commands: [] }),
    })
    expect(response?.status).toBe(200)
    expect(list).toHaveBeenCalledWith({}, 'owner', 'reviewer', 'p', true, 'none')
  })
  it('does not convert resolver default permission into a session override', async () => {
    const list = vi.fn(async () => [])
    await route('tools?sessionId=s', { applicationDatabase: async () => ({}), ownedSessionRecord: async () => ({ id: 's' }),
      resolveToolSessionContext: async () => ({ agentName: 'builder', permission: { source: 'default' }, permissionOverride: 'ask' }), listToolsForAgent: list, sendRpc: async () => ({}) })
    expect(list).toHaveBeenCalledWith({}, 'owner', 'builder', undefined, true, undefined)
  })
  it('rejects foreign sessions and unauthenticated OpenAPI discovery before listing', async () => {
    const list = vi.fn()
    expect((await route('tools?sessionId=foreign', { applicationDatabase: async () => ({}), ownedSessionRecord: async () => null, listToolsForAgent: list }))?.status).toBe(404)

    expect((await route('openapi-tools', { openApiProviders: list }, null))?.status).toBe(401)
    expect(list).not.toHaveBeenCalled()
  })
})

describe('MCP connection lifecycle', () => {
  it('deduplicates pending connects, drains shutdown, rejects late clients and reconnects cleanly', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const transports: McpTransport[] = []
    const adapter = createMcpAdapter({ transportFactory: () => {
      const transport: McpTransport = { kind: 'stdio', start: vi.fn(async () => { await gate }),
        request: vi.fn(async (request) => ({ jsonrpc: '2.0' as const, id: request.id, result: {} })), notify: vi.fn(async () => {}), close: vi.fn(async () => {}) }
      transports.push(transport)
      return transport
    } })
    const config = { ownerId: 'owner', transport: 'stdio' as const, command: 'fake', protocolVersion: '2025-06-18' }
    const first = adapter.connect(config)
    const duplicate = adapter.connect(config)
    const settled = Promise.allSettled([first, duplicate])
    const closing = adapter.close()
    await expect(adapter.connect(config)).rejects.toThrow(/closing/)
    release()
    await closing
    expect((await settled).map((result) => result.status)).toEqual(['rejected', 'rejected'])
    expect(transports).toHaveLength(1)
    expect(transports[0].close).toHaveBeenCalledOnce()
    await adapter.connect(config)
    expect(transports).toHaveLength(2)
    await adapter.close()
    expect(transports[1].close).toHaveBeenCalledOnce()
  })
  it('closes a failed initialization transport and permits retry', async () => {
    const close = vi.fn(async () => {})
    const adapter = createMcpAdapter({ transportFactory: () => ({ kind: 'stdio', start: async () => { throw new Error('failed') }, request: vi.fn(), notify: vi.fn(), close }) })
    const config = { transport: 'stdio' as const, command: 'fake', protocolVersion: '2025-06-18' }
    await expect(adapter.connect(config)).rejects.toThrow()
    await expect(adapter.connect(config)).rejects.toThrow()
    expect(close).toHaveBeenCalledTimes(2)
    await adapter.close()
  })
})

const spec = { openapi: '3.0.0', paths: { '/items': {
  parameters: [{ name: 'q', in: 'query', required: true, schema: { type: 'string' } }],
  get: { operationId: 'lookup', parameters: [{ name: 'q', in: 'query', required: false, schema: { type: 'integer' } }], responses: {} },
  post: { operationId: 'create', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { title: { type: 'string' } } } } } }, responses: {} },
} } }
describe('selective OpenAPI drafts', () => {
  it('selects only requested operations and preserves overridden parameter schema without sending requests', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch')
    try {
      const result = await proposeTools({ kind: 'openapi', goal: 'lookup', openapi: { spec, url: 'https://example.test', operations: ['lookup'] } })
      expect(result.drafts).toHaveLength(1)
      expect(result.drafts[0]).toMatchObject({ operation: 'lookup', enabled: false, input_schema: { properties: { q: { type: 'integer' } }, additionalProperties: false } })
      expect(result.drafts[0].input_schema.required).toBeUndefined()
      expect(result.drafts[0].metadata.parameters).toEqual([{ name: 'q', in: 'query', required: false }])
      expect(fetch).not.toHaveBeenCalled()
    } finally { fetch.mockRestore() }
  })
  it('fails closed for unknown selections and respects an explicitly empty selection', async () => {
    await expect(proposeTools({ kind: 'openapi', goal: 'x', openapi: { spec, url: 'https://example.test', operations: ['unknown'] } })).rejects.toThrow(/unknown operation/)
    expect((await proposeTools({ kind: 'openapi', goal: 'x', openapi: { spec, url: 'https://example.test', operations: [] } })).drafts).toEqual([])
    const result = await proposeTools({ kind: 'openapi', goal: 'create', openapi: { spec, url: 'https://example.test', operations: ['create'] } })
    expect(result.drafts[0].input_schema.required).toContain('body')
  })
})

describe('local read-only comparison (not a Jev backend)', () => {
  it('is deterministic, does not mutate snapshots and returns differences without schema values', () => {
    const left = [{ id: 'acme/lookup', description: 'Lookup', inputSchema: { type: 'object', properties: { q: { type: 'string' } } }, requiresApproval: false, contextMode: 'discoverable' }]
    const snapshot = JSON.stringify(left)
    const equivalent = [{ ...left[0], inputSchema: { properties: { q: { type: 'string' } }, type: 'object' } }]
    expect(compareRegistrySnapshots(left, equivalent).changed).toEqual([])
    const right = [{ ...left[0], requiresApproval: true }, { ...left[0], id: 'acme/new' }]
    expect(compareRegistrySnapshots(left, right)).toEqual({ mode: 'registry-dry-run', onlyLeft: [], onlyRight: ['acme/new'], changed: [{ id: 'acme/lookup', fields: ['requiresApproval'] }] })
    expect(JSON.stringify(left)).toBe(snapshot)
    expect(() => compareRegistrySnapshots(left, [...right, right[0]])).toThrow(/unique/)
  })
})
