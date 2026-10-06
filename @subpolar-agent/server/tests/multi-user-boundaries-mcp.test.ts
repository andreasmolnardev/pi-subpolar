import { describe, expect, it } from 'bun:test'
import { DefaultMcpAdapter, resolveMcpToolReference, type McpServerConfig, type McpTransport } from '../application/tools/mcp-adapter.ts'

function adapter() {
  const opened: McpServerConfig[] = []
  const closed: number[] = []
  const instance = new DefaultMcpAdapter({ transportFactory(config) {
    opened.push(config)
    const id = opened.length
    const transport: McpTransport = { kind: 'stdio', async start() {}, async notify() {}, async close() { closed.push(id) }, async request(request) {
      return { jsonrpc: '2.0', id: request.id, result: request.method === 'initialize' ? {} : request.method === 'tools/list' ? { tools: [] } : { content: [{ type: 'text', text: String(config.ownerId ?? id) }] } }
    } }
    return transport
  } })
  return { instance, opened, closed }
}

describe('multi-user MCP connection boundaries', () => {
  it('never reuses a global serverKey across owners or effective configurations', async () => {
    const { instance, opened, closed } = adapter()
    const config: McpServerConfig = { ownerId: 'alice', transport: 'stdio', command: 'test', serverKey: 'shared', headers: { Authorization: 'alice-secret' }, cwd: '/alice' }
    try {
      const alice = await instance.connect(config)
      expect(await instance.connect({ ...config, headers: { Authorization: 'alice-secret' } })).toBe(alice)
      expect(await instance.connect({ ...config, ownerId: 'bob' })).not.toBe(alice)
      expect(await instance.connect({ ...config, headers: { Authorization: 'rotated-secret' } })).not.toBe(alice)
      expect(await instance.connect({ ...config, cwd: '/bob' })).not.toBe(alice)
      expect(await instance.connect({ ...config, networkPolicy: { allowLoopback: true } })).not.toBe(alice)
      expect(opened).toHaveLength(5)
    } finally { await instance.close() }
    expect(closed).toHaveLength(5)
  })

  it('uses fresh connections when the caller supplies no trusted owner, including concurrent connects', async () => {
    const { instance, opened } = adapter()
    try {
      const config: McpServerConfig = { transport: 'stdio', command: 'test', serverKey: 'shared' }
      const [one, two] = await Promise.all([instance.connect(config), instance.connect(config)])
      expect(one).not.toBe(two)
      expect(await instance.connect(config)).not.toBe(one)
      expect(opened).toHaveLength(3)
    } finally { await instance.close() }
  })

  it('closes temporary clients after unscoped discovery and invocation', async () => {
    const { instance, opened, closed } = adapter()
    await instance.discover({ transport: 'stdio', command: 'test', serverKey: 'global' })
    await instance.invoke({ tool_id: 'mcp/read', namespace: 'mcp', target: 'test', operation: 'read' }, {})
    expect(opened).toHaveLength(2)
    expect(closed).toHaveLength(2)
    await instance.close()
    expect(closed).toHaveLength(2)
  })

  it('freezes resolved environment credentials and separates their rotation without logging raw material in cache identity', async () => {
    const { instance, opened } = adapter()
    const previous = process.env.MULTI_USER_MCP_TEST_SECRET
    try {
      process.env.MULTI_USER_MCP_TEST_SECRET = 'alice-secret'
      const config: McpServerConfig = { ownerId: 'alice', transport: 'stdio', command: 'test', headers: { Authorization: { env: 'MULTI_USER_MCP_TEST_SECRET' } } }
      const first = await instance.connect(config)
      process.env.MULTI_USER_MCP_TEST_SECRET = 'rotated-secret'
      expect(await instance.connect(config)).not.toBe(first)
      expect(opened[0]?.headers).toEqual({ Authorization: 'alice-secret' })
      expect(opened[1]?.headers).toEqual({ Authorization: 'rotated-secret' })
      const reference = { owner_id: 'alice', tool_id: 'mcp/read', namespace: 'mcp', target: 'test', operation: 'read', metadata: { ownerId: 'bob', mcp: { ownerId: 'bob' } } }
      expect(resolveMcpToolReference(reference).config.ownerId).toBe('alice')
      expect(resolveMcpToolReference({ ...reference, owner_id: undefined }).config.ownerId).toBeUndefined()
    } finally {
      if (previous === undefined) delete process.env.MULTI_USER_MCP_TEST_SECRET; else process.env.MULTI_USER_MCP_TEST_SECRET = previous
      await instance.close()
    }
  })
})
