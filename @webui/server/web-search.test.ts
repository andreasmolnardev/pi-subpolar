import { describe, expect, it } from 'bun:test'
import { webSearch } from './web-search.ts'

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

const policy = { allowedHosts: ['mcp.exa.ai', 'search.parallel.ai', 'example.test'] }

describe('web search', () => {
  it('maps Exa arguments and sends the optional key only as a request header', async () => {
    const calls: Request[] = []
    const result = await webSearch({ query: 'latest release', resultCount: 3, type: 'neural', livecrawl: 'always' }, { fetch: fakeFetch(calls), apiKeys: { exa: 'do-not-leak' }, networkPolicy: policy })
    const toolCall = JSON.parse(await calls.at(-1)!.text()) as { method: string; params: { arguments: Record<string, unknown> } }
    expect(toolCall.method).toBe('tools/call')
    expect(toolCall.params.arguments).toEqual({ query: 'latest release', type: 'neural', numResults: 3, livecrawl: 'always' })
    expect(calls.at(-1)!.headers.get('x-api-key')).toBe('do-not-leak')
    expect(JSON.stringify(result)).not.toContain('do-not-leak')
  })

  it('selects Parallel explicitly and maps objective/search_queries without fetching result URLs', async () => {
    const calls: Request[] = []
    const result = await webSearch({ provider: 'parallel', query: 'topic', objective: 'compare sources', search_queries: ['topic', 'topic news'] }, { fetch: fakeFetch(calls), apiKeys: { parallel: 'parallel-secret' }, networkPolicy: { allowedHosts: ['search.parallel.ai'] } })
    const toolCall = JSON.parse(await calls.at(-1)!.text()) as { params: { arguments: Record<string, unknown> } }
    expect(result.provider).toBe('parallel')
    expect(toolCall.params.arguments).toEqual({ objective: 'compare sources', search_queries: ['topic', 'topic news'] })
    expect(calls).toHaveLength(3)
    expect(calls.at(-1)!.headers.get('authorization')).toBe('Bearer parallel-secret')
  })

  it('rejects unbounded input and bounds parsed context/results', async () => {
    await expect(webSearch({ query: 'x'.repeat(1001) })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    const calls: Request[] = []
    const result = await webSearch({ query: 'ok', resultCount: 1, contextSize: 4 }, { fetch: fakeFetch(calls), networkPolicy: policy })
    expect(result.results).toHaveLength(1)
    expect(result.results[0]!.snippet).toHaveLength(4)
  })

})
