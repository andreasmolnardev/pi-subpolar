import type { GitProviderId, GitProviderCapabilities } from './provider-contracts.ts'
import type { ProviderAccountService } from '../persistence/provider-accounts.ts'

export type GitProviderAccountDto = Readonly<{
  id: string
  provider: GitProviderId
  username: string
  displayName: string
  avatarUrl: string | null
  status: 'connected' | 'disabled'
  capabilities: GitProviderCapabilities
  connectedAt: number
}>

export type GitProviderAccountStore = Pick<ProviderAccountService, 'createAccount' | 'listAccounts' | 'getAccount' | 'getAccountStatus' | 'deleteAccount' | 'loadCredential'>
export type GitProviderAccountsOptions = {
  store: GitProviderAccountStore
  fetch?: (url: URL, init: RequestInit) => Promise<Response>
  now?: () => number
}

const PROVIDERS: Record<GitProviderId, { apiHost: string; webHost: string }> = {
  github: { apiHost: 'api.github.com', webHost: 'github.com' },
  gitea: { apiHost: 'gitea.com', webHost: 'gitea.com' },
}
const CAPABILITIES: GitProviderCapabilities = Object.freeze({ repoMetadata: true, branches: true, issues: true, comments: true, pullRequests: true, statuses: true, createPullRequest: false })
const safeString = (value: unknown): string => typeof value === 'string' ? value.slice(0, 200) : ''

function identity(value: unknown, provider: GitProviderId, token: string): { username: string; displayName: string; avatarUrl: string | null } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Git provider account response is invalid')
  const data = value as Record<string, unknown>
  const username = safeString(provider === 'github' ? data.login : data.username ?? data.login)
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(username)) throw new Error('Git provider account response is invalid')
  let avatarUrl: string | null = null
  if (typeof data.avatar_url === 'string') {
    try { const parsed = new URL(data.avatar_url); if (parsed.protocol === 'https:' && parsed.hostname === PROVIDERS[provider].webHost) avatarUrl = parsed.toString() } catch { /* Ignore unsafe upstream avatar links. */ }
  }
  const displayName = safeString(provider === 'gitea' ? data.full_name ?? data.name : data.name).trim()
  return { username, displayName: displayName && !displayName.includes(token) ? displayName : username, avatarUrl }
}

export class GitProviderAccounts {
  private readonly fetchImpl: NonNullable<GitProviderAccountsOptions['fetch']>
  private readonly now: () => number

  constructor(private readonly options: GitProviderAccountsOptions) {
    this.fetchImpl = options.fetch ?? ((url, init) => fetch(url, init))
    this.now = options.now ?? Date.now
  }

  private async verify(provider: GitProviderId, token: string) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 10_000)
    try {

      const response = await this.fetchImpl(new URL(provider === 'github' ? 'https://api.github.com/user' : 'https://gitea.com/api/v1/user'), {
        method: 'GET', redirect: 'error', signal: controller.signal,
        headers: provider === 'github'
          ? { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', authorization: `Bearer ${token}` }
          : { accept: 'application/json', authorization: `token ${token}` },
      })
      if (!response.ok) throw new Error('Git provider authorization failed')
      const declared = Number(response.headers.get('content-length'))
      if (Number.isFinite(declared) && declared > 64 * 1024) throw new Error('Git provider account response is too large')
      if (!response.body) throw new Error('Git provider account response is invalid')
      const reader = response.body.getReader()
      const chunks: Uint8Array[] = []
      let size = 0
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > 64 * 1024) {
          await reader.cancel()
          throw new Error('Git provider account response is too large')
        }
        chunks.push(value)
      }
      const bytes = new Uint8Array(size)
      let offset = 0
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
      return identity(JSON.parse(new TextDecoder().decode(bytes)), provider, token)
    } catch {
      throw new Error('Unable to verify Git provider credentials')
    } finally { clearTimeout(timer) }
  }

  async connect(ownerId: string, provider: GitProviderId, token: string): Promise<GitProviderAccountDto> {
    if (!Object.hasOwn(PROVIDERS, provider) || typeof token !== 'string' || !token.trim() || token.length > 4096 || /[\r\n]/.test(token)) throw new Error('Invalid Git provider credentials')
    const account = await this.verify(provider, token)
    const stored = await this.options.store.createAccount(ownerId, {
      providerType: `git:${provider}`, displayName: account.displayName, authType: 'api_key',
      credential: { type: 'api_key', key: token }, metadata: { username: account.username, avatarUrl: account.avatarUrl },
    })
    return { id: stored.instanceId, provider, ...account, status: stored.status === 'active' ? 'connected' : 'disabled', capabilities: CAPABILITIES, connectedAt: this.now() }
  }

  async list(ownerId: string): Promise<GitProviderAccountDto[]> {
    const accounts = await this.options.store.listAccounts(ownerId)
    return accounts.flatMap((account) => {
      if (!account.providerType.startsWith('git:') || !Object.hasOwn(PROVIDERS, account.providerType.slice(4))) return []
      const provider = account.providerType.slice(4) as GitProviderId
      const username = safeString(account.metadata.username)
      return [{
        id: account.instanceId, provider, username, displayName: account.displayName,
        avatarUrl: typeof account.metadata.avatarUrl === 'string' ? account.metadata.avatarUrl : null,
        status: account.status === 'active' ? 'connected' : 'disabled', capabilities: CAPABILITIES,
        connectedAt: account.createdAt,
      }]
    })
  }

  async status(ownerId: string, id: string) {
    const account = await this.options.store.getAccount(ownerId, id)
    if (!account || !account.providerType.startsWith('git:') || !Object.hasOwn(PROVIDERS, account.providerType.slice(4))) return null
    const status = await this.options.store.getAccountStatus(ownerId, id)
    if (!status) return null
    return { state: status.configured ? 'connected' : status.expired ? 'expired' : 'disconnected', hasCredential: status.hasCredential, capabilities: CAPABILITIES }
  }

  async revoke(ownerId: string, id: string): Promise<boolean> {
    const account = await this.options.store.getAccount(ownerId, id)
    if (!account || !account.providerType.startsWith('git:') || !Object.hasOwn(PROVIDERS, account.providerType.slice(4))) return false
    return this.options.store.deleteAccount(ownerId, id)
  }
}
