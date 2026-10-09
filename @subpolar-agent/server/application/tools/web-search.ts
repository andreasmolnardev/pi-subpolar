import { createMcpAdapter, McpAdapterError, type McpCallResult } from './mcp-adapter.ts'
import { fetchWithNetworkPolicy, networkPolicyFromMetadata, readBoundedResponse, type NetworkPolicyOptions } from '../../core/network-policy.ts'

export type WebSearchProvider = 'exa' | 'duckduckgo' | 'firecrawl' | 'parallel'

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
  providers?: readonly WebSearchProvider[]
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

export const WEB_SEARCH_PROVIDERS: Readonly<Record<Exclude<WebSearchProvider, 'duckduckgo'>, { endpoint: string; toolName: string; keyEnv: string }>> = {
  exa: { endpoint: 'https://mcp.exa.ai/mcp', toolName: 'web_search_exa', keyEnv: 'EXA_API_KEY' },
  firecrawl: { endpoint: 'https://mcp.firecrawl.dev/v2/mcp', toolName: 'firecrawl_search', keyEnv: 'FIRECRAWL_API_KEY' },
  parallel: { endpoint: 'https://search.parallel.ai/mcp', toolName: 'web_search', keyEnv: 'PARALLEL_API_KEY' },
}

export const WEB_SEARCH_LIMITS = { maxQueryLength: 1000, maxResults: 10, maxContextSize: 32_000 } as const

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function providerValue(value: unknown): WebSearchProvider | undefined {
  return value === 'exa' || value === 'duckduckgo' || value === 'firecrawl' || value === 'parallel' ? value : undefined
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
  if (provider === 'firecrawl') return { query, limit: numResults }
  return { objective: query, search_queries: [query] }
}

function decodeHtml(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_, decimal: string) => String.fromCodePoint(Number(decimal)))
    .replace(/&#x([\da-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
}

function stripHtml(value: string): string {
  return decodeHtml(value.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ')).trim()
}

function duckDuckGoResults(html: string, maxResults: number, contextSize: number): WebSearchResult[] {
  if (/anomaly\.js|captcha|challenge-form|bots use DuckDuckGo/i.test(html)) {
    throw new WebSearchError('PROVIDER_UNAVAILABLE', 'DuckDuckGo search returned a bot challenge')
  }
  const results: WebSearchResult[] = []
  const seen = new Set<string>()
  let remainingContext = contextSize
  const anchors = /<a\b(?=[^>]*\bclass=["'][^"']*\bresult__a\b[^"']*["'])[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a\s*>/gi
  for (const match of html.matchAll(anchors)) {
    if (results.length >= maxResults) break
    const anchorIndex = match.index ?? 0
    const afterAnchorIndex = anchorIndex + match[0].length
    const nextAnchorIndex = html.slice(afterAnchorIndex).search(/<a\b(?=[^>]*\bclass=["'][^"']*\bresult__a\b[^"']*["'])/i)
    const following = html.slice(afterAnchorIndex, nextAnchorIndex < 0 ? undefined : afterAnchorIndex + nextAnchorIndex)
    const snippetMatch = following.match(/class=["'][^"']*\bresult__snippet\b[^"']*["'][^>]*>([\s\S]*?)<\/(?:a|div|td|span)\s*>/i)
    const title = stripHtml(match[2]).slice(0, 500)
    const snippet = snippetMatch ? stripHtml(snippetMatch[1]) : ''
    let resultUrl = decodeHtml(match[1])
    try {
      const parsed = new URL(resultUrl, 'https://html.duckduckgo.com')
      const isDuckDuckGoHost = parsed.hostname === 'duckduckgo.com' || parsed.hostname.endsWith('.duckduckgo.com')
      if (isDuckDuckGoHost && parsed.pathname.startsWith('/l/')) {
        resultUrl = parsed.searchParams.get('uddg') ?? ''
      } else if (isDuckDuckGoHost) {
        continue
      } else {
        resultUrl = parsed.href
      }
      const target = new URL(resultUrl)
      if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password || seen.has(target.href)) continue
      seen.add(target.href)
      const boundedSnippet = snippet.slice(0, remainingContext)
      remainingContext -= boundedSnippet.length
      results.push({ title, url: target.href, snippet: boundedSnippet })
    } catch {
      continue
    }
  }
  return results
}

async function searchDuckDuckGo(input: WebSearchInput, options: WebSearchOptions, resultCount: number, contextSize: number): Promise<WebSearchResult[]> {
  const query = boundedString(input.query, 'query', WEB_SEARCH_LIMITS.maxQueryLength, true)!
  const url = new URL('https://html.duckduckgo.com/html/')
  url.searchParams.set('q', query)
  url.searchParams.set('kp', '-1')
  const inheritedPolicy = options.networkPolicy ?? {}
  const policy: NetworkPolicyOptions = {
    ...inheritedPolicy,
    allowedHosts: [...new Set([...(inheritedPolicy.allowedHosts ?? []), 'html.duckduckgo.com'])],
    timeoutMs: Math.min(inheritedPolicy.timeoutMs ?? 10_000, 10_000),
    maxResponseBytes: Math.min(inheritedPolicy.maxResponseBytes ?? 1_000_000, 1_000_000),
  }
  const response = await fetchWithNetworkPolicy(url, {
    headers: { accept: 'text/html,application/xhtml+xml', 'user-agent': 'Mozilla/5.0' },
  }, policy, options.fetch)
  if (!response.ok) throw new WebSearchError('PROVIDER_UNAVAILABLE', `DuckDuckGo returned HTTP ${response.status}`)
  if (!/html|xhtml/i.test(response.headers.get('content-type') ?? '')) throw new WebSearchError('PROTOCOL_ERROR', 'DuckDuckGo returned an unsupported response')
  const html = await readBoundedResponse(response, 1_000_000)
  return duckDuckGoResults(html, resultCount, contextSize)
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
  const contextSize = boundedInteger(input.contextSize, 'contextSize', 1, WEB_SEARCH_LIMITS.maxContextSize, 8_000)
  const defaultProvider = options.provider ?? providerValue(process.env.SUBPOLAR_WEB_SEARCH_PROVIDER) ?? 'exa'
  const providers = [...new Set(options.providers?.map(providerValue).filter((provider): provider is WebSearchProvider => Boolean(provider)) ?? [defaultProvider])]
  if (providers.length === 0) throw new WebSearchError('PROVIDER_UNAVAILABLE', 'No web search providers are enabled')
  const environmentProtocolVersion = process.env.SUBPOLAR_WEB_SEARCH_MCP_PROTOCOL_VERSION
  const protocolVersion = options.protocolVersion
    ?? (environmentProtocolVersion === '2026-07-28' ? '2026-07-28' : '2025-06-18')
  let lastError: WebSearchError | undefined
  let hadSuccessfulProvider = false
  const resultCount = boundedInteger(input.resultCount, 'resultCount', 1, WEB_SEARCH_LIMITS.maxResults, 5)
  for (const configured of providers) {
    if (configured === 'duckduckgo') {
      try {
        const results = await searchDuckDuckGo(input, options, resultCount, contextSize)
        hadSuccessfulProvider = true
        if (results.length > 0) return { results }
      } catch (error) {
        if (error instanceof WebSearchError) lastError = error
        else {
          const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : undefined
          lastError = new WebSearchError(code === 'TIMEOUT' ? 'NETWORK_ERROR' : 'PROVIDER_UNAVAILABLE', 'DuckDuckGo search provider is unavailable')
        }
      }
      continue
    }
    const provider = WEB_SEARCH_PROVIDERS[configured]
    const apiKey = options.apiKeys?.[configured] ?? process.env[provider.keyEnv]
    const adapter = createMcpAdapter({
      fetch: options.fetch,
      defaults: { transport: 'http', protocolVersion, networkPolicy: options.networkPolicy },
    })
    try {
      const result = await adapter.invoke({
        tool_id: `web-search/${configured}`,
        namespace: 'web-search',
        target: options.endpointOverrides?.[configured] ?? provider.endpoint,
        operation: provider.toolName,
        metadata: {
          transport: 'http',
          toolName: provider.toolName,
          ...(apiKey ? { headers: configured === 'exa' ? { 'x-api-key': apiKey } : { authorization: `Bearer ${apiKey}` } } : {}),
        },
      }, inputArgs(input, configured))
      if (result.isError) throw new WebSearchError('PROVIDER_UNAVAILABLE', `${configured} search provider returned an error`)
      const results = parseResults(result, resultCount, contextSize)
      hadSuccessfulProvider = true
      if (results.length > 0) return { results }
    } catch (error) {
      if (error instanceof WebSearchError) {
        lastError = error
      } else {
        const mcpCode = error instanceof McpAdapterError ? error.code : typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : undefined
        const code = mcpCode === 'MCP_TIMEOUT' || mcpCode === 'MCP_CONNECTION_ERROR' || error instanceof Error && /MCP_(TIMEOUT|CONNECTION)|Could not send MCP|NetworkPolicy|timed out|connect failed/i.test(error.message) ? 'NETWORK_ERROR' : 'PROTOCOL_ERROR'
        lastError = new WebSearchError(code, `${configured} search provider is unavailable`)
      }
    } finally {
      await adapter.close()
    }
  }
  if (hadSuccessfulProvider) return { results: [] }
  throw lastError ?? new WebSearchError('PROVIDER_UNAVAILABLE', 'No web search providers are available')
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
