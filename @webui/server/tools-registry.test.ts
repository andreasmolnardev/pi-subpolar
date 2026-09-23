import { describe, expect, it } from 'bun:test'
import { agentTemplateDefaults, canonicalToolId, executeCliTool, manageAgentProfile, manageRegisteredTool, requiresManualApproval, validateToolDefinition } from './tools.ts'

const definition = (overrides: Record<string, unknown> = {}) => ({
  tool_id: 'acme/read', namespace: 'acme', description: 'Read data', adapter: 'openapi' as const,
  target: 'https://example.test/api', operation: 'read', input_schema: { type: 'object' }, output_schema: {},
  risk: 'read' as const, requires_approval: false, enabled: true, metadata: {}, ...overrides,
})

describe('secure tool registry validation', () => {
  it('exposes only provider-neutral web capabilities by default', () => {
    expect(agentTemplateDefaults('general').tool_context_modes).toMatchObject({ 'web.search': 'always', 'web.fetch': 'always' })
    expect(agentTemplateDefaults('coding').tool_context_modes).toMatchObject({ 'web.search': 'always', 'web.fetch': 'always' })
  })

  it('canonicalizes legacy web search IDs and external dotted IDs', () => {
    expect(canonicalToolId('web-search')).toBe('web.search')
    expect(canonicalToolId('read', 'openapi', 'acme')).toBe('acme/read')
    expect(() => validateToolDefinition(definition({ tool_id: 'acme/read-now', operation: 'Read now' }))).toThrow()
    expect(() => validateToolDefinition(definition({ namespace: 'Acme' }))).toThrow()
  })

  it('rejects unsupported risk and non-object schemas', () => {
    expect(() => validateToolDefinition(definition({ risk: 'admin' }))).toThrow()
    expect(() => validateToolDefinition(definition({ input_schema: [] }))).toThrow()
    expect(() => validateToolDefinition(definition({ target: 'file:///secret' }))).toThrow()
  })

  it('redacts credential-bearing metadata and retains context mode', () => {
    const result = validateToolDefinition(definition({ context_mode: 'on-demand', metadata: { headers: { Authorization: 'Bearer secret', Accept: 'json' } } }))
    expect(result.context_mode).toBe('on-demand')
    expect(result.metadata.headers).toEqual({ Authorization: '[REDACTED]', Accept: 'json' })
  })

  it('supports owner-scoped profile CRUD without allowing master deletion', async () => {
    const records: Array<Record<string, unknown>> = [{ id: 'master-1', user_id: 'u1', name: 'master', enabled: true }]
    const collection = (name: string) => ({
      getFullList: async () => name === 'agents' ? records : [],
      getFirstListItem: async () => null,
      getOne: async (id: string) => records.find((record) => record.id === id) ?? null,
      create: async (input: Record<string, unknown>) => { const record = { id: `agent-${records.length}`, ...input }; records.push(record); return record },
      update: async (id: string, input: Record<string, unknown>) => { const record = records.find((item) => item.id === id); if (!record) throw new Error('missing'); Object.assign(record, input); return record },
      delete: async (id: string) => { const index = records.findIndex((record) => record.id === id); if (index >= 0) records.splice(index, 1) },
    })
    const client = { collection } as never
    const created = await manageAgentProfile(client, 'create', { name: 'reviewer', prompt: 'Review only' }, 'u1') as Record<string, unknown>
    expect(created.name).toBe('reviewer')
    const edited = await manageAgentProfile(client, 'edit', { agentId: created.id, description: 'Updated' }, 'u1') as Record<string, unknown>
    expect(edited.description).toBe('Updated')
    const listed = await manageAgentProfile(client, 'list', {}, 'u1') as Array<Record<string, unknown>>
    expect(listed.some((profile) => profile.id === created.id)).toBe(true)
    await expect(manageAgentProfile(client, 'delete', { agentId: 'master-1' }, 'u1')).rejects.toThrow('cannot be deleted')
    await manageAgentProfile(client, 'delete', { agentId: created.id }, 'u1')
    expect(records.some((profile) => profile.id === created.id)).toBe(false)
    expect(records.some((profile) => profile.name === 'master')).toBe(true)
  })

  it('supports owner-scoped registered tool CRUD and rejects internal tools', async () => {
    const records: Array<Record<string, unknown>> = []
    const collection = () => ({
      getFullList: async () => records,
      getFirstListItem: async (filter: string) => records.find((record) => filter.includes(`owner_id = \"${record.owner_id}\"`) && filter.includes(`tool_id = \"${record.tool_id}\"`)) ?? null,
      create: async (input: Record<string, unknown>) => { const record = { id: `tool-${records.length}`, ...input }; records.push(record); return record },
      update: async (id: string, input: Record<string, unknown>) => { const record = records.find((item) => item.id === id); if (!record) throw new Error('missing'); Object.assign(record, input); return record },
      delete: async (id: string) => { const index = records.findIndex((record) => record.id === id); if (index >= 0) records.splice(index, 1) },
    })
    const client = { collection } as never
    const created = await manageRegisteredTool(client, 'create', { ...definition({}), tool_id: 'acme/lookup', operation: 'lookup' }, 'u1') as Record<string, unknown>
    expect(created.tool_id).toBe('acme/lookup')
    const updated = await manageRegisteredTool(client, 'update', { tool_id: 'acme/lookup', description: 'Updated lookup' }, 'u1') as Record<string, unknown>
    expect(updated.description).toBe('Updated lookup')
    expect(await manageRegisteredTool(client, 'list', {}, 'u1')).toHaveLength(1)
    await expect(manageRegisteredTool(client, 'create', { ...definition({ adapter: 'internal', target: 'pi' }), tool_id: 'acme/internal', operation: 'read' }, 'u1')).rejects.toThrow('Only HTTP')
    await manageRegisteredTool(client, 'delete', { tool_id: 'acme/lookup' }, 'u1')
    expect(records).toHaveLength(0)
  })

  it('creates constrained CLI tools and rejects unsafe runtime arguments', async () => {
    const records: Array<Record<string, unknown>> = []
    const collection = () => ({
      getFullList: async () => records,
      getFirstListItem: async () => null,
      create: async (input: Record<string, unknown>) => { const record = { id: `tool-${records.length}`, ...input }; records.push(record); return record },
      update: async () => { throw new Error('unexpected update') },
      delete: async () => undefined,
    })
    const client = { collection } as never
    const created = await manageRegisteredTool(client, 'create-cli', { tool_id: 'local/bun-version', namespace: 'local', description: 'Bun version', executable: 'bun', fixed_args: ['--version'], max_args: 0 }, 'u1') as Record<string, unknown>
    expect(created.requires_approval).toBe(true)
    expect((created.metadata as Record<string, unknown>).cli).toMatchObject({ executable: 'bun', maxArgs: 0 })
    await expect(executeCliTool(created as never, { args: [';touch'] }, process.cwd())).rejects.toThrow('invalid')
    await expect(executeCliTool(created as never, { args: [] }, process.cwd())).resolves.toMatchObject({ exitCode: 0 })
    expect(requiresManualApproval('local/bun-version', 'cli')).toBe(true)
    expect(requiresManualApproval('create_cli_tool', 'tool-registry')).toBe(true)
    expect(requiresManualApproval('read', 'pi')).toBe(false)
  })
})
