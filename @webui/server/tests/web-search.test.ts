import { describe, expect, it } from 'bun:test'
import { webFetch, webSearch } from '../application/tools/web-search.ts'

function rpcResponse(body: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: body }), { headers: { 'content-type': 'application/json' } })
}

function fakeFetch(calls: Request[]): typeof fetch {
  return (async (input, init) => {
    calls.push(new Request(String(input), init))
    const body = JSON.parse(await new Response(init?.body as any).text()) as { id?: string | number; method?: string }
    if (body.method === 'initialize') return rpcResponse({})
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 })
    const response = JSON.parse(await (rpcResponse({ content: [{ type: 'text', text: JSON.stringify({ results: [{ title: 'Example', url: 'https://example.com', snippet: 'A bounded result' }] }) }] })).text())
    response.id = body.id
    return new Response(JSON.stringify(response), { headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
}

const policy = { allowedHosts: ['mcp.exa.ai', 'mcp.firecrawl.dev', 'search.parallel.ai', 'example.test'] }

describe('web search', () => {
  it('maps the provider-neutral search input and sends the optional key only as a request header', async () => {
    const calls: Request[] = []
    const result = await webSearch({ query: 'latest release', resultCount: 3 }, { fetch: fakeFetch(calls), apiKeys: { exa: 'do-not-leak' }, networkPolicy: policy })
    const toolCall = JSON.parse(await calls.at(-1)!.text()) as { method: string; params: { arguments: Record<string, unknown> } }
    expect(toolCall.method).toBe('tools/call')
    expect(toolCall.params.arguments).toEqual({ query: 'latest release', type: 'auto', numResults: 3, livecrawl: 'fallback' })
    expect(calls[0]!.headers.get('mcp-protocol-version')).toBe('2025-06-18')
    expect(calls.at(-1)!.headers.get('x-api-key')).toBe('do-not-leak')
    expect(JSON.stringify(result)).not.toContain('do-not-leak')
  })

  it('uses the server-selected Parallel provider without fetching result URLs', async () => {
    const calls: Request[] = []
    const result = await webSearch({ query: 'topic' }, { provider: 'parallel', fetch: fakeFetch(calls), apiKeys: { parallel: 'parallel-secret' }, networkPolicy: { allowedHosts: ['search.parallel.ai'] } })
    const toolCall = JSON.parse(await calls.at(-1)!.text()) as { params: { arguments: Record<string, unknown> } }
    expect(result.results).toHaveLength(1)
    expect(toolCall.params.arguments).toEqual({ objective: 'topic', search_queries: ['topic'] })
    expect(calls).toHaveLength(3)
    expect(calls.at(-1)!.headers.get('authorization')).toBe('Bearer parallel-secret')
  })

  it('falls back from Exa to the keyless Firecrawl MCP', async () => {
    const calls: Request[] = []
    const firecrawlFetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const request = new Request(String(input), init)
      calls.push(request)
      const body = JSON.parse(await request.text()) as { id?: string | number; method?: string }
      if (body.method === 'initialize') return rpcResponse({})
      if (body.method === 'notifications/initialized') return new Response(null, { status: 202 })
      const firecrawl = new URL(request.url).hostname === 'mcp.firecrawl.dev'
      return new Response(JSON.stringify({
        jsonrpc: '2.0',
        id: body.id,
        result: firecrawl
          ? { content: [{ type: 'text', text: JSON.stringify({ data: { web: [{ title: 'Firecrawl result', url: 'https://example.com', description: 'Fallback result' }] } }) }] }
          : { isError: true, content: [{ type: 'text', text: 'Exa temporarily unavailable' }] },
      }), { headers: { 'content-type': 'application/json' } })
    }) as typeof globalThis.fetch

    const result = await webSearch({ query: 'Dashwise features' }, { fetch: firecrawlFetch, providers: ['exa', 'firecrawl'], networkPolicy: policy })

    expect(result.results).toEqual([{ title: 'Firecrawl result', url: 'https://example.com', snippet: 'Fallback result' }])
    expect(calls.map((request) => new URL(request.url).hostname)).toContain('mcp.exa.ai')
    expect(calls.map((request) => new URL(request.url).hostname)).toContain('mcp.firecrawl.dev')
  })

  it('rejects unbounded input and bounds parsed context/results', async () => {
    await expect(webSearch({ query: 'x'.repeat(1001) })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    const calls: Request[] = []
    const result = await webSearch({ query: 'ok', resultCount: 1, contextSize: 4 }, { fetch: fakeFetch(calls), networkPolicy: policy })
    expect(result.results).toHaveLength(1)
    expect(result.results[0]!.snippet).toHaveLength(4)
  })


  it('fetches bounded public text content without returning markup', async () => {
    const calls: Request[] = []
    const fetch = (async (input, init) => {
      calls.push(new Request(String(input), init))
      return new Response('<html><title>Example Page</title><script>secret()</script><p>Hello <b>world</b></p></html>', { headers: { 'content-type': 'text/html' } })
    }) as typeof globalThis.fetch
    const result = await webFetch({ url: 'http://localhost/page', maxCharacters: 10 }, { fetch, networkPolicy: { allowPrivateHosts: true } })
    expect(calls).toHaveLength(1)
    expect(result.title).toBe('Example Page')
    expect(result.content).toBe('Example Pa')
    expect(result.content).not.toContain('secret')
  })

  it('rejects unsafe, malformed, and network-policy-blocked fetch URLs', async () => {
    await expect(webFetch({ url: 'file:///etc/passwd' })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(webFetch({ url: 'https://user:pass@example.com' })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(webFetch({ url: 'https://other.example/page' }, { networkPolicy: { allowedHosts: ['allowed.example'] } })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })
})
