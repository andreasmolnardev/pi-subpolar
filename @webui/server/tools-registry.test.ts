import { describe, expect, it } from 'bun:test'
import { canonicalToolId, manageAgentProfile, validateToolDefinition } from './tools.ts'

const definition = (overrides: Record<string, unknown> = {}) => ({
  tool_id: 'acme/read', namespace: 'acme', description: 'Read data', adapter: 'openapi' as const,
  target: 'https://example.test/api', operation: 'read', input_schema: { type: 'object' }, output_schema: {},
  risk: 'read' as const, requires_approval: false, enabled: true, metadata: {}, ...overrides,
})

describe('secure tool registry validation', () => {
  it('canonicalizes external dotted IDs and rejects malformed namespace/operations', () => {
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
})
