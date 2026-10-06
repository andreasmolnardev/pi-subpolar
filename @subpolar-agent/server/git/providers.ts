import { GitProviderError, type GitProvider, type GitProviderBranch, type GitProviderCapabilities, type GitProviderComment, type GitProviderCreatePullRequestInput, type GitProviderId, type GitProviderIssue, type GitProviderPullRequest, type GitProviderRepository, type GitProviderRepositoryRef, type GitProviderStatus, type GitProviderTokenSource } from './provider-contracts.ts'

export type GitProviderFetch = (input: URL, init?: RequestInit) => Promise<Response>
type ProviderOptions = { tokenSource: GitProviderTokenSource; fetch?: GitProviderFetch; timeoutMs?: number; maxResponseBytes?: number }

const CAPABILITIES: GitProviderCapabilities = Object.freeze({ repoMetadata: true, branches: true, issues: true, comments: true, pullRequests: true, statuses: true, createPullRequest: true })
const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024
const MAX_TIMEOUT_MS = 30_000
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024

function segment(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/.test(value)) throw new GitProviderError('INVALID_REQUEST', 'Invalid repository reference')
  return encodeURIComponent(value)
}

function positiveInteger(value: number): string {
  if (!Number.isSafeInteger(value) || value < 1) throw new GitProviderError('INVALID_REQUEST', 'Invalid issue number')
  return String(value)
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new GitProviderError('INVALID_RESPONSE', 'Git provider returned an invalid response')
  return value as Record<string, unknown>
}
function string(value: unknown, fallback = ''): string { return typeof value === 'string' ? value : fallback }
function nullableString(value: unknown): string | null { return typeof value === 'string' ? value : null }
function numberOrString(value: unknown): string | number { return typeof value === 'number' || typeof value === 'string' ? value : '' }
function asArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new GitProviderError('INVALID_RESPONSE', 'Git provider returned an invalid response')
  return value
}
function scrubToken(value: unknown, token: string | undefined): unknown {
  if (!token) return value
  if (typeof value === 'string') return value.replaceAll(token, '[REDACTED]')
  if (Array.isArray(value)) return value.map((item) => scrubToken(item, token))
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scrubToken(item, token)]))
  return value
}
function safeHtmlUrl(value: unknown, host: string): string {
  if (typeof value !== 'string') return ''
  try { const url = new URL(value); return url.protocol === 'https:' && url.hostname === host ? url.toString() : '' } catch { return '' }
}

abstract class HttpGitProvider implements GitProvider {
  abstract readonly id: GitProviderId
  protected abstract readonly apiHost: string
  protected abstract readonly webHost: string
  readonly capabilities = CAPABILITIES
  private readonly fetchImpl: GitProviderFetch
  private readonly timeoutMs: number
  private readonly maxResponseBytes: number

  constructor(private readonly tokenSource: GitProviderTokenSource, options: ProviderOptions) {
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis)
    this.timeoutMs = Math.max(1, Math.min(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS))
    this.maxResponseBytes = Math.max(1, Math.min(options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES, MAX_RESPONSE_BYTES))
  }

  discoverCapabilities(): GitProviderCapabilities { return this.capabilities }
  protected abstract repositoryPath(ref: GitProviderRepositoryRef): string
  protected abstract paths(ref: GitProviderRepositoryRef): { repository: string; branches: string; issues: string; comments: (n: number) => string; pulls: string; statuses: (sha: string) => string; createPull: string }
  protected abstract mapRepository(value: unknown): GitProviderRepository
  protected abstract mapBranch(value: unknown): GitProviderBranch
  protected abstract mapIssue(value: unknown): GitProviderIssue
  protected abstract mapComment(value: unknown): GitProviderComment
  protected abstract mapPull(value: unknown): GitProviderPullRequest
  protected abstract mapStatus(value: unknown): GitProviderStatus
  protected abstract requestHeaders(token: string | undefined): Record<string, string>

  private url(path: string): URL { return new URL(path, `https://${this.apiHost}/`) }
  private async request(path: string, init: RequestInit = {}): Promise<unknown> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    const externalSignal = init.signal
    const abort = () => controller.abort()
    externalSignal?.addEventListener('abort', abort, { once: true })
    try {
      if (externalSignal?.aborted) controller.abort()
      let token: string | undefined
      let rejectTokenTimeout: (() => void) | undefined
      const tokenTimeout = new Promise<never>((_resolve, reject) => {
        rejectTokenTimeout = () => reject(new GitProviderError('TIMEOUT', 'Git provider request timed out'))
        if (controller.signal.aborted) rejectTokenTimeout()
        else controller.signal.addEventListener('abort', rejectTokenTimeout, { once: true })
      })
      try { token = await Promise.race([Promise.resolve().then(() => this.tokenSource(this.id)), tokenTimeout]) }
      catch {
        throw new GitProviderError('UNAUTHORIZED', 'Git provider credentials are unavailable')
      } finally {
        if (rejectTokenTimeout) controller.signal.removeEventListener('abort', rejectTokenTimeout)
      }
      if (token !== undefined && (token.length > 4096 || /[\r\n]/.test(token))) throw new GitProviderError('UNAUTHORIZED', 'Git provider credentials are unavailable')
      let response: Response
      try {
        response = await this.fetchImpl(this.url(path), { ...init, headers: this.requestHeaders(token), signal: controller.signal, redirect: 'error' })
      } catch {
        if (controller.signal.aborted) throw new GitProviderError('TIMEOUT', 'Git provider request timed out')
        throw new GitProviderError('UPSTREAM_ERROR', 'Git provider request failed')
      }
      if (response.status === 401 || response.status === 403) throw new GitProviderError('UNAUTHORIZED', 'Git provider authorization failed')
      if (response.status === 404) throw new GitProviderError('NOT_FOUND', 'Git provider resource was not found')
      if (response.status === 429) throw new GitProviderError('RATE_LIMITED', 'Git provider rate limit exceeded')
      if (!response.ok) throw new GitProviderError('UPSTREAM_ERROR', 'Git provider request failed')
      const declared = Number(response.headers.get('content-length'))
      if (Number.isFinite(declared) && declared > this.maxResponseBytes) throw new GitProviderError('RESPONSE_TOO_LARGE', 'Git provider response exceeded the size limit')
      if (!response.body) return null
      const reader = response.body.getReader()
      const chunks: Uint8Array[] = []
      let size = 0
      while (true) {
        let result: Awaited<ReturnType<typeof reader.read>>
        try { result = await reader.read() } catch { throw new GitProviderError(controller.signal.aborted ? 'TIMEOUT' : 'UPSTREAM_ERROR', controller.signal.aborted ? 'Git provider request timed out' : 'Git provider request failed') }
        if (result.done) break
        size += result.value.byteLength
        if (size > this.maxResponseBytes) { await reader.cancel(); throw new GitProviderError('RESPONSE_TOO_LARGE', 'Git provider response exceeded the size limit') }
        chunks.push(result.value)
      }
      const bytes = new Uint8Array(size)
      let offset = 0
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
      try { return scrubToken(JSON.parse(new TextDecoder().decode(bytes)) as unknown, token) } catch (error) {
        if (error instanceof GitProviderError) throw error
        throw new GitProviderError('INVALID_RESPONSE', 'Git provider returned an invalid response')
      }
    } finally {
      clearTimeout(timer)
      externalSignal?.removeEventListener('abort', abort)
    }
  }

  async getRepository(ref: GitProviderRepositoryRef, signal?: AbortSignal): Promise<GitProviderRepository> { return this.mapRepository(await this.request(this.paths(ref).repository, { signal })) }
  async listBranches(ref: GitProviderRepositoryRef, signal?: AbortSignal): Promise<GitProviderBranch[]> { return asArray(await this.request(this.paths(ref).branches, { signal })).map((item) => this.mapBranch(item)) }
  async listIssues(ref: GitProviderRepositoryRef, signal?: AbortSignal): Promise<GitProviderIssue[]> { return asArray(await this.request(this.paths(ref).issues, { signal })).map((item) => this.mapIssue(item)) }
  async listComments(ref: GitProviderRepositoryRef, issueNumber: number, signal?: AbortSignal): Promise<GitProviderComment[]> { return asArray(await this.request(this.paths(ref).comments(issueNumber), { signal })).map((item) => this.mapComment(item)) }
  async listPullRequests(ref: GitProviderRepositoryRef, signal?: AbortSignal): Promise<GitProviderPullRequest[]> { return asArray(await this.request(this.paths(ref).pulls, { signal })).map((item) => this.mapPull(item)) }
  async listStatuses(ref: GitProviderRepositoryRef, sha: string, signal?: AbortSignal): Promise<GitProviderStatus[]> { if (!/^[A-Za-z0-9._-]{1,128}$/.test(sha)) throw new GitProviderError('INVALID_REQUEST', 'Invalid commit identifier'); return asArray(await this.request(this.paths(ref).statuses(encodeURIComponent(sha)), { signal })).map((item) => this.mapStatus(item)) }
  async createPullRequest(ref: GitProviderRepositoryRef, input: GitProviderCreatePullRequestInput, signal?: AbortSignal): Promise<GitProviderPullRequest> {
    if (!input.title.trim() || input.title.length > 256 || input.head.length > 255 || input.base.length > 255 || !input.head.trim() || !input.base.trim() || (input.body?.length ?? 0) > 65_536) throw new GitProviderError('INVALID_REQUEST', 'Invalid pull request input')
    const path = this.paths(ref).createPull
    return this.mapPull(await this.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(this.createPullBody(input)), signal }))
  }
  protected createPullBody(input: GitProviderCreatePullRequestInput): unknown { return { title: input.title, head: input.head, base: input.base, body: input.body ?? '', draft: input.draft ?? false } }
  protected repoPath(ref: GitProviderRepositoryRef): string { return `${segment(ref.owner)}/${segment(ref.repo)}` }
  protected validateIssueNumber(n: number): string { return positiveInteger(n) }
}

export class GitHubProvider extends HttpGitProvider {
  readonly id = 'github' as const
  protected readonly apiHost = 'api.github.com'
  protected readonly webHost = 'github.com'
  constructor(options: ProviderOptions) { super(options.tokenSource, options) }
  protected requestHeaders(token: string | undefined): Record<string, string> { return { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', ...(token ? { authorization: `Bearer ${token}` } : {}) } }
  protected repositoryPath(ref: GitProviderRepositoryRef): string { return this.repoPath(ref) }
  protected paths(ref: GitProviderRepositoryRef) { const p = this.repositoryPath(ref); return { repository: `/repos/${p}`, branches: `/repos/${p}/branches?per_page=100`, issues: `/repos/${p}/issues?state=all&per_page=100`, comments: (n: number) => `/repos/${p}/issues/${this.validateIssueNumber(n)}/comments?per_page=100`, pulls: `/repos/${p}/pulls?state=all&per_page=100`, statuses: (sha: string) => `/repos/${p}/commits/${sha}/statuses`, createPull: `/repos/${p}/pulls` } }
  protected mapRepository(v: unknown): GitProviderRepository { const x = object(v); const owner = object(x.owner); return { id: numberOrString(x.id), fullName: string(x.full_name), name: string(x.name), owner: string(owner.login), description: nullableString(x.description), defaultBranch: nullableString(x.default_branch), htmlUrl: safeHtmlUrl(x.html_url, this.webHost), private: x.private === true } }
  protected mapBranch(v: unknown): GitProviderBranch { const x = object(v); const commit = object(x.commit); return { name: string(x.name), sha: string(commit.sha), protected: x.protected === true } }
  protected mapIssue(v: unknown): GitProviderIssue { const x = object(v); const user = x.user === null ? null : string(object(x.user).login) || null; return { id: numberOrString(x.id), number: Number(x.number) || 0, title: string(x.title), body: nullableString(x.body), state: string(x.state), htmlUrl: safeHtmlUrl(x.html_url, this.webHost), user } }
  protected mapComment(v: unknown): GitProviderComment { const x = object(v); const user = x.user === null ? null : string(object(x.user).login) || null; return { id: numberOrString(x.id), body: string(x.body), htmlUrl: safeHtmlUrl(x.html_url, this.webHost), user, createdAt: nullableString(x.created_at) } }
  protected mapPull(v: unknown): GitProviderPullRequest { const x = object(v); const head = object(x.head); const base = object(x.base); return { id: numberOrString(x.id), number: Number(x.number) || 0, title: string(x.title), body: nullableString(x.body), state: string(x.state), htmlUrl: safeHtmlUrl(x.html_url, this.webHost), head: string(head.ref), headSha: nullableString(head.sha), base: string(base.ref), merged: x.merged === true } }
  protected mapStatus(v: unknown): GitProviderStatus { const x = object(v); return { state: string(x.state), sha: string(x.sha), description: nullableString(x.description), targetUrl: safeHtmlUrl(x.target_url, this.webHost) || null, context: nullableString(x.context) } }
}

export class GiteaProvider extends HttpGitProvider {
  readonly id = 'gitea' as const
  protected readonly apiHost = 'gitea.com'
  protected readonly webHost = 'gitea.com'
  constructor(options: ProviderOptions) { super(options.tokenSource, options) }
  protected requestHeaders(token: string | undefined): Record<string, string> { return { accept: 'application/json', ...(token ? { authorization: `token ${token}` } : {}) } }
  protected repositoryPath(ref: GitProviderRepositoryRef): string { return this.repoPath(ref) }
  protected paths(ref: GitProviderRepositoryRef) { const p = this.repositoryPath(ref); return { repository: `/api/v1/repos/${p}`, branches: `/api/v1/repos/${p}/branches?limit=50`, issues: `/api/v1/repos/${p}/issues?state=all&limit=50`, comments: (n: number) => `/api/v1/repos/${p}/issues/${this.validateIssueNumber(n)}/comments?limit=50`, pulls: `/api/v1/repos/${p}/pulls?state=all&limit=50`, statuses: (sha: string) => `/api/v1/repos/${p}/commits/${sha}/statuses`, createPull: `/api/v1/repos/${p}/pulls` } }
  protected mapRepository(v: unknown): GitProviderRepository { const x = object(v); const repositoryOwner = object(x.owner); const owner = string(repositoryOwner.username) || string(repositoryOwner.login); return { id: numberOrString(x.id), fullName: string(x.full_name), name: string(x.name), owner, description: nullableString(x.description), defaultBranch: nullableString(x.default_branch), htmlUrl: safeHtmlUrl(x.html_url, this.webHost), private: x.private === true } }
  protected mapBranch(v: unknown): GitProviderBranch { const x = object(v); const commit = object(x.commit); return { name: string(x.name), sha: string(commit.id) || string(commit.sha), protected: x.protected === true } }
  protected mapIssue(v: unknown): GitProviderIssue { const x = object(v); const issueUser = x.user === null ? null : object(x.user); const user = issueUser ? string(issueUser.username) || string(issueUser.login) || null : null; return { id: numberOrString(x.id), number: Number(x.number) || 0, title: string(x.title), body: nullableString(x.body), state: string(x.state), htmlUrl: safeHtmlUrl(x.html_url, this.webHost), user } }
  protected mapComment(v: unknown): GitProviderComment { const x = object(v); const commentUser = x.user === null ? null : object(x.user); const user = commentUser ? string(commentUser.username) || string(commentUser.login) || null : null; return { id: numberOrString(x.id), body: string(x.body), htmlUrl: safeHtmlUrl(x.html_url, this.webHost), user, createdAt: nullableString(x.created_at) } }
  protected mapPull(v: unknown): GitProviderPullRequest { const x = object(v); const head = object(x.head); const base = object(x.base); return { id: numberOrString(x.id), number: Number(x.number) || 0, title: string(x.title), body: nullableString(x.body), state: string(x.state), htmlUrl: safeHtmlUrl(x.html_url, this.webHost), head: string(head.ref), headSha: nullableString(head.sha), base: string(base.ref), merged: x.merged === true } }
  protected mapStatus(v: unknown): GitProviderStatus { const x = object(v); return { state: string(x.state), sha: string(x.sha), description: nullableString(x.description), targetUrl: safeHtmlUrl(x.target_url, this.webHost) || null, context: nullableString(x.context) } }
  protected createPullBody(input: GitProviderCreatePullRequestInput): unknown { return { title: input.title, head: input.head, base: input.base, body: input.body ?? '', ...(input.draft === undefined ? {} : { draft: input.draft }) } }
}
