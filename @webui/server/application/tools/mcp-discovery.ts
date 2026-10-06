import { createMcpAdapter, McpAdapterError, type McpServerConfig, type McpTool } from './mcp-adapter.ts'
import { validateHttpUrl, type NetworkPolicyOptions } from '../../core/network-policy.ts'

const DEFAULT_TIMEOUT_MS = 15_000
const MAX_TIMEOUT_MS = 15_000
const MAX_TOOLS = 100
const MAX_RESPONSE_BYTES = 1_000_000
const MAX_SCHEMA_BYTES = 256_000
const ENV_REFERENCE = /^[A-Za-z_][A-Za-z0-9_]*$/

export type McpDiscoveryInput = {
  url: string
  transport?: 'http' | 'streamable-http' | 'sse'
  headers?: Record<string, { env: string }>
  protocolVersion?: string
  timeoutMs?: number
}

export type McpDiscoveryResult = {
  endpoint: string
  transport: 'streamable-http' | 'sse'
  status: 'success'
  tools: Array<{
    name: string
    description: string
    inputSchema: Record<string, unknown>
    outputSchema?: Record<string, unknown>
  }>
}

function configFor(input: McpDiscoveryInput): { config: McpServerConfig; endpoint: string; transport: 'streamable-http' | 'sse' } {
  if (!input || typeof input !== 'object' || typeof input.url !== 'string' || !input.url.trim()) {
    throw new Error('MCP discovery requires a server URL')
  }
  const transport = input.transport ?? 'http'
  if (transport !== 'http' && transport !== 'streamable-http' && transport !== 'sse') {
    throw new Error('MCP discovery supports Streamable HTTP and SSE transports only')
  }
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error(`MCP discovery timeout must be between 100 and ${MAX_TIMEOUT_MS} milliseconds`)
  }
  const url = validateHttpUrl(input.url, { allowPrivateHosts: true })
  if (url.search || url.hash) throw new Error('MCP discovery URLs must not contain query parameters or fragments; use environment-backed headers for authentication')

  const headers: Record<string, { env: string }> = {}
  for (const [name, value] of Object.entries(input.headers ?? {})) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || !value || typeof value !== 'object' || !ENV_REFERENCE.test(value.env)) {
      throw new Error('MCP discovery headers must use valid names and environment-variable references')
    }
    headers[name] = { env: value.env }
  }

  const protocolVersion = input.protocolVersion ?? (transport === 'sse' ? '2025-06-18' : undefined)
  const networkPolicy: NetworkPolicyOptions = {
    allowPrivateHosts: true,
    timeoutMs,
    maxResponseBytes: MAX_RESPONSE_BYTES,
    maxRedirects: 2,
  }
  return {
    config: {
      transport: transport === 'sse' ? 'sse' : 'http',
      url: url.href,
      ...(Object.keys(headers).length ? { headers } : {}),
      ...(protocolVersion ? { protocolVersion } : {}),
      timeoutMs,
      networkPolicy,
      limits: {
        requestTimeoutMs: timeoutMs,
        maxRequestTimeoutMs: MAX_TIMEOUT_MS,
        maxTools: MAX_TOOLS,
        maxListPages: 5,
        maxInputBytes: 256_000,
        maxResponseBytes: MAX_RESPONSE_BYTES,
      },
    },
    endpoint: `${url.origin}${url.pathname}`,
    transport: transport === 'sse' ? 'sse' : 'streamable-http',
  }
}

function publicTool(tool: McpTool): McpDiscoveryResult['tools'][number] {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
  }
}

/** Inspect an explicitly supplied MCP endpoint; no discovered definition is registered or callable. */
export async function discoverMcpServer(input: McpDiscoveryInput): Promise<McpDiscoveryResult> {
  const { config, endpoint, transport } = configFor(input)
  const adapter = createMcpAdapter({ limits: { maxResponseBytes: MAX_RESPONSE_BYTES } })
  try {
    const tools = await adapter.discover(config)
    const encoded = JSON.stringify(tools)
    if (new TextEncoder().encode(encoded).byteLength > MAX_SCHEMA_BYTES) {
      throw new Error('MCP discovery result exceeds the configured schema size limit')
    }
    return { endpoint, transport, status: 'success', tools: tools.map(publicTool) }
  } catch (error) {
    if (error instanceof Error && error.message === 'MCP discovery result exceeds the configured schema size limit') throw error
    const code = error instanceof McpAdapterError ? error.code : 'MCP_CONNECTION_ERROR'
    throw new Error(`MCP discovery failed (${code}); check the endpoint, authentication, and transport configuration`)
  } finally {
    await adapter.close()
  }
}
