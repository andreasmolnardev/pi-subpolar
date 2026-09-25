import type PocketBase from 'pocketbase'
import { fetchWithNetworkPolicy, networkPolicyFromMetadata, readBoundedResponse, type NetworkPolicyOptions } from '../core/network-policy.ts'
import { redactSensitiveText } from '../core/security-redaction.ts'

export type BrowserLifecycle = 'open' | 'closed'
export type BrowserTab = { id: string; url: string; title: string; text: string; status: number; openedAt: number }
type BrowserTabMetadata = Omit<BrowserTab, 'text'>
export type BrowserLimits = { timeoutMs: number; maxPageBytes: number; maxTextBytes: number; maxTabs: number; maxRedirects: number }
export type BrowserSession = {
  id: string
  owner_id: string
  project_id?: string
  session_id?: string
  task_id?: string
  lifecycle: BrowserLifecycle
  current_tab_id?: string
  current_url?: string
  tabs: BrowserTab[]
  limits: BrowserLimits
  created_at: number
  updated_at: number
  closed_at?: number
}

export type BrowserContext = { ownerId: string; projectId?: string; sessionId?: string; taskId?: string; agentName?: string; readOnly?: boolean }
export const BROWSER_POLICY_GROUPS = ['read', 'navigation', 'form-interaction', 'upload', 'download', 'submit', 'destructive'] as const
export type BrowserPolicyGroup = (typeof BROWSER_POLICY_GROUPS)[number]
export function browserProfileAllows(group: string, readOnly: boolean): boolean { return !readOnly || group === 'read' || group === 'navigation' }
export type BrowserPort = {
  open(sessionId: string, url: string, limits: BrowserLimits): Promise<BrowserTab>
  navigate(sessionId: string, tabId: string, url: string, limits: BrowserLimits): Promise<BrowserTab>
  back(sessionId: string, tabId: string): Promise<BrowserTab>
  forward(sessionId: string, tabId: string): Promise<BrowserTab>
  tabs(sessionId: string): Promise<BrowserTab[]>
  read(sessionId: string, tabId?: string, maxTextBytes?: number): Promise<BrowserTab>
  find(sessionId: string, query: string, tabId?: string): Promise<{ query: string; matches: Array<{ index: number; text: string }> }>
  screenshot(sessionId: string, tabId?: string): Promise<{ mimeType: string; data: string }>
  wait(sessionId: string, milliseconds: number): Promise<{ waitedMs: number }>
}

export class BrowserRuntimeError extends Error {
  constructor(readonly code: 'BROWSER_UNAVAILABLE' | 'BROWSER_SESSION_NOT_FOUND' | 'BROWSER_SESSION_CLOSED' | 'BROWSER_LIMIT' | 'BROWSER_POLICY' | 'BROWSER_INVALID_INPUT', message: string) {
    super(message)
    this.name = 'BrowserRuntimeError'
  }
}

export const DEFAULT_BROWSER_LIMITS: BrowserLimits = { timeoutMs: 15_000, maxPageBytes: 4 * 1024 * 1024, maxTextBytes: 128 * 1024, maxTabs: 8, maxRedirects: 3 }

function safeLimits(input?: Partial<BrowserLimits>): BrowserLimits {
  const result = { ...DEFAULT_BROWSER_LIMITS, ...(input ?? {}) }
  if (!Number.isInteger(result.timeoutMs) || result.timeoutMs < 1 || result.timeoutMs > 60_000 || !Number.isInteger(result.maxPageBytes) || result.maxPageBytes < 1 || result.maxPageBytes > 16 * 1024 * 1024 || !Number.isInteger(result.maxTextBytes) || result.maxTextBytes < 1 || result.maxTextBytes > 512 * 1024 || !Number.isInteger(result.maxTabs) || result.maxTabs < 1 || result.maxTabs > 32 || !Number.isInteger(result.maxRedirects) || result.maxRedirects < 0 || result.maxRedirects > 10) throw new BrowserRuntimeError('BROWSER_LIMIT', 'Browser limits are outside the permitted bounds')
  return result
}

function textFromHtml(html: string): string {
  return html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/\s+/g, ' ').trim()
}

function titleFromHtml(html: string): string {
  return /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.replace(/<[^>]+>/g, '').trim() ?? ''
}

const SENSITIVE_URL_PARAMETER = /(?:pass(?:word)?|secret|token|api[-_]?key|access[-_]?token|refresh[-_]?token|authorization|cookie|credential|private[-_]?key|auth|code)/i

function redactUrlPart(value: string): string {
  if (!value.includes('=')) return redactSensitiveText(value)
  const params = new URLSearchParams(value)
  for (const key of [...params.keys()]) if (SENSITIVE_URL_PARAMETER.test(key)) params.set(key, '[REDACTED]')
  return params.toString()
}

export function browserAuditUrl(value: string): string {
  try {
    const url = new URL(value)
    if (url.username) url.username = '[REDACTED]'
    if (url.password) url.password = '[REDACTED]'
    for (const key of [...url.searchParams.keys()]) if (SENSITIVE_URL_PARAMETER.test(key)) url.searchParams.set(key, '[REDACTED]')
    if (url.hash) url.hash = `#${redactUrlPart(url.hash.slice(1))}`
    return url.href
  } catch {
    return redactSensitiveText(value)
  }
}

function sanitizeAuditValue(value: unknown, key?: string): unknown {
  if (key === 'page_content' || (key !== undefined && SENSITIVE_URL_PARAMETER.test(key))) return '[REDACTED]'
  if (Array.isArray(value)) return value.map((item) => sanitizeAuditValue(item))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [childKey, sanitizeAuditValue(childValue, childKey)]))
  if (typeof value !== 'string') return value
  return /^\w+:\/\//.test(value) ? browserAuditUrl(value) : browserAuditMessage(value)
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (new TextEncoder().encode(value).byteLength <= maxBytes) return value
  let result = ''
  let bytes = 0
  const encoder = new TextEncoder()
  for (const character of value) {
    const characterBytes = encoder.encode(character).byteLength
    if (bytes + characterBytes > maxBytes) break
    result += character
    bytes += characterBytes
  }
  return result
}

export class UnavailableBrowserPort implements BrowserPort {
  private unavailable(): never { throw new BrowserRuntimeError('BROWSER_UNAVAILABLE', 'No browser engine is installed; inject a BrowserPort to enable browser operations') }
  open(): Promise<BrowserTab> { return this.unavailable() }
  navigate(): Promise<BrowserTab> { return this.unavailable() }
  back(): Promise<BrowserTab> { return this.unavailable() }
  forward(): Promise<BrowserTab> { return this.unavailable() }
  tabs(): Promise<BrowserTab[]> { return this.unavailable() }
  read(): Promise<BrowserTab> { return this.unavailable() }
  find(): Promise<{ query: string; matches: Array<{ index: number; text: string }> }> { return this.unavailable() }
  screenshot(): Promise<{ mimeType: string; data: string }> { return this.unavailable() }
  wait(): Promise<{ waitedMs: number }> { return this.unavailable() }
}

/** A network-backed fake for tests and installations without Playwright. It is not live browser automation. */
export class FakeBrowserPort implements BrowserPort {
  private readonly pages = new Map<string, Map<string, { tab: BrowserTab; history: BrowserTab[]; cursor: number }>>()
  constructor(private readonly fetchImpl?: (input: string | URL, init?: RequestInit) => Promise<Response>, private readonly resolver?: (hostname: string) => Promise<readonly string[]>) {}
  private store(sessionId: string) { let value = this.pages.get(sessionId); if (!value) { value = new Map(); this.pages.set(sessionId, value) } return value }
  private async load(sessionId: string, tabId: string, url: string, limits: BrowserLimits): Promise<BrowserTab> {
    let response: Response
    try { response = await fetchWithNetworkPolicy(url, {}, { allowedHosts: [new URL(url).hostname], timeoutMs: limits.timeoutMs, maxResponseBytes: limits.maxPageBytes, maxRedirects: limits.maxRedirects }, this.fetchImpl, this.resolver) } catch (error) { throw error }
    const html = await readBoundedResponse(response, limits.maxPageBytes)
    const tab = { id: tabId, url: new URL(url).href, title: titleFromHtml(html), text: textFromHtml(html), status: response.status, openedAt: Date.now() }
    const pages = this.store(sessionId); const old = pages.get(tabId)
    pages.set(tabId, { tab, history: old ? [...old.history.slice(0, old.cursor + 1), tab] : [tab], cursor: old ? old.cursor + 1 : 0 })
    return tab
  }
  async open(sessionId: string, url: string, limits: BrowserLimits) { const pages = this.store(sessionId); const id = `tab-${pages.size + 1}`; return this.load(sessionId, id, url, limits) }
  async navigate(sessionId: string, tabId: string, url: string, limits: BrowserLimits) { if (!this.store(sessionId).has(tabId)) throw new BrowserRuntimeError('BROWSER_SESSION_NOT_FOUND', 'Tab not found'); return this.load(sessionId, tabId, url, limits) }
  async back(sessionId: string, tabId: string) { const item = this.store(sessionId).get(tabId); if (!item || item.cursor < 1) throw new BrowserRuntimeError('BROWSER_INVALID_INPUT', 'No previous page is available'); item.cursor--; item.tab = item.history[item.cursor]!; return item.tab }
  async forward(sessionId: string, tabId: string) { const item = this.store(sessionId).get(tabId); if (!item || item.cursor >= item.history.length - 1) throw new BrowserRuntimeError('BROWSER_INVALID_INPUT', 'No next page is available'); item.cursor++; item.tab = item.history[item.cursor]!; return item.tab }
  async tabs(sessionId: string) { return [...this.store(sessionId).values()].map((item) => item.tab) }
  async read(sessionId: string, tabId?: string, maxTextBytes = DEFAULT_BROWSER_LIMITS.maxTextBytes) { const item = this.store(sessionId).get(tabId ?? [...this.store(sessionId).keys()][0]); if (!item) throw new BrowserRuntimeError('BROWSER_INVALID_INPUT', 'No browser tab is open'); return { ...item.tab, text: truncateUtf8(item.tab.text, maxTextBytes) } }
  async find(sessionId: string, query: string, tabId?: string) { const tab = await this.read(sessionId, tabId); const matches: Array<{ index: number; text: string }> = []; let at = tab.text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase()); while (at >= 0 && matches.length < 100) { matches.push({ index: at, text: tab.text.slice(Math.max(0, at - 80), at + query.length + 80) }); at = tab.text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase(), at + query.length) } return { query, matches } }
  async screenshot(_sessionId: string, _tabId?: string): Promise<{ mimeType: string; data: string }> { throw new BrowserRuntimeError('BROWSER_UNAVAILABLE', 'The fake browser does not render screenshots') }
  async wait(_sessionId: string, milliseconds: number) { await new Promise((resolve) => setTimeout(resolve, milliseconds)); return { waitedMs: milliseconds } }
}

export type BrowserServiceOptions = { port?: BrowserPort; now?: () => number }
let configuredPort: BrowserPort | undefined
export function configureBrowserPort(port: BrowserPort | undefined): void { configuredPort = port }

export class BrowserSessionService {
  private readonly port: BrowserPort
  private readonly now: () => number
  constructor(private readonly client: PocketBase, options: BrowserServiceOptions = {}) { this.port = options.port ?? configuredPort ?? new UnavailableBrowserPort(); this.now = options.now ?? Date.now }
  private collection() { return this.client.collection('browser_sessions') }
  private auditCollection() { return this.client.collection('browser_audit') }
  private async audit(ownerId: string, sessionId: string, action: string, details: Record<string, unknown> = {}) { await this.auditCollection().create({ owner_id: ownerId, browser_session_id: sessionId, action, details: sanitizeAuditValue(details), created_at: this.now() }) }
  private record(value: Record<string, unknown>): BrowserSession { const tabs = Array.isArray(value.tabs) ? value.tabs as BrowserTab[] : []; return { id: String(value.id), owner_id: String(value.owner_id), ...(typeof value.project_id === 'string' && value.project_id ? { project_id: value.project_id } : {}), ...(typeof value.session_id === 'string' && value.session_id ? { session_id: value.session_id } : {}), ...(typeof value.task_id === 'string' && value.task_id ? { task_id: value.task_id } : {}), lifecycle: value.lifecycle === 'closed' ? 'closed' : 'open', ...(typeof value.current_tab_id === 'string' ? { current_tab_id: value.current_tab_id } : {}), ...(typeof value.current_url === 'string' ? { current_url: browserAuditUrl(value.current_url) } : {}), tabs: tabs.map((tab) => ({ ...tab, url: browserAuditUrl(tab.url) })), limits: safeLimits((value.limits ?? {}) as Partial<BrowserLimits>), created_at: Number(value.created_at), updated_at: Number(value.updated_at), ...(typeof value.closed_at === 'number' ? { closed_at: value.closed_at } : {}) } }
  private tabMetadata(tabs: BrowserTab[]): BrowserTabMetadata[] { return tabs.map(({ text: _text, ...metadata }) => ({ ...metadata, url: browserAuditUrl(metadata.url) })) }
  private scopesMatch(context: BrowserContext, session: BrowserSession): boolean { return session.project_id === context.projectId && session.session_id === context.sessionId && session.task_id === context.taskId }
  private async owned(context: BrowserContext, id: string): Promise<BrowserSession> { const item = await this.collection().getOne(id).catch(() => null); if (!item || String(item.owner_id) !== context.ownerId) throw new BrowserRuntimeError('BROWSER_SESSION_NOT_FOUND', 'Browser session is not owned by the requested context'); const session = this.record(item); if (!this.scopesMatch(context, session)) throw new BrowserRuntimeError('BROWSER_SESSION_NOT_FOUND', 'Browser session is not owned by the requested context'); if (session.lifecycle !== 'open') throw new BrowserRuntimeError('BROWSER_SESSION_CLOSED', 'Browser session is closed'); return session }
  private async assertScope(context: BrowserContext): Promise<void> { if (context.projectId) { const project = await this.client.collection('projects').getOne(context.projectId).catch(() => null); if (!project || String(project.user_id) !== context.ownerId) throw new BrowserRuntimeError('BROWSER_SESSION_NOT_FOUND', 'Project is not owned by the requesting user') } if (context.sessionId) { const session = await this.client.collection('sessions').getFirstListItem(`user_id = "${context.ownerId.replaceAll('"', '\\"')}" && session_id = "${context.sessionId.replaceAll('"', '\\"')}"`).catch(() => null); if (!session || (context.projectId !== undefined && String(session.project_id ?? '') !== context.projectId)) throw new BrowserRuntimeError('BROWSER_SESSION_NOT_FOUND', 'Pi session is not owned by the requesting user') } if (context.taskId) { const task = await this.client.collection('tasks').getOne(context.taskId).catch(() => null); if (!task || String(task.owner_id) !== context.ownerId || (context.projectId !== undefined && String(task.project_id ?? '') !== context.projectId) || (context.sessionId !== undefined && String(task.session_id ?? '') !== context.sessionId)) throw new BrowserRuntimeError('BROWSER_SESSION_NOT_FOUND', 'Task is not owned by the requested context') } }
  async create(context: BrowserContext, limits?: Partial<BrowserLimits>): Promise<BrowserSession> { if (!context.ownerId.trim()) throw new BrowserRuntimeError('BROWSER_INVALID_INPUT', 'Browser session owner is required'); await this.assertScope(context); const now = this.now(); const session = this.record(await this.collection().create({ owner_id: context.ownerId, ...(context.projectId ? { project_id: context.projectId } : {}), ...(context.sessionId ? { session_id: context.sessionId } : {}), ...(context.taskId ? { task_id: context.taskId } : {}), lifecycle: 'open', tabs: [], limits: safeLimits(limits), created_at: now, updated_at: now })); await this.audit(context.ownerId, session.id, 'session.create', { project_id: session.project_id, session_id: session.session_id, task_id: session.task_id }); return session }
  async list(context: BrowserContext) { const items = await this.collection().getFullList({ filter: `owner_id = "${context.ownerId.replaceAll('"', '\\"')}"`, sort: '-created_at' }); return items.map((item) => this.record(item)).filter((item) => this.scopesMatch(context, item)) }
  async get(context: BrowserContext, id: string) { return this.owned(context, id) }
  async close(context: BrowserContext, id: string) { await this.owned(context, id); const closed = this.record(await this.collection().update(id, { lifecycle: 'closed', closed_at: this.now(), updated_at: this.now() })); await this.audit(context.ownerId, id, 'session.close'); return closed }
  async execute(context: BrowserContext, operation: string, input: Record<string, unknown>): Promise<unknown> {
    const session = await this.owned({ ...context, ...(typeof input.taskId === 'string' ? { taskId: input.taskId } : {}) }, String(input.browserSessionId ?? '')); const limits = session.limits; const tabId = typeof input.tabId === 'string' ? input.tabId : session.current_tab_id
    let result: unknown
    if (operation === 'open') {
      const existingTabs = await this.port.tabs(session.id)
      if (existingTabs.length >= limits.maxTabs) throw new BrowserRuntimeError('BROWSER_LIMIT', `Browser tab limit ${limits.maxTabs} exceeded`)
      result = await this.port.open(session.id, String(input.url ?? ''), limits)
    }
    else if (operation === 'navigate') result = await this.port.navigate(session.id, String(tabId ?? ''), String(input.url ?? ''), limits)
    else if (operation === 'back') result = await this.port.back(session.id, String(tabId ?? ''))
    else if (operation === 'forward') result = await this.port.forward(session.id, String(tabId ?? ''))
    else if (operation === 'tabs') result = await this.port.tabs(session.id)
    else if (operation === 'read') result = await this.port.read(session.id, tabId, limits.maxTextBytes)
    else if (operation === 'find') result = await this.port.find(session.id, String(input.query ?? ''), tabId)
    else if (operation === 'screenshot') result = await this.port.screenshot(session.id, tabId)
    else if (operation === 'wait') { const milliseconds = Math.min(Math.max(Math.trunc(Number(input.milliseconds ?? 250)), 0), limits.timeoutMs); result = await this.port.wait(session.id, milliseconds) }
    else throw new BrowserRuntimeError('BROWSER_INVALID_INPUT', `Unknown browser operation: ${operation}`)
    if (result && typeof result === 'object' && 'text' in result && typeof result.text === 'string') result = { ...result, text: truncateUtf8(result.text, limits.maxTextBytes) }
    const tabs = await this.port.tabs(session.id).catch(() => [])
    if (tabs.length > limits.maxTabs) throw new BrowserRuntimeError('BROWSER_LIMIT', `Browser tab limit ${limits.maxTabs} exceeded`)
    const current = result && typeof result === 'object' && 'id' in result ? result as BrowserTab : undefined
    await this.collection().update(session.id, { tabs: this.tabMetadata(tabs), ...(current ? { current_tab_id: current.id, current_url: current.url } : {}), updated_at: this.now() })
    await this.audit(context.ownerId, session.id, `tool.${operation}`, { tab_id: current?.id, url: current?.url, query: operation === 'find' ? String(input.query ?? '') : undefined })
    return result
  }
}

export const browserNetworkPolicy = (limits: BrowserLimits): NetworkPolicyOptions => networkPolicyFromMetadata({ timeoutMs: limits.timeoutMs, maxResponseBytes: limits.maxPageBytes, maxRedirects: limits.maxRedirects })
export function browserAuditMessage(value: unknown): string {
  const text = typeof value === 'string' ? value : ''
  return /^\w+:\/\//.test(text) ? browserAuditUrl(text) : redactSensitiveText(text)
}
