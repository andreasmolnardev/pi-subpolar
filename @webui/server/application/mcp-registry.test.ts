import { describe, expect, it } from 'bun:test'
import { normalizeMcpTools, resolveMcpToolReference } from './mcp-adapter.ts'
import { OPENAPI_DISCOVERY_LIMITS } from '../../subpolar/extensions/openapi-tools.ts'

describe('bounded external tool discovery', () => {
  it('rejects excess MCP tools and malformed schemas', () => {
    expect(() => normalizeMcpTools([{ name: 'one' }, { name: 'two' }], { maxTools: 1 })).toThrow(/limit/)
    expect(() => normalizeMcpTools([{ name: 'one', inputSchema: 'secret' }])).toThrow(/schema/)
  })

  it('rejects unsupported MCP targets and malformed operations', () => {
    expect(() => resolveMcpToolReference({ tool_id: 'mcp/x', namespace: 'mcp', target: 'ftp://example.test', operation: 'x' }, {})).toThrow()
    expect(() => resolveMcpToolReference({ tool_id: 'mcp/x', namespace: 'mcp', target: 'https://example.test', operation: 'Bad operation' }, {})).toThrow()
  })

  it('exposes bounded OpenAPI discovery limits', () => {
    expect(OPENAPI_DISCOVERY_LIMITS.maxProviders).toBeGreaterThan(0)
    expect(OPENAPI_DISCOVERY_LIMITS.maxOperations).toBeGreaterThan(OPENAPI_DISCOVERY_LIMITS.maxPaths)
  })
})
