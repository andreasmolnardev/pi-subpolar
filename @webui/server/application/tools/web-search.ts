import { createMcpAdapter, McpAdapterError, type McpCallResult } from './mcp-adapter.ts'
import { fetchWithNetworkPolicy, networkPolicyFromMetadata, readBoundedResponse, type NetworkPolicyOptions } from '../../core/network-policy.ts'

export type WebSearchProvider = 'exa' | 'parallel'

export type WebSearchInput = {
  query: string
  resultCount?: number
  contextSize?: number
}

export type WebFetchInput = { url: string; maxCharacters?: number }

export type WebSearchResult = { title: string; url: string; snippet: string }

export type WebSearchResponse = { results: WebSearchResult[] }

export type WebFetchResponse = { url: string; title: string; content: string }

export type WebSearchOptions = {
  fetch?: typeof globalThis.fetch
  provider?: WebSearchProvider
  protocolVersion?: '2025-06-18' | '2026-07-28'
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
  if (provider === 'exa') return { query, type: 'auto', numResults, livecrawl: 'fallback' }
  return { objective: query, search_queries: [query] }
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
  const configured = options.provider ?? providerValue(process.env.SUBPOLAR_WEB_SEARCH_PROVIDER) ?? 'exa'
  const contextSize = boundedInteger(input.contextSize, 'contextSize', 1, WEB_SEARCH_LIMITS.maxContextSize, 8_000)
  const args = inputArgs(input, configured)
  const provider = WEB_SEARCH_PROVIDERS[configured]
  const apiKey = options.apiKeys?.[configured] ?? process.env[provider.keyEnv]
  const environmentProtocolVersion = process.env.SUBPOLAR_WEB_SEARCH_MCP_PROTOCOL_VERSION
  const protocolVersion = options.protocolVersion
    ?? (environmentProtocolVersion === '2026-07-28' ? '2026-07-28' : '2025-06-18')
  const adapter = createMcpAdapter({
    fetch: options.fetch,
    defaults: { transport: 'http', protocolVersion, networkPolicy: options.networkPolicy },
  })
  try {
    const result = await adapter.invoke({ tool_id: `web-search/${configured}`, namespace: 'web-search', target: options.endpointOverrides?.[configured] ?? provider.endpoint, operation: provider.toolName, metadata: { transport: 'http', toolName: provider.toolName, ...(apiKey ? { headers: configured === 'exa' ? { 'x-api-key': apiKey } : { authorization: `Bearer ${apiKey}` } } : {}) } }, args)
    if (result.isError) throw new WebSearchError('PROVIDER_UNAVAILABLE', 'Web search provider returned an error')
    return { results: parseResults(result, boundedInteger(input.resultCount, 'resultCount', 1, WEB_SEARCH_LIMITS.maxResults, 5), contextSize) }
  } catch (error) {
    if (error instanceof WebSearchError) throw error
    const mcpCode = error instanceof McpAdapterError ? error.code : typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : undefined
    const code = mcpCode === 'MCP_TIMEOUT' || mcpCode === 'MCP_CONNECTION_ERROR' || error instanceof Error && /MCP_(TIMEOUT|CONNECTION)|Could not send MCP|NetworkPolicy|timed out|connect failed/i.test(error.message) ? 'NETWORK_ERROR' : 'PROTOCOL_ERROR'
    throw new WebSearchError(code, code === 'NETWORK_ERROR' ? 'Web search provider is unavailable' : 'Web search provider returned an invalid response')
  } finally {
    await adapter.close()
  }
}

export type WebFetchOptions = { fetch?: typeof globalThis.fetch; networkPolicy?: NetworkPolicyOptions }

function htmlText(value: string): { title: string; content: string } {
  const title = value.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1] ?? ''
  const content = value
    .replace(/<(script|style|noscript|svg)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(?:p|div|li|h[1-6]|article|section|tr)\s*>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*/g, '\n')
    .trim()
  return { title: title.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, 500), content }
}

export async function webFetch(input: WebFetchInput, options: WebFetchOptions = {}): Promise<WebFetchResponse> {
  const rawUrl = boundedString(input.url, 'url', 2048, true)!
  const maxCharacters = boundedInteger(input.maxCharacters, 'maxCharacters', 1, 20_000, 10_000)
  let url: URL
  try {
    url = new URL(rawUrl)
    if (url.protocol !== 'http:' && url.protocol !== 'https:' || url.username || url.password) throw new Error('invalid')
  } catch {
    throw new WebSearchError('INVALID_INPUT', 'url must be a valid credential-free HTTP(S) URL')
  }
  const basePolicy = options.networkPolicy ?? {}
  const allowedHosts = basePolicy.allowedHosts?.length
    ? basePolicy.allowedHosts
    : [url.hostname]
  if (!allowedHosts.some((host) => host.toLowerCase().replace(/\.$/, '') === url.hostname.toLowerCase().replace(/\.$/, ''))) {
    throw new WebSearchError('INVALID_INPUT', 'url host is not allowed by the configured network policy')
  }
  const policy: NetworkPolicyOptions = {
    ...basePolicy,
    allowedHosts,
    maxResponseBytes: Math.min(basePolicy.maxResponseBytes ?? 100_000, 100_000),
  }
  try {
    const response = await fetchWithNetworkPolicy(url, { headers: { accept: 'text/html,text/plain,application/xhtml+xml' } }, policy, options.fetch)
    if (!response.ok) throw new WebSearchError('PROVIDER_UNAVAILABLE', `Web page returned HTTP ${response.status}`)
    const contentType = response.headers.get('content-type') ?? ''
    if (!/^(text\/|application\/(?:xhtml\+xml|json))/i.test(contentType)) throw new WebSearchError('PROTOCOL_ERROR', 'Web page did not return a supported text content type')
    const body = await readBoundedResponse(response, 100_000)
    const parsed = /html|xhtml/i.test(contentType) ? htmlText(body) : { title: '', content: body }
    return { url: response.url || url.href, title: parsed.title, content: parsed.content.slice(0, maxCharacters) }
  } catch (error) {
    if (error instanceof WebSearchError) throw error
    throw new WebSearchError('NETWORK_ERROR', 'Web page could not be fetched under the network policy')
  }
}

export function webSearchNetworkPolicy(metadata?: Record<string, unknown>): NetworkPolicyOptions {
  return networkPolicyFromMetadata(metadata)
}
