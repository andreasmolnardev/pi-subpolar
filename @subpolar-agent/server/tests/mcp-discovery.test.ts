import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import type PocketBase from 'pocketbase'
import { createCoreToolGateway, invokeExternalTool, searchToolsForAgent, type AgentDefinition, type ToolDefinition } from '../application/tools/tools.ts'
import { discoverMcpServer, type McpDiscoveryInput } from '../application/tools/mcp-discovery.ts'

const exposedTools = [{
  name: 'homeassistant.turn_on',
  description: 'Turn on an entity in Home Assistant',
  inputSchema: { type: 'object', properties: { entity_id: { type: 'string' } }, required: ['entity_id'] },
}]

async function withMcpServer(handler: (request: { headers: Headers }, body: Record<string, unknown>) => Response | Promise<Response>) {
  const requests: Array<{ request: { headers: Headers }; body: Record<string, unknown> }> = []
  const server: Server = createServer(async (incoming, outgoing) => {
    const chunks: Uint8Array[] = []
    for await (const chunk of incoming) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
    const requestHeaders: [string, string][] = []
    for (const [name, value] of Object.entries(incoming.headers)) {
      if (typeof value === 'string') requestHeaders.push([name, value])
      else if (Array.isArray(value)) requestHeaders.push([name, value.join(', ')])
    }
    const request = { headers: new Headers(requestHeaders) }
    requests.push({ request, body })
    try {
      const response = await handler(request, body)
      outgoing.writeHead(response.status, Object.fromEntries(response.headers.entries()))
      outgoing.end(await response.text())
    } catch {
      outgoing.writeHead(500)
      outgoing.end('test server failed')
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Test MCP server did not bind')
  return {
    requests,
    url: `http://127.0.0.1:${address.port}/mcp`,
    async close() { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) },
  }
}

function jsonRpc(body: Record<string, unknown>, result: unknown) {
  return Response.json({ jsonrpc: '2.0', id: body.id, result })
}

function discoveryDefinition(): ToolDefinition {
  return {
    tool_id: 'discover-mcp', namespace: 'builtin', description: 'Temporarily inspect an MCP server', adapter: 'internal', target: 'mcp-discovery', operation: 'discover',
    input_schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'], additionalProperties: false }, output_schema: {},
    risk: 'external', requires_approval: true, enabled: true, metadata: {},
  }
}

function agent(): AgentDefinition {
  return {
    id: 'agent-1', user_id: 'owner', name: 'builder', description: '', mode: 'primary', prompt: '', system_prompt: '', enabled: true,
    model: '', thinking: 'off', approval_mode: 'auto', policies: { builtin: {}, registered: {}, browser: false, memory: false, subagent: false },
    project_overrides: {}, tool_context_modes: {}, skill_context_modes: {}, effective_source: { model: 'agent', thinking: 'agent', approval: 'agent', tools: 'agent', skills: 'agent' },
  }
}

function database(tools: ToolDefinition[]) {
  const creates: string[] = []
  const client = { collection(name: string) { return {
    async getFullList() {
      if (name === 'tool_registry') return tools
      if (name === 'agent_tool_policies') return [{ tool_id: '*', effect: 'allow' }]
      throw new Error(`Unexpected collection ${name}`)
    },
    async getFirstListItem() { if (name === 'agents') return agent(); throw new Error(`Unexpected collection ${name}`) },
    async create() { creates.push(name); return {} },
  } } } as unknown as PocketBase
  return { client, creates }
}

describe('agent-facing ephemeral MCP discovery', () => {
  it('inspects an unregistered server through the MCP adapter and preserves tool schemas', async () => {
    const server = await withMcpServer((_request, body) => jsonRpc(body, { tools: exposedTools }))
    try {
      const result = await invokeExternalTool({} as PocketBase, discoveryDefinition(), { url: server.url, transport: 'streamable-http' }, '', 'call', { userId: 'owner', agentName: 'builder' })
      expect(result).toEqual({
        endpoint: server.url,
        transport: 'streamable-http',
        status: 'success',
        tools: [{ name: exposedTools[0]!.name, description: exposedTools[0]!.description, inputSchema: exposedTools[0]!.inputSchema }],
      })
      expect(server.requests.map(({ body }) => body.method)).toEqual(['tools/list'])
    } finally { await server.close() }
  })

  it('supports the adapter\'s legacy SSE transport without invoking advertised tools', async () => {
    const methods: string[] = []
    const server: Server = createServer((incoming: IncomingMessage, outgoing: ServerResponse) => {
      if (incoming.method === 'GET') {
        outgoing.writeHead(200, { 'content-type': 'text/event-stream', connection: 'keep-alive' })
        outgoing.write('event: endpoint\ndata: /message\n\n')
        return
      }
      const chunks: Uint8Array[] = []
      incoming.on('data', (chunk: Uint8Array) => chunks.push(chunk))
      incoming.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
        methods.push(String(body.method))
        outgoing.writeHead(200, { 'content-type': 'application/json' })
        const result = body.method === 'initialize' ? {} : { tools: exposedTools }
        outgoing.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }))
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Test SSE MCP server did not bind')
    try {
      const result = await discoverMcpServer({ url: `http://127.0.0.1:${address.port}/sse`, transport: 'sse' })
      expect(result.tools[0]?.name).toBe('homeassistant.turn_on')
      expect(methods).toEqual(['initialize', 'notifications/initialized', 'tools/list'])
    } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) }
  })

  it('keeps discoveries out of tool search and normal resolver calls', async () => {
    const { client, creates } = database([discoveryDefinition()])
    const matches = await searchToolsForAgent(client, 'owner', 'builder', 'homeassistant.turn_on')
    expect(matches).toEqual([])
    const gateway = await createCoreToolGateway(client, 'owner')
    expect(gateway.lookup('discover-mcp')).toBeDefined()
    expect(gateway.lookup('homeassistant.turn_on')).toBeUndefined()
    await expect(gateway.call({ callId: 'unregistered-call', toolId: 'homeassistant.turn_on', input: {} }, {
      requestId: 'request', principal: { id: 'owner', kind: 'user' }, agentId: 'builder', sessionId: 'session',
    })).resolves.toMatchObject({ ok: false, status: 'unknown_tool' })
    expect(creates).not.toContain('tool_registry')
    expect(creates).not.toContain('integrations')
  })

  it('rejects unreachable and malformed endpoints without exposing endpoint details', async () => {
    const closed = await withMcpServer((_request, body) => jsonRpc(body, { tools: [] }))
    const url = closed.url
    await closed.close()
    await expect(discoverMcpServer({ url })).rejects.toThrow(/MCP_CONNECTION_ERROR/)

    const malformed = await withMcpServer(() => new Response('not-json', { headers: { 'content-type': 'application/json' } }))
    try { await expect(discoverMcpServer({ url: malformed.url })).rejects.toThrow(/MCP_PROTOCOL_ERROR/) } finally { await malformed.close() }
  })

  it('applies a bounded request timeout', async () => {
    const server = await withMcpServer(async (_request, body) => {
      await new Promise((resolve) => setTimeout(resolve, 300))
      return jsonRpc(body, { tools: [] })
    })
    try { await expect(discoverMcpServer({ url: server.url, timeoutMs: 100 })).rejects.toThrow(/MCP_TIMEOUT/) } finally { await server.close() }
  })

  it('uses environment-backed authentication ephemerally without returning or logging credentials', async () => {
    const secret = 'discovery-test-secret-value'
    const key = 'SUBPOLAR_MCP_DISCOVERY_TEST_TOKEN'
    process.env[key] = `Bearer ${secret}`
    let receivedAuthorization: string | null = null
    const server = await withMcpServer((request, body) => {
      receivedAuthorization = request.headers.get('authorization')
      return jsonRpc(body, { tools: exposedTools })
    })
    const log = vi.spyOn(console, 'log')
    const error = vi.spyOn(console, 'error')
    try {
      const result = await discoverMcpServer({ url: server.url, headers: { Authorization: { env: key } } })
      expect(receivedAuthorization).toBe(`Bearer ${secret}`)
      expect(JSON.stringify(result)).not.toContain(secret)
      expect(log.mock.calls.flat().join(' ')).not.toContain(secret)
      expect(error.mock.calls.flat().join(' ')).not.toContain(secret)
    } finally {
      delete process.env[key]
      log.mockRestore()
      error.mockRestore()
      await server.close()
    }
  })

  it('rejects embedded URL credentials, query secrets, and unsupported schemes', async () => {
    const cases: McpDiscoveryInput[] = [
      { url: 'http://user:password@example.test/mcp' },
      { url: 'http://example.test/mcp?token=secret' },
      { url: 'file:///tmp/mcp' },
    ]
    for (const input of cases) await expect(discoverMcpServer(input)).rejects.toThrow()
  })

  it('supports registered MCP invocation through the existing tool path unchanged', async () => {
    const server = await withMcpServer((_request, body) => body.method === 'tools/call'
      ? jsonRpc(body, { content: [{ type: 'text', text: 'called' }] })
      : jsonRpc(body, { tools: exposedTools }))
    const registered: ToolDefinition = {
      tool_id: 'homeassistant/turn_on', namespace: 'homeassistant', description: 'Turn on', adapter: 'mcp', target: server.url, operation: 'homeassistant.turn_on',
      input_schema: exposedTools[0]!.inputSchema, output_schema: {}, risk: 'read', requires_approval: false, enabled: true,
      metadata: { transport: 'http', networkPolicy: { allowPrivateHosts: true } },
    }
    const priorPrivateNetworkSetting = process.env.SUBPOLAR_NETWORK_ALLOW_PRIVATE_HOSTS
    process.env.SUBPOLAR_NETWORK_ALLOW_PRIVATE_HOSTS = 'true'
    try {
      const result = await invokeExternalTool({} as PocketBase, registered, { entity_id: 'light.kitchen' }, '', 'call', { userId: 'owner', agentName: 'builder' })
      expect(result).toMatchObject({ content: [{ text: 'called' }], details: { isError: false } })
      expect(server.requests.map(({ body }) => body.method)).toEqual(['tools/call'])
    } finally {
      if (priorPrivateNetworkSetting === undefined) delete process.env.SUBPOLAR_NETWORK_ALLOW_PRIVATE_HOSTS
      else process.env.SUBPOLAR_NETWORK_ALLOW_PRIVATE_HOSTS = priorPrivateNetworkSetting
      await server.close()
    }
  })
})
