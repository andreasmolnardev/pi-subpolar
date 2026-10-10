import { configuredWorkerPort } from './worker-port.ts'
import type PocketBase from 'pocketbase'
import {
  fetchWithNetworkPolicy,
  networkPolicyFromMetadata,
  readBoundedResponse,
  type NetworkPolicyOptions,
} from '../core/network-policy.ts'
import { redactSensitiveText } from '../core/security-redaction.ts'

export type BrowserLifecycle = 'open' | 'closed'
export type BrowserTab = {
  id: string
  url: string
  title: string
  text: string
  status: number
  openedAt: number
}
type BrowserTabMetadata = Omit<BrowserTab, 'text'>
export type BrowserLimits = {
  timeoutMs: number
  maxPageBytes: number
  maxTextBytes: number
  maxTabs: number
  maxRedirects: number
}
export type BrowserSession = {
  id: string
  owner_id: string
  project_id?: string
  session_id?: string
  task_id?: string
  profile_id?: string
  lifecycle: BrowserLifecycle
  current_tab_id?: string
  current_url?: string
  tabs: BrowserTab[]
  limits: BrowserLimits
  created_at: number
  updated_at: number
  closed_at?: number
}

export type BrowserContext = {
  ownerId: string
  projectId?: string
  sessionId?: string
  taskId?: string
  agentName?: string
  readOnly?: boolean
  allowedProfileIds?: string[]
  defaultProfileId?: string
  allowEphemeral?: boolean
  callId?: string
  manualLeaseId?: string
}
export const BROWSER_POLICY_GROUPS = [
  'read',
  'navigation',
  'form-interaction',
  'upload',
  'download',
  'submit',
  'destructive',
] as const
export type BrowserPolicyGroup = (typeof BROWSER_POLICY_GROUPS)[number]
export function browserProfileAllows(
  group: string,
  readOnly: boolean,
): boolean {
  return !readOnly || group === 'read' || group === 'navigation'
}
/** Each sessionId is an opaque owner/scope lease, not a durable database id.
 * Implementations must isolate cookies, storage and authentication per lease. */
export type BrowserPort = {
  start?(
    sessionId: string,
    options: { profileId?: string; limits: BrowserLimits },
  ): Promise<unknown>
  action?(
    sessionId: string,
    operation: string,
    input: Record<string, unknown>,
    tabId?: string,
  ): Promise<unknown>
  clearProfile?(profileId: string): Promise<void>
  health?(): Promise<unknown>
  close?(sessionId: string): Promise<void>
  open(
    sessionId: string,
    url: string,
    limits: BrowserLimits,
  ): Promise<BrowserTab>
  navigate(
    sessionId: string,
    tabId: string,
    url: string,
    limits: BrowserLimits,
  ): Promise<BrowserTab>
  back(sessionId: string, tabId: string): Promise<BrowserTab>
  forward(sessionId: string, tabId: string): Promise<BrowserTab>
  tabs(sessionId: string): Promise<BrowserTab[]>
  read(
    sessionId: string,
    tabId?: string,
    maxTextBytes?: number,
  ): Promise<BrowserTab>
  find(
    sessionId: string,
    query: string,
    tabId?: string,
  ): Promise<{
    query: string
    matches: Array<{ index: number; text: string }>
  }>
  screenshot(
    sessionId: string,
    tabId?: string,
  ): Promise<{ mimeType: string; data: string }>
  wait(sessionId: string, milliseconds: number): Promise<{ waitedMs: number }>
}

export class BrowserRuntimeError extends Error {
  constructor(
    readonly code:
      | 'BROWSER_UNAVAILABLE'
      | 'BROWSER_SESSION_NOT_FOUND'
      | 'BROWSER_SESSION_CLOSED'
      | 'BROWSER_LIMIT'
      | 'BROWSER_POLICY'
      | 'BROWSER_INVALID_INPUT'
      | 'BROWSER_PROFILE_DENIED'
      | 'BROWSER_PROFILE_BUSY'
      | 'BROWSER_CONTROL_BUSY'
      | 'BROWSER_CONTROLLER_EXPIRED',
    message: string,
  ) {
    super(message)
    this.name = 'BrowserRuntimeError'
  }
}

export const DEFAULT_BROWSER_LIMITS: BrowserLimits = {
  timeoutMs: 15_000,
  maxPageBytes: 4 * 1024 * 1024,
  maxTextBytes: 128 * 1024,
  maxTabs: 8,
  maxRedirects: 3,
}

function safeLimits(input?: Partial<BrowserLimits>): BrowserLimits {
  const result = { ...DEFAULT_BROWSER_LIMITS, ...(input ?? {}) }
  if (
    !Number.isInteger(result.timeoutMs) ||
    result.timeoutMs < 1 ||
    result.timeoutMs > 60_000 ||
    !Number.isInteger(result.maxPageBytes) ||
    result.maxPageBytes < 1 ||
    result.maxPageBytes > 16 * 1024 * 1024 ||
    !Number.isInteger(result.maxTextBytes) ||
    result.maxTextBytes < 1 ||
    result.maxTextBytes > 512 * 1024 ||
    !Number.isInteger(result.maxTabs) ||
    result.maxTabs < 1 ||
    result.maxTabs > 32 ||
    !Number.isInteger(result.maxRedirects) ||
    result.maxRedirects < 0 ||
    result.maxRedirects > 10
  )
    throw new BrowserRuntimeError(
      'BROWSER_LIMIT',
      'Browser limits are outside the permitted bounds',
    )
  return result
}

function textFromHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim()
}

function titleFromHtml(html: string): string {
  return (
    /<title[^>]*>([\s\S]*?)<\/title>/i
      .exec(html)?.[1]
      ?.replace(/<[^>]+>/g, '')
      .trim() ?? ''
  )
}

const SENSITIVE_URL_PARAMETER =
  /(?:pass(?:word)?|secret|token|api[-_]?key|access[-_]?token|refresh[-_]?token|authorization|cookie|credential|private[-_]?key|auth|code)/i

function redactUrlPart(value: string): string {
  if (!value.includes('=')) return redactSensitiveText(value)
  const params = new URLSearchParams(value)
  for (const key of [...params.keys()])
    if (SENSITIVE_URL_PARAMETER.test(key)) params.set(key, '[REDACTED]')
  return params.toString()
}

export function browserAuditUrl(value: string): string {
  try {
    const url = new URL(value)
    if (url.username) url.username = '[REDACTED]'
    if (url.password) url.password = '[REDACTED]'
    for (const key of [...url.searchParams.keys()])
      if (SENSITIVE_URL_PARAMETER.test(key))
        url.searchParams.set(key, '[REDACTED]')
    if (url.hash) url.hash = `#${redactUrlPart(url.hash.slice(1))}`
    return url.href
  } catch {
    return redactSensitiveText(value)
  }
}

function sanitizeAuditValue(value: unknown, key?: string): unknown {
  if (
    key === 'page_content' ||
    (key !== undefined && SENSITIVE_URL_PARAMETER.test(key))
  )
    return '[REDACTED]'
  if (Array.isArray(value)) return value.map((item) => sanitizeAuditValue(item))
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [
        childKey,
        sanitizeAuditValue(childValue, childKey),
      ]),
    )
  if (typeof value !== 'string') return value
  return /^\w+:\/\//.test(value)
    ? browserAuditUrl(value)
    : browserAuditMessage(value)
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
  private unavailable(): never {
    throw new BrowserRuntimeError(
      'BROWSER_UNAVAILABLE',
      'No browser engine is installed; inject a BrowserPort to enable browser operations',
    )
  }
  open(): Promise<BrowserTab> {
    return this.unavailable()
  }
  navigate(): Promise<BrowserTab> {
    return this.unavailable()
  }
  back(): Promise<BrowserTab> {
    return this.unavailable()
  }
  forward(): Promise<BrowserTab> {
    return this.unavailable()
  }
  tabs(): Promise<BrowserTab[]> {
    return this.unavailable()
  }
  read(): Promise<BrowserTab> {
    return this.unavailable()
  }
  find(): Promise<{
    query: string
    matches: Array<{ index: number; text: string }>
  }> {
    return this.unavailable()
  }
  screenshot(): Promise<{ mimeType: string; data: string }> {
    return this.unavailable()
  }
  wait(): Promise<{ waitedMs: number }> {
    return this.unavailable()
  }
}

/** A network-backed fake for tests and installations without Playwright. It is not live browser automation. */
export class FakeBrowserPort implements BrowserPort {
  private readonly pages = new Map<
    string,
    Map<string, { tab: BrowserTab; history: BrowserTab[]; cursor: number }>
  >()
  constructor(
    private readonly fetchImpl?: (
      input: string | URL,
      init?: RequestInit,
    ) => Promise<Response>,
    private readonly resolver?: (
      hostname: string,
    ) => Promise<readonly string[]>,
  ) {}
  private store(sessionId: string) {
    let value = this.pages.get(sessionId)
    if (!value) {
      value = new Map()
      this.pages.set(sessionId, value)
    }
    return value
  }
  private async load(
    sessionId: string,
    tabId: string,
    url: string,
    limits: BrowserLimits,
  ): Promise<BrowserTab> {
    let response: Response
    try {
      response = await fetchWithNetworkPolicy(
        url,
        {},
        {
          allowedHosts: [new URL(url).hostname],
          timeoutMs: limits.timeoutMs,
          maxResponseBytes: limits.maxPageBytes,
          maxRedirects: limits.maxRedirects,
        },
        this.fetchImpl,
        this.resolver,
      )
    } catch (error) {
      throw error
    }
    const html = await readBoundedResponse(response, limits.maxPageBytes)
    const tab = {
      id: tabId,
      url: new URL(url).href,
      title: titleFromHtml(html),
      text: textFromHtml(html),
      status: response.status,
      openedAt: Date.now(),
    }
    const pages = this.store(sessionId)
    const old = pages.get(tabId)
    pages.set(tabId, {
      tab,
      history: old ? [...old.history.slice(0, old.cursor + 1), tab] : [tab],
      cursor: old ? old.cursor + 1 : 0,
    })
    return tab
  }
  async close(sessionId: string) {
    this.pages.delete(sessionId)
  }
  async open(sessionId: string, url: string, limits: BrowserLimits) {
    const pages = this.store(sessionId)
    const id = `tab-${pages.size + 1}`
    return this.load(sessionId, id, url, limits)
  }
  async navigate(
    sessionId: string,
    tabId: string,
    url: string,
    limits: BrowserLimits,
  ) {
    if (!this.store(sessionId).has(tabId))
      throw new BrowserRuntimeError(
        'BROWSER_SESSION_NOT_FOUND',
        'Tab not found',
      )
    return this.load(sessionId, tabId, url, limits)
  }
  async back(sessionId: string, tabId: string) {
    const item = this.store(sessionId).get(tabId)
    if (!item || item.cursor < 1)
      throw new BrowserRuntimeError(
        'BROWSER_INVALID_INPUT',
        'No previous page is available',
      )
    item.cursor--
    item.tab = item.history[item.cursor]!
    return item.tab
  }
  async forward(sessionId: string, tabId: string) {
    const item = this.store(sessionId).get(tabId)
    if (!item || item.cursor >= item.history.length - 1)
      throw new BrowserRuntimeError(
        'BROWSER_INVALID_INPUT',
        'No next page is available',
      )
    item.cursor++
    item.tab = item.history[item.cursor]!
    return item.tab
  }
  async tabs(sessionId: string) {
    return [...this.store(sessionId).values()].map((item) => item.tab)
  }
  async read(
    sessionId: string,
    tabId?: string,
    maxTextBytes = DEFAULT_BROWSER_LIMITS.maxTextBytes,
  ) {
    const item = this.store(sessionId).get(
      tabId ?? [...this.store(sessionId).keys()][0],
    )
    if (!item)
      throw new BrowserRuntimeError(
        'BROWSER_INVALID_INPUT',
        'No browser tab is open',
      )
    return { ...item.tab, text: truncateUtf8(item.tab.text, maxTextBytes) }
  }
  async find(sessionId: string, query: string, tabId?: string) {
    const tab = await this.read(sessionId, tabId)
    const matches: Array<{ index: number; text: string }> = []
    let at = tab.text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase())
    while (at >= 0 && matches.length < 100) {
      matches.push({
        index: at,
        text: tab.text.slice(Math.max(0, at - 80), at + query.length + 80),
      })
      at = tab.text
        .toLocaleLowerCase()
        .indexOf(query.toLocaleLowerCase(), at + query.length)
    }
    return { query, matches }
  }
  async screenshot(
    _sessionId: string,
    _tabId?: string,
  ): Promise<{ mimeType: string; data: string }> {
    throw new BrowserRuntimeError(
      'BROWSER_UNAVAILABLE',
      'The fake browser does not render screenshots',
    )
  }
  async wait(_sessionId: string, milliseconds: number) {
    await new Promise((resolve) => setTimeout(resolve, milliseconds))
    return { waitedMs: milliseconds }
  }
}

export type BrowserServiceOptions = { port?: BrowserPort; now?: () => number }
const takingControl = new Set<string>()
const controllers = new Map<
  string,
  { leaseId: string; ownerId: string; expiresAt: number }
>()
const frameTimes = new Map<string, number>()
const operations = new Map<string, Promise<unknown>>()
let configuredPort: BrowserPort | undefined
export function configureBrowserPort(port: BrowserPort | undefined): void {
  configuredPort = port
}

export class BrowserSessionService {
  private readonly port: BrowserPort
  private readonly now: () => number
  constructor(
    private readonly client: PocketBase,
    options: BrowserServiceOptions = {},
  ) {
    this.port =
      options.port ??
      configuredPort ??
      configuredWorkerPort() ??
      new UnavailableBrowserPort()
    this.now = options.now ?? Date.now
  }
  private collection() {
    return this.client.collection('browser_sessions')
  }
  private auditCollection() {
    return this.client.collection('browser_audit')
  }
  private async audit(
    ownerId: string,
    sessionId: string,
    action: string,
    details: Record<string, unknown> = {},
  ) {
    await this.auditCollection().create({
      owner_id: ownerId,
      browser_session_id:
        sessionId || `profile:${String(details.profile_id ?? '')}`,
      action,
      details: sanitizeAuditValue(details),
      created_at: this.now(),
    })
  }
  private record(value: Record<string, unknown>): BrowserSession {
    const tabs = Array.isArray(value.tabs) ? (value.tabs as BrowserTab[]) : []
    return {
      id: String(value.id),
      owner_id: String(value.owner_id),
      ...(typeof value.project_id === 'string' && value.project_id
        ? { project_id: value.project_id }
        : {}),
      ...(typeof value.session_id === 'string' && value.session_id
        ? { session_id: value.session_id }
        : {}),
      ...(typeof value.profile_id === 'string' && value.profile_id
        ? { profile_id: value.profile_id }
        : {}),
      ...(typeof value.task_id === 'string' && value.task_id
        ? { task_id: value.task_id }
        : {}),
      lifecycle: value.lifecycle === 'closed' ? 'closed' : 'open',
      ...(typeof value.current_tab_id === 'string'
        ? { current_tab_id: value.current_tab_id }
        : {}),
      ...(typeof value.current_url === 'string'
        ? { current_url: browserAuditUrl(value.current_url) }
        : {}),
      tabs: tabs.map((tab) => ({ ...tab, url: browserAuditUrl(tab.url) })),
      limits: safeLimits((value.limits ?? {}) as Partial<BrowserLimits>),
      created_at: Number(value.created_at),
      updated_at: Number(value.updated_at),
      ...(typeof value.closed_at === 'number'
        ? { closed_at: value.closed_at }
        : {}),
    }
  }
  private tabMetadata(tabs: BrowserTab[]): BrowserTabMetadata[] {
    return tabs.map(({ text: _text, ...metadata }) => ({
      ...metadata,
      url: browserAuditUrl(metadata.url),
    }))
  }
  private lease(session: BrowserSession): string {
    return JSON.stringify([
      session.owner_id,
      session.project_id ?? null,
      session.session_id ?? null,
      session.task_id ?? null,
      session.id,
    ])
  }
  private scopesMatch(
    context: BrowserContext,
    session: BrowserSession,
  ): boolean {
    return (
      session.project_id === context.projectId &&
      session.session_id === context.sessionId &&
      session.task_id === context.taskId
    )
  }
  private async owned(
    context: BrowserContext,
    id: string,
  ): Promise<BrowserSession> {
    const item = await this.collection()
      .getOne(id)
      .catch(() => null)
    if (!item || String(item.owner_id) !== context.ownerId)
      throw new BrowserRuntimeError(
        'BROWSER_SESSION_NOT_FOUND',
        'Browser session is not owned by the requested context',
      )
    const session = this.record(item)
    if (!this.scopesMatch(context, session))
      throw new BrowserRuntimeError(
        'BROWSER_SESSION_NOT_FOUND',
        'Browser session is not owned by the requested context',
      )
    if (session.lifecycle !== 'open')
      throw new BrowserRuntimeError(
        'BROWSER_SESSION_CLOSED',
        'Browser session is closed',
      )
    return session
  }
  private async assertScope(context: BrowserContext): Promise<void> {
    if (context.projectId) {
      const project = await this.client
        .collection('projects')
        .getOne(context.projectId)
        .catch(() => null)
      if (!project || String(project.user_id) !== context.ownerId)
        throw new BrowserRuntimeError(
          'BROWSER_SESSION_NOT_FOUND',
          'Project is not owned by the requesting user',
        )
    }
    if (context.sessionId) {
      const session = await this.client
        .collection('sessions')
        .getFirstListItem(
          `user_id = "${context.ownerId.replaceAll('"', '\\"')}" && session_id = "${context.sessionId.replaceAll('"', '\\"')}"`,
        )
        .catch(() => null)
      if (
        !session ||
        session.user_id !== context.ownerId ||
        session.session_id !== context.sessionId ||
        (context.projectId !== undefined &&
          String(session.project_id ?? '') !== context.projectId)
      )
        throw new BrowserRuntimeError(
          'BROWSER_SESSION_NOT_FOUND',
          'Pi session is not owned by the requesting user',
        )
    }
    if (context.taskId) {
      const task = await this.client
        .collection('tasks')
        .getOne(context.taskId)
        .catch(() => null)
      if (
        !task ||
        String(task.owner_id) !== context.ownerId ||
        (context.projectId !== undefined &&
          String(task.project_id ?? '') !== context.projectId) ||
        (context.sessionId !== undefined &&
          String(task.session_id ?? '') !== context.sessionId)
      )
        throw new BrowserRuntimeError(
          'BROWSER_SESSION_NOT_FOUND',
          'Task is not owned by the requested context',
        )
    }
  }
  async create(
    context: BrowserContext,
    limits?: Partial<BrowserLimits>,
    profileId?: string,
  ): Promise<BrowserSession> {
    if (!context.ownerId.trim())
      throw new BrowserRuntimeError(
        'BROWSER_INVALID_INPUT',
        'Browser session owner is required',
      )
    await this.assertScope(context)
    profileId ??= context.defaultProfileId
    await this.authorizeProfile(context, profileId)
    const now = this.now()
    const session = this.record(
      await this.collection().create({
        owner_id: context.ownerId,
        ...(context.projectId ? { project_id: context.projectId } : {}),
        ...(context.sessionId ? { session_id: context.sessionId } : {}),
        ...(context.taskId ? { task_id: context.taskId } : {}),
        ...(profileId ? { profile_id: profileId } : {}),
        lifecycle: 'open',
        tabs: [],
        limits: safeLimits(limits),
        created_at: now,
        updated_at: now,
      }),
    )
    try {
      await this.port.start?.(this.lease(session), {
        profileId,
        limits: session.limits,
      })
    } catch (error) {
      await this.collection().update(session.id, {
        lifecycle: 'closed',
        closed_at: this.now(),
      })
      throw error
    }
    await this.audit(context.ownerId, session.id, 'session.create', {
      project_id: session.project_id,
      session_id: session.session_id,
      task_id: session.task_id,
    })
    return session
  }
  async list(context: BrowserContext) {
    const items = await this.collection().getFullList({
      filter: `owner_id = "${context.ownerId.replaceAll('"', '\\"')}"`,
      sort: '-created_at',
    })
    return items
      .filter((item) => item.owner_id === context.ownerId)
      .map((item) => this.record(item))
      .filter((item) => this.scopesMatch(context, item))
  }
  async get(context: BrowserContext, id: string) {
    return this.owned(context, id)
  }
  async close(context: BrowserContext, id: string) {
    const session = await this.owned(context, id)
    await this.port.close?.(this.lease(session))
    const closed = this.record(
      await this.collection().update(id, {
        lifecycle: 'closed',
        closed_at: this.now(),
        updated_at: this.now(),
      }),
    )
    controllers.delete(id)
    frameTimes.delete(this.lease(session))
    await this.audit(context.ownerId, id, 'session.close')
    return closed
  }
  async execute(
    context: BrowserContext,
    operation: string,
    input: Record<string, unknown>,
  ): Promise<unknown> {
    const id = String(input.browserSessionId ?? '')
    const key = `${context.ownerId}:${id}`
    const previous = operations.get(key) ?? Promise.resolve()
    const pending = previous
      .catch(() => {})
      .then(() => this.executeLocked(context, operation, input))
    operations.set(key, pending)
    try {
      return await pending
    } finally {
      if (operations.get(key) === pending) operations.delete(key)
    }
  }
  private async executeLocked(
    context: BrowserContext,
    operation: string,
    input: Record<string, unknown>,
  ): Promise<unknown> {
    const session = await this.owned(
      context,
      String(input.browserSessionId ?? ''),
    )
    await this.authorizeProfile(context, session.profile_id)
    if (takingControl.has(session.id))
      throw new BrowserRuntimeError(
        'BROWSER_CONTROL_BUSY',
        'Manual takeover is pending',
      )
    const control = this.controller(session.id)
    if (control && context.manualLeaseId !== control.leaseId)
      throw new BrowserRuntimeError(
        'BROWSER_CONTROL_BUSY',
        'Browser is under manual control',
      )
    if (context.manualLeaseId && context.manualLeaseId !== control?.leaseId)
      throw new BrowserRuntimeError(
        'BROWSER_CONTROLLER_EXPIRED',
        'Manual control lease expired',
      )
    const limits = session.limits
    const tabId =
      typeof input.tabId === 'string' ? input.tabId : session.current_tab_id
    await this.assertScope({
      ownerId: session.owner_id,
      projectId: session.project_id,
      sessionId: session.session_id,
      taskId: session.task_id,
    })
    const lease = this.lease(session)
    let result: unknown
    try {
      if (operation === 'open') {
        const existingTabs = await this.port.tabs(lease)
        if (existingTabs.length >= limits.maxTabs)
          throw new BrowserRuntimeError(
            'BROWSER_LIMIT',
            `Browser tab limit ${limits.maxTabs} exceeded`,
          )
        result = await this.port.open(lease, String(input.url ?? ''), limits)
      } else if (operation === 'navigate')
        result = await this.port.navigate(
          lease,
          String(tabId ?? ''),
          String(input.url ?? ''),
          limits,
        )
      else if (operation === 'back')
        result = await this.port.back(lease, String(tabId ?? ''))
      else if (operation === 'forward')
        result = await this.port.forward(lease, String(tabId ?? ''))
      else if (operation === 'tabs') result = await this.port.tabs(lease)
      else if (operation === 'read')
        result = await this.port.read(lease, tabId, limits.maxTextBytes)
      else if (operation === 'find')
        result = await this.port.find(lease, String(input.query ?? ''), tabId)
      else if (operation === 'screenshot')
        result = await this.port.screenshot(lease, tabId)
      else if (operation === 'wait') {
        const milliseconds = Math.min(
          Math.max(Math.trunc(Number(input.milliseconds ?? 250)), 0),
          limits.timeoutMs,
        )
        result = await this.port.wait(lease, milliseconds)
      } else if (BROWSER_ACTIONS.includes(operation) && this.port.action)
        result = await this.port.action(lease, operation, input, tabId)
      else
        throw new BrowserRuntimeError(
          'BROWSER_INVALID_INPUT',
          `Unknown or unsupported browser operation: ${operation}`,
        )
      if (
        result &&
        typeof result === 'object' &&
        'text' in result &&
        typeof result.text === 'string'
      )
        result = {
          ...result,
          text: truncateUtf8(result.text, limits.maxTextBytes),
        }
      const tabs = await this.port.tabs(lease).catch(() => [])
      if (tabs.length > limits.maxTabs)
        throw new BrowserRuntimeError(
          'BROWSER_LIMIT',
          `Browser tab limit ${limits.maxTabs} exceeded`,
        )
      const current =
        result && typeof result === 'object' && 'id' in result
          ? (result as BrowserTab)
          : (tabs.find((tab) => tab.id === session.current_tab_id) ?? tabs[0])
      await this.collection().update(session.id, {
        tabs: this.tabMetadata(tabs),
        ...(current
          ? { current_tab_id: current.id, current_url: current.url }
          : { current_tab_id: '', current_url: '' }),
        updated_at: this.now(),
      })
      await this.audit(context.ownerId, session.id, `tool.${operation}`, {
        tab_id: current?.id,
        url: current?.url,
      })
    } catch (error) {
      if (context.callId && !context.manualLeaseId)
        await this.captureArtifact(context, session, operation, tabId)
      throw error
    }
    if (
      operation === 'download' &&
      result &&
      typeof result === 'object' &&
      'data' in result
    ) {
      result = {
        downloadArtifact: await this.persistDownload(
          context,
          session,
          result as { name: string; mimeType: string; data: string },
        ),
      }
    }
    if (context.manualLeaseId) return { ok: true }
    if (context.callId && !context.manualLeaseId) {
      const artifact = await this.captureArtifact(
        context,
        session,
        operation,
        tabId,
        operation === 'screenshot' ? result : undefined,
      )
      result =
        result && typeof result === 'object' && !Array.isArray(result)
          ? { ...result, screenshotArtifact: artifact }
          : { result, screenshotArtifact: artifact }
    }
    return result
  }
  private async authorizeProfile(context: BrowserContext, profileId?: string) {
    if (!profileId) {
      if (context.agentName && context.allowEphemeral === false)
        throw new BrowserRuntimeError(
          'BROWSER_PROFILE_DENIED',
          'Ephemeral browsing is disabled',
        )
      return
    }
    const profile = await this.profile(context.ownerId, profileId)
    if (context.agentName && !context.allowedProfileIds?.includes(profile.id))
      throw new BrowserRuntimeError(
        'BROWSER_PROFILE_DENIED',
        'Browser profile is not assigned to this agent',
      )
  }
  private async liveSessions() {
    const rows = await this.collection().getFullList()
    if (this.port.health) {
      const health = (await this.port.health()) as { sessionIds?: string[] }
      if (Array.isArray(health.sessionIds)) {
        for (const row of rows)
          if (
            row.lifecycle === 'open' &&
            !health.sessionIds.includes(this.lease(this.record(row)))
          ) {
            await this.collection().update(row.id, {
              lifecycle: 'closed',
              closed_at: this.now(),
              updated_at: this.now(),
            })
            row.lifecycle = 'closed'
          }
      }
    }
    return rows
  }
  async profile(ownerId: string, id: string): Promise<Record<string, any>> {
    const row = await this.client
      .collection('browser_profiles')
      .getOne(id)
      .catch(() => null)
    if (!row || row.owner_id !== ownerId)
      throw new BrowserRuntimeError(
        'BROWSER_PROFILE_DENIED',
        'Browser profile is not owned by this user',
      )
    return row
  }
  async profiles(ownerId: string) {
    await this.pruneArtifacts(ownerId)
    const rows = await this.client.collection('browser_profiles').getFullList({
      filter: `owner_id = "${ownerId.replaceAll('"', '\\"')}"`,
    })
    const sessions = await this.liveSessions()
    return rows
      .filter((row) => row.owner_id === ownerId)
      .map((row) => ({
        id: row.id,
        name: row.name,
        owner_id: row.owner_id,
        created_at: row.created_at,
        updated_at: row.updated_at,
        busy: sessions.some(
          (session) =>
            session.profile_id === row.id && session.lifecycle === 'open',
        ),
      }))
  }
  async createProfile(ownerId: string, name: string) {
    if (!name.trim() || name.length > 100)
      throw new BrowserRuntimeError(
        'BROWSER_INVALID_INPUT',
        'Profile name must contain 1 to 100 characters',
      )
    const profile = await this.client.collection('browser_profiles').create({
      owner_id: ownerId,
      name: name.trim(),
      created_at: this.now(),
      updated_at: this.now(),
    })
    await this.audit(ownerId, '', 'profile.create', { profile_id: profile.id })
    return profile
  }
  async renameProfile(ownerId: string, id: string, name: string) {
    await this.profile(ownerId, id)
    if (!name.trim() || name.length > 100)
      throw new BrowserRuntimeError(
        'BROWSER_INVALID_INPUT',
        'Invalid profile name',
      )
    const profile = await this.client
      .collection('browser_profiles')
      .update(id, { name: name.trim(), updated_at: this.now() })
    await this.audit(ownerId, '', 'profile.rename', { profile_id: id })
    return profile
  }
  async clearProfile(ownerId: string, id: string, remove = false) {
    await this.profile(ownerId, id)
    const sessions = await this.liveSessions()
    if (
      sessions.some((row) => row.profile_id === id && row.lifecycle === 'open')
    )
      throw new BrowserRuntimeError(
        'BROWSER_PROFILE_BUSY',
        'Close browser sessions before clearing this profile',
      )
    if (!this.port.clearProfile)
      throw new BrowserRuntimeError(
        'BROWSER_UNAVAILABLE',
        'Profile storage is unavailable',
      )
    await this.port.clearProfile(id)
    if (remove) {
      await this.client.collection('browser_profiles').delete(id)
      const agents = await this.client
        .collection('agents')
        .getFullList({
          filter: `user_id = "${ownerId.replaceAll('"', '\\"')}"`,
        })
      for (const agent of agents) {
        if (
          agent.user_id !== ownerId ||
          !agent.browser ||
          !Array.isArray(agent.browser.allowedProfileIds) ||
          !agent.browser.allowedProfileIds.includes(id)
        )
          continue
        const browser = {
          ...agent.browser,
          allowedProfileIds: agent.browser.allowedProfileIds.filter(
            (profileId: unknown) => profileId !== id,
          ),
        }
        if (browser.defaultProfileId === id) delete browser.defaultProfileId
        await this.client
          .collection('agents')
          .update(agent.id, { browser, updated_at: this.now() })
        await this.audit(ownerId, `agent:${agent.id}`, 'profile.revoke', {
          profile_id: id,
          agent_id: agent.id,
        })
      }
    }
    await this.audit(ownerId, '', remove ? 'profile.delete' : 'profile.clear', {
      profile_id: id,
    })
  }
  controller(id: string) {
    const value = controllers.get(id)
    if (value && value.expiresAt <= this.now()) {
      controllers.delete(id)
      return null
    }
    return value ?? null
  }
  async control(
    context: BrowserContext,
    id: string,
    action: string,
    leaseId?: string,
  ) {
    await this.owned(context, id)
    if (action === 'take') {
      if (takingControl.has(id))
        throw new BrowserRuntimeError(
          'BROWSER_CONTROL_BUSY',
          'Manual takeover is pending',
        )
      takingControl.add(id)
      await (
        operations.get(`${context.ownerId}:${id}`) ?? Promise.resolve()
      ).catch(() => {})
      takingControl.delete(id)
    }
    const current = this.controller(id)
    if (action === 'take') {
      if (current)
        throw new BrowserRuntimeError(
          'BROWSER_CONTROL_BUSY',
          'Another viewer controls this browser',
        )
      const next = {
        leaseId: crypto.randomUUID(),
        ownerId: context.ownerId,
        expiresAt: this.now() + 30_000,
      }
      controllers.set(id, next)
      await this.audit(context.ownerId, id, 'control.take')
      return next
    }
    if (
      !current ||
      current.ownerId !== context.ownerId ||
      current.leaseId !== leaseId
    )
      throw new BrowserRuntimeError(
        'BROWSER_CONTROLLER_EXPIRED',
        'Manual control lease expired',
      )
    if (action === 'release') {
      controllers.delete(id)
      await this.audit(context.ownerId, id, 'control.release')
      return null
    }
    if (action !== 'renew')
      throw new BrowserRuntimeError(
        'BROWSER_INVALID_INPUT',
        'Invalid control action',
      )
    current.expiresAt = this.now() + 30_000
    return current
  }
  async frame(context: BrowserContext, id: string) {
    const session = await this.owned(context, id)
    const key = this.lease(session)
    if ((frameTimes.get(key) ?? 0) + 200 > this.now())
      throw new BrowserRuntimeError(
        'BROWSER_LIMIT',
        'Viewer polling is limited to five frames per second',
      )
    frameTimes.set(key, this.now())
    return {
      frame: await this.port.screenshot(key, session.current_tab_id),
      session,
      controller: this.controller(id)
        ? {
            ownerId: this.controller(id)!.ownerId,
            expiresAt: this.controller(id)!.expiresAt,
          }
        : null,
    }
  }
  async toolCapture(context: BrowserContext, id: string, operation: string) {
    const session = await this.owned(context, id)
    return this.captureArtifact(
      context,
      session,
      operation,
      session.current_tab_id,
    )
  }
  private async pruneArtifacts(ownerId: string) {
    for (const name of ['browser_screenshots', 'browser_downloads']) {
      try {
        const page = await this.client.collection(name).getList(1, 50, {
          filter: `owner_id = "${ownerId.replaceAll('"', '\\"')}" && expires_at <= ${this.now()}`,
        })
        for (const row of page.items)
          if (row.owner_id === ownerId && Number(row.expires_at) <= this.now())
            await this.client.collection(name).delete(row.id)
      } catch {}
    }
  }
  private async captureArtifact(
    context: BrowserContext,
    session: BrowserSession,
    operation: string,
    tabId?: string,
    existing?: unknown,
  ) {
    await this.pruneArtifacts(context.ownerId)
    let status = 'captured'
    let capture: { mimeType: string; data: string } | undefined
    try {
      capture =
        (existing as typeof capture) ??
        (await this.port.screenshot(this.lease(session), tabId))
      if (
        !capture ||
        !['image/png', 'image/jpeg'].includes(capture.mimeType) ||
        capture.data.length > 12 * 1024 * 1024
      )
        throw new Error('Invalid capture')
    } catch {
      status = 'unavailable'
    }
    const form = new FormData()
    for (const [key, value] of Object.entries({
      owner_id: context.ownerId,
      browser_session_id: session.id,
      session_id: session.session_id ?? '',
      project_id: session.project_id ?? '',
      task_id: session.task_id ?? '',
      tool_call_id: context.callId ?? '',
      operation,
      tab_id: tabId ?? '',
      status,
      created_at: String(this.now()),
      expires_at: String(this.now() + 30 * 86400_000),
    }))
      form.set(key, value)
    if (capture && status === 'captured')
      form.set(
        'image',
        new Blob(
          [Uint8Array.from(atob(capture.data), (c) => c.charCodeAt(0))],
          { type: capture.mimeType },
        ),
        capture.mimeType === 'image/png' ? 'screenshot.png' : 'screenshot.jpg',
      )
    try {
      const row = await this.client
        .collection('browser_screenshots')
        .create(form)
      return {
        id: row.id,
        status,
        mimeType: capture?.mimeType,
        createdAt: this.now(),
        url: `/api/browser/artifacts/${row.id}/file`,
      }
    } catch {
      return { status: 'unavailable' }
    }
  }
  private async persistDownload(
    context: BrowserContext,
    session: BrowserSession,
    download: { name: string; mimeType: string; data: string },
  ) {
    if (
      typeof download.data !== 'string' ||
      download.data.length > session.limits.maxPageBytes * 1.4
    )
      throw new BrowserRuntimeError(
        'BROWSER_LIMIT',
        'Download exceeds artifact limit',
      )
    const form = new FormData()
    form.set('owner_id', context.ownerId)
    form.set('browser_session_id', session.id)
    form.set('tool_call_id', context.callId ?? '')
    form.set('created_at', String(this.now()))
    form.set('expires_at', String(this.now() + 30 * 86400_000))
    form.set(
      'file',
      new Blob([Uint8Array.from(atob(download.data), (c) => c.charCodeAt(0))], {
        type: 'application/octet-stream',
      }),
      download.name.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 100) ||
        'download',
    )
    const row = await this.client.collection('browser_downloads').create(form)
    return {
      id: row.id,
      url: `/api/browser/downloads/${row.id}/file`,
      name: download.name,
    }
  }
  async downloadArtifact(ownerId: string, id: string) {
    const row = await this.client
      .collection('browser_downloads')
      .getOne(id)
      .catch(() => null)
    if (
      !row ||
      row.owner_id !== ownerId ||
      Number(row.expires_at) <= this.now()
    )
      throw new BrowserRuntimeError(
        'BROWSER_SESSION_NOT_FOUND',
        'Download unavailable',
      )
    return row
  }
  async artifact(ownerId: string, id: string) {
    const row = await this.client
      .collection('browser_screenshots')
      .getOne(id)
      .catch(() => null)
    if (
      !row ||
      row.owner_id !== ownerId ||
      Number(row.expires_at) <= this.now()
    )
      throw new BrowserRuntimeError(
        'BROWSER_SESSION_NOT_FOUND',
        'Screenshot is unavailable',
      )
    return row
  }
}

export const BROWSER_ACTIONS = [
  'snapshot',
  'click',
  'double-click',
  'hover',
  'scroll',
  'fill',
  'type',
  'press',
  'select-option',
  'check',
  'uncheck',
  'drag',
  'select-tab',
  'close-tab',
  'reload',
  'upload',
  'download',
  'resize',
  'pointer',
  'keyboard',
]

export const browserNetworkPolicy = (
  limits: BrowserLimits,
): NetworkPolicyOptions =>
  networkPolicyFromMetadata({
    timeoutMs: limits.timeoutMs,
    maxResponseBytes: limits.maxPageBytes,
    maxRedirects: limits.maxRedirects,
  })
export function browserAuditMessage(value: unknown): string {
  const text = typeof value === 'string' ? value : ''
  return /^\w+:\/\//.test(text)
    ? browserAuditUrl(text)
    : redactSensitiveText(text)
}
