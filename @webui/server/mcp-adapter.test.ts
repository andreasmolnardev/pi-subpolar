import { describe, expect, it } from 'bun:test'
import { HttpMcpTransport, McpClient, type JsonRpcRequest, type JsonRpcResponse, type McpServerConfig, type McpTransport } from './mcp-adapter.ts'

class RecordingTransport implements McpTransport {
  readonly kind = 'stdio' as const
  readonly requests: JsonRpcRequest[] = []
  readonly notifications: string[] = []
  async start(): Promise<void> {}
  async request(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    this.requests.push(request)
    return { jsonrpc: '2.0', id: request.id, result: request.method === 'tools/list' ? { tools: [] } : { content: [] } }
  }
  async notify(method: string): Promise<void> { this.notifications.push(method) }
  async close(): Promise<void> {}
}

describe('MCP protocol versions', () => {
  it('uses 2026-07-28 stateless behavior by default', async () => {
    const transport = new RecordingTransport()
    const client = new McpClient(transport, { transport: 'stdio' })

    await client.listTools()

    expect(transport.requests.map(({ method }) => method)).toEqual(['tools/list'])
    expect(transport.notifications).toEqual([])
    expect(transport.requests[0]?.params?._meta).toMatchObject({
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    })
  })

  it('retains legacy initialize behavior when explicitly configured', async () => {
    const transport = new RecordingTransport()
    const client = new McpClient(transport, { transport: 'stdio', protocolVersion: '2025-06-18' })

    await client.listTools()

    expect(transport.requests.map(({ method }) => method)).toEqual(['initialize', 'tools/list'])
    expect(transport.notifications).toEqual(['notifications/initialized'])
    expect(transport.requests[1]?.params?._meta).toBeUndefined()
  })

  it('uses stateless per-request metadata on stdio for 2026-07-28', async () => {
    const transport = new RecordingTransport()
    const config: McpServerConfig = { transport: 'stdio', protocolVersion: '2026-07-28' }
    const client = new McpClient(transport, config, { clientName: 'test-client', clientVersion: '2.3.4' })

    await client.listTools()

    expect(transport.requests.map(({ method }) => method)).toEqual(['tools/list'])
    expect(transport.notifications).toEqual([])
    expect(transport.requests[0]?.params?._meta).toEqual({
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientInfo': { name: 'test-client', version: '2.3.4' },
      'io.modelcontextprotocol/clientCapabilities': {},
    })
  })

  it('mirrors 2026-07-28 request version and routing metadata to HTTP headers', async () => {
    const captured: Array<{ headers: Headers; body: JsonRpcRequest }> = []
    const fetch = (async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const bodyText = typeof init?.body === 'string' ? init.body : new TextDecoder().decode(init?.body as Uint8Array)
      const body = JSON.parse(bodyText) as JsonRpcRequest
      captured.push({ headers: new Headers(init?.headers), body })
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: body.method === 'tools/list' ? { tools: [] } : { content: [] } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof globalThis.fetch
    const config: McpServerConfig = { transport: 'http', url: 'http://127.0.0.1/mcp', protocolVersion: '2026-07-28', networkPolicy: { allowLoopback: true } }
    const client = new McpClient(new HttpMcpTransport(config, { fetch }), config, { clientName: 'test-client', clientVersion: '2.3.4' })

    await client.listTools()
    await client.callTool('weather', {})

    expect(captured.map(({ body }) => body.method)).toEqual(['tools/list', 'tools/call'])
    expect(captured[0]?.headers.get('mcp-protocol-version')).toBe('2026-07-28')
    expect(captured[0]?.headers.get('mcp-method')).toBe('tools/list')
    expect(captured[1]?.headers.get('mcp-method')).toBe('tools/call')
    expect(captured[1]?.headers.get('mcp-name')).toBe('weather')
    expect(captured[1]?.headers.get('mcp-session-id')).toBeNull()
    expect(captured[1]?.body.params?._meta).toEqual({
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientInfo': { name: 'test-client', version: '2.3.4' },
      'io.modelcontextprotocol/clientCapabilities': {},
    })
  })
})
