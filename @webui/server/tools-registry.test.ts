import { describe, expect, it } from 'bun:test'
import { canonicalToolId, validateToolDefinition } from './tools.ts'

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
})
