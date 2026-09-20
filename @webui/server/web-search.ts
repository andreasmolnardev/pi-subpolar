import { createMcpAdapter, McpAdapterError, type McpCallResult } from './mcp-adapter.ts'
import { networkPolicyFromMetadata, type NetworkPolicyOptions } from './network-policy.ts'

export type WebSearchProvider = 'exa' | 'parallel'

export type WebSearchInput = {
  query: string
  provider?: WebSearchProvider
  resultCount?: number
  contextSize?: number
  type?: string
  livecrawl?: string
  objective?: string
  search_queries?: string[]
}

export type WebSearchResult = { title: string; url: string; snippet: string }

export type WebSearchResponse = { provider: WebSearchProvider; results: WebSearchResult[] }

export type WebSearchOptions = {
  fetch?: typeof globalThis.fetch
  provider?: WebSearchProvider
  networkPolicy?: NetworkPolicyOptions
  endpointOverrides?: Partial<Record<WebSearchProvider, string>>
  apiKeys?: Partial<Record<WebSearchProvider, string | undefined>>
}

export class WebSearchError extends Error {
  constructor(readonly code: 'INVALID_INPUT' | 'PROVIDER_UNAVAILABLE' | 'NETWORK_ERROR' | 'PROTOCOL_ERROR' | 'RESULT_LIMIT_EXCEEDED', message: string) {
    super(message)
    this.name = 'WebSearchError'
  }
}

export const WEB_SEARCH_PROVIDERS: Readonly<Record<WebSearchProvider, { endpoint: string; toolName: string; keyEnv: string }>> = {
  exa: { endpoint: 'https://mcp.exa.ai/mcp', toolName: 'web_search_exa', keyEnv: 'EXA_API_KEY' },
  parallel: { endpoint: 'https://search.parallel.ai/mcp', toolName: 'web_search', keyEnv: 'PARALLEL_API_KEY' },
}

export const WEB_SEARCH_LIMITS = { maxQueryLength: 1000, maxResults: 10, maxContextSize: 32_000 } as const

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function providerValue(value: unknown): WebSearchProvider | undefined {
  return value === 'exa' || value === 'parallel' ? value : undefined
}

function boundedString(value: unknown, name: string, max: number, required = false): string | undefined {
  if (value === undefined && !required) return undefined
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new WebSearchError('INVALID_INPUT', `${name} must be a non-empty string of at most ${max} characters`)
  return value.trim()
}

function boundedInteger(value: unknown, name: string, min: number, max: number, fallback: number): number {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) throw new WebSearchError('INVALID_INPUT', `${name} must be an integer between ${min} and ${max}`)
  return value as number
}

function inputArgs(input: WebSearchInput, provider: WebSearchProvider): Record<string, unknown> {
  const query = boundedString(input.query, 'query', WEB_SEARCH_LIMITS.maxQueryLength, true)!
  const numResults = boundedInteger(input.resultCount, 'resultCount', 1, WEB_SEARCH_LIMITS.maxResults, 5)
  if (provider === 'exa') {
    return { query, type: boundedString(input.type, 'type', 32) ?? 'auto', numResults, livecrawl: boundedString(input.livecrawl, 'livecrawl', 32) ?? 'fallback' }
  }
  const objective = boundedString(input.objective, 'objective', WEB_SEARCH_LIMITS.maxQueryLength) ?? query
  const queries = input.search_queries ?? [query]
  if (!Array.isArray(queries) || queries.length < 1 || queries.length > 5 || queries.some((item) => typeof item !== 'string' || !item.trim() || item.length > WEB_SEARCH_LIMITS.maxQueryLength)) {
    throw new WebSearchError('INVALID_INPUT', 'search_queries must contain between 1 and 5 bounded queries')
  }
  return { objective, search_queries: queries.map((item) => item.trim()) }
}

function textValues(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(textValues)
  if (!value || typeof value !== 'object') return []
  return Object.values(value).flatMap(textValues)
}

function parsedValues(result: McpCallResult): unknown[] {
  const values: unknown[] = [result.structuredContent]
  for (const item of result.content) {
    const entry = record(item)
    if (entry.type === 'text' && typeof entry.text === 'string') {
      try { values.push(JSON.parse(entry.text)) } catch { values.push(entry.text) }
    }
  }
  return values
}

function parseResults(result: McpCallResult, maxResults: number, contextSize: number): WebSearchResult[] {
  const output: WebSearchResult[] = []
  const seen = new Set<string>()
  const visit = (value: unknown): void => {
    if (output.length >= maxResults || contextSize <= 0 || value === null || value === undefined) return
    if (Array.isArray(value)) { value.forEach(visit); return }
    if (typeof value !== 'object') return
    const item = record(value)
    const url = typeof item.url === 'string' ? item.url.trim() : ''
    const title = typeof item.title === 'string' ? item.title.trim() : ''
    const snippetValue = item.snippet ?? item.description ?? item.text ?? item.content
    const snippet = typeof snippetValue === 'string' ? snippetValue.trim() : ''
    if (/^https?:\/\//i.test(url) && (title || snippet) && !seen.has(url)) {
      seen.add(url)
      const remaining = contextSize - output.reduce((sum, entry) => sum + entry.snippet.length, 0)
      output.push({ title: title.slice(0, 500), url, snippet: snippet.slice(0, Math.max(0, remaining)) })
    }
    Object.values(item).forEach(visit)
  }
  parsedValues(result).forEach(visit)
  if (output.length === 0) {
    const markdown = textValues(result.content).join('\n')
    for (const match of markdown.matchAll(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)(?:\s*[-:|]\s*([^\n]+))?/g)) {
      if (output.length >= maxResults) break
      output.push({ title: match[1].slice(0, 500), url: match[2], snippet: (match[3] ?? '').trim().slice(0, contextSize) })
    }
  }
  return output
}

export async function webSearch(input: WebSearchInput, options: WebSearchOptions = {}): Promise<WebSearchResponse> {
  const configured = providerValue(input.provider) ?? options.provider ?? providerValue(process.env.SUBPOLAR_WEB_SEARCH_PROVIDER) ?? 'exa'
  if (input.provider !== undefined && !providerValue(input.provider)) throw new WebSearchError('INVALID_INPUT', 'provider must be exa or parallel')
  const contextSize = boundedInteger(input.contextSize, 'contextSize', 1, WEB_SEARCH_LIMITS.maxContextSize, 8_000)
  const args = inputArgs(input, configured)
  const provider = WEB_SEARCH_PROVIDERS[configured]
  const apiKey = options.apiKeys?.[configured] ?? process.env[provider.keyEnv]
  const adapter = createMcpAdapter({
    fetch: options.fetch,
    defaults: { transport: 'http', networkPolicy: options.networkPolicy },
  })
  try {
    const result = await adapter.invoke({ tool_id: `web-search/${configured}`, namespace: 'web-search', target: options.endpointOverrides?.[configured] ?? provider.endpoint, operation: provider.toolName, metadata: { transport: 'http', toolName: provider.toolName, ...(apiKey ? { headers: configured === 'exa' ? { 'x-api-key': apiKey } : { authorization: `Bearer ${apiKey}` } } : {}) } }, args)
    if (result.isError) throw new WebSearchError('PROVIDER_UNAVAILABLE', 'Web search provider returned an error')
    return { provider: configured, results: parseResults(result, boundedInteger(input.resultCount, 'resultCount', 1, WEB_SEARCH_LIMITS.maxResults, 5), contextSize) }
  } catch (error) {
    if (error instanceof WebSearchError) throw error
    const mcpCode = error instanceof McpAdapterError ? error.code : typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : undefined
    const code = mcpCode === 'MCP_TIMEOUT' || mcpCode === 'MCP_CONNECTION_ERROR' || error instanceof Error && /MCP_(TIMEOUT|CONNECTION)|Could not send MCP|NetworkPolicy|timed out|connect failed/i.test(error.message) ? 'NETWORK_ERROR' : 'PROTOCOL_ERROR'
    throw new WebSearchError(code, code === 'NETWORK_ERROR' ? 'Web search provider is unavailable' : 'Web search provider returned an invalid response')
  } finally {
    await adapter.close()
  }
}

export function webSearchNetworkPolicy(metadata?: Record<string, unknown>): NetworkPolicyOptions {
  return networkPolicyFromMetadata(metadata)
}
