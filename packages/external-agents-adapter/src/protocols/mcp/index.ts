import { timingSafeEqual } from 'node:crypto'
import type { ExternalScope, ExternalToolBridge } from '../../runtime/contracts.ts'
import { immutableScope } from '../../execution/workspace.ts'

const versions = new Set(['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'])
const encodedName = (id: string) => `subpolar_${Buffer.from(id).toString('base64url')}`
const maxBody = 1048576
async function boundedBody(request: Request): Promise<unknown> {
  if (Number(request.headers.get('content-length') ?? 0) > maxBody) throw new Error('Request too large')
  const reader = request.body?.getReader()
  if (!reader) throw new Error('JSON request required')
  const chunks: Uint8Array[] = []; let size = 0
  try { while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > maxBody) { await reader.cancel(); throw new Error('Request too large') }; chunks.push(value) } } finally { reader.releaseLock() }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}
/** Session-only Streamable HTTP MCP transport. Core retains all policy and tool execution. */
export function startSessionMcpBridge(options: { scope: ExternalScope; tools: ExternalToolBridge; signal?: AbortSignal; onActivity?: (event: { callId: string; toolId: string; state: 'started' | 'completed' | 'failed' }) => void | Promise<void> }) {
  const scope = immutableScope(options.scope)
  const token = crypto.randomUUID() + crypto.randomUUID()
  const sessionId = crypto.randomUUID()
  const active = new Map<string, AbortController>()
  let closed = false
  let initialized = false
  let protocol = '2025-06-18'
  function response(value: unknown, status = 200) {
    const text = JSON.stringify(value)
    if (Buffer.byteLength(text) > maxBody) return new Response(JSON.stringify({ jsonrpc: '2.0', id: (value as any)?.id ?? null, error: { code: -32603, message: 'Tool result exceeds transport limit' } }), { status: 200, headers: { 'Content-Type': 'application/json', 'Mcp-Session-Id': sessionId } })
    return new Response(text, { status, headers: { 'Content-Type': 'application/json', 'Mcp-Session-Id': sessionId, 'Cache-Control': 'no-store' } })
  }
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, idleTimeout: 120, maxRequestBodySize: maxBody, async fetch(request) {
    const supplied = request.headers.get('authorization') ?? ''
    const expected = `Bearer ${token}`
    if (Buffer.byteLength(supplied) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) return new Response('Unauthorized', { status: 401 })
    if (closed || new URL(request.url).pathname !== '/mcp') return new Response('Not found', { status: 404 })
    if (request.method === 'DELETE') { if (request.headers.get('mcp-session-id') !== sessionId) return new Response('Session not found', { status: 404 }); setTimeout(() => { void close() }, 0); return new Response(null, { status: 204 }) }
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: { Allow: 'POST, DELETE' } })
    let body: any
    try { body = await boundedBody(request) } catch { return response({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid or oversized JSON request' } }, 400) }
    const id = body?.id
    const fail = (code: number, message: string) => response({ jsonrpc: '2.0', id: id ?? null, error: { code, message } })
    if (!body || Array.isArray(body) || body.jsonrpc !== '2.0' || typeof body.method !== 'string' || (id !== undefined && typeof id !== 'string' && typeof id !== 'number')) return fail(-32600, 'Invalid JSON-RPC request')
    if (Object.keys(body).some(key => !['jsonrpc', 'id', 'method', 'params'].includes(key))) return fail(-32602, 'Client scope and extra request fields are forbidden')
    if (body.method === 'initialize') {
      if (initialized || id === undefined || !versions.has(body.params?.protocolVersion)) return fail(-32602, 'Unsupported initialization')
      initialized = true; protocol = body.params.protocolVersion
      return response({ jsonrpc: '2.0', id, result: { protocolVersion: protocol, capabilities: { tools: {} }, serverInfo: { name: 'subpolar-session-tools', version: '0.1.0' } } })
    }
    if (!initialized || request.headers.get('mcp-session-id') !== sessionId) return new Response('Session not found', { status: 404 })
    const sentProtocol = request.headers.get('mcp-protocol-version')
    if (sentProtocol && sentProtocol !== protocol) return new Response('Protocol mismatch', { status: 400 })
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 })
    if (body.method === 'notifications/cancelled') { active.get(String(body.params?.requestId))?.abort(); return new Response(null, { status: 202 }) }
    if (id === undefined) return new Response(null, { status: 202 })
    if (body.method === 'ping') return response({ jsonrpc: '2.0', id, result: {} })
    if (!['tools/list', 'tools/call'].includes(body.method)) return fail(-32601, 'Method not supported')
    try {
      const listed = await options.tools.list(scope)
      const tools = listed.filter(tool => !scope.allowedToolIds || scope.allowedToolIds.includes(tool.id))
      if (body.method === 'tools/list') return response({ jsonrpc: '2.0', id, result: { tools: tools.map(tool => ({ name: encodedName(tool.id), description: tool.description, inputSchema: tool.inputSchema })) } })
      if (!body.params || Object.keys(body.params).some(key => !['name', 'arguments', '_meta'].includes(key))) return fail(-32602, 'Invalid tool parameters')
      const tool = tools.find(tool => encodedName(tool.id) === body.params.name)
      if (!tool) return fail(-32602, 'Tool is not permitted in this session')
      if (active.has(String(id))) return fail(-32600, 'Duplicate active request ID')
      const abort = new AbortController(); active.set(String(id), abort)
      const callId = `external-${crypto.randomUUID()}`
      const requestAbort = () => abort.abort()
      request.signal.addEventListener('abort', requestAbort, { once: true })
      try {
        await options.onActivity?.({ callId, toolId: tool.id, state: 'started' })
        const result = await options.tools.call(scope, tool.id, body.params.arguments ?? {}, callId, abort.signal)
        await options.onActivity?.({ callId, toolId: tool.id, state: 'completed' })
        const failed = Boolean(result && typeof result === 'object' && 'ok' in result && (result as any).ok === false)
        return response({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result) }], isError: failed } })
      } catch {
        await options.onActivity?.({ callId, toolId: tool.id, state: 'failed' })
        return response({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: abort.signal.aborted ? 'Tool execution cancelled' : 'Tool execution failed' }], isError: true } })
      } finally { request.signal.removeEventListener('abort', requestAbort); active.delete(String(id)) }
    } catch { return fail(-32603, 'Tool bridge unavailable') }
  } })
  async function close() { if (closed) return; closed = true; for (const abort of active.values()) abort.abort(); active.clear(); server.stop(true); options.signal?.removeEventListener('abort', onAbort) }
  const onAbort = () => { void close() }
  options.signal?.addEventListener('abort', onAbort, { once: true })
  if (options.signal?.aborted) void close()
  return { url: `http://127.0.0.1:${server.port}/mcp`, token, sessionId, close }
}
