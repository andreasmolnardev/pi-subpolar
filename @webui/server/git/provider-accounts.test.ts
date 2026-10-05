import { describe, expect, it } from 'bun:test'
import { GitProviderAccounts, type GitProviderAccountStore } from './provider-accounts.ts'

const credentials = new Map<string, string>()
const accountRows = new Map<string, any>()
function store(): GitProviderAccountStore {
  return {
    async createAccount(owner, input) {
      const id = `opaque-${owner}`
      credentials.set(id, input.credential.type === 'api_key' ? input.credential.key ?? '' : '')
      const account = { instanceId: id, providerType: input.providerType, displayName: input.displayName, authType: input.authType, status: 'active' as const, metadata: input.metadata ?? {}, hasCredential: true, createdAt: 123, updatedAt: 123 }
      accountRows.set(`${owner}:${id}`, account)
      return account
    },
    async listAccounts(owner) { return [...accountRows.entries()].filter(([key]) => key.startsWith(`${owner}:`)).map(([, account]) => account) },
    async getAccount(owner, id) { return accountRows.get(`${owner}:${id}`) ?? null },
    async getAccountStatus(owner, id) { return accountRows.has(`${owner}:${id}`) ? { instanceId: id, providerType: accountRows.get(`${owner}:${id}`).providerType, authType: 'api_key' as const, status: 'active' as const, hasCredential: true, configured: true, expired: false } : null },
    async deleteAccount(owner, id) { const key = `${owner}:${id}`; const didDelete = accountRows.delete(key); credentials.delete(id); return didDelete },
    async loadCredential() { throw new Error('not used in auth slice test') },
  }
}

describe('Git provider account auth slice', () => {
  it('verifies PATs at fixed provider hosts and returns an identity-only account DTO', async () => {
    const seen: Array<{ url: URL; authorization: string | null }> = []
    const service = new GitProviderAccounts({
      store: store(),
      fetch: async (url, init) => {
        seen.push({ url, authorization: new Headers(init.headers).get('authorization') })
        return new Response(JSON.stringify({ login: 'sample-user', name: 'Sample User', avatar_url: 'https://github.com/avatar.png' }), { status: 200 })
      },
      now: () => 123,
    })
    const result = await service.connect('owner-a', 'github', 'ghp-private-value')
    expect(result).toMatchObject({ provider: 'github', username: 'sample-user', displayName: 'Sample User', status: 'connected', id: 'opaque-owner-a' })
    expect(result).not.toHaveProperty('token')
    expect(seen[0]?.url.toString()).toBe('https://api.github.com/user')
    expect(seen[0]?.authorization).toBe('Bearer ghp-private-value')
    expect(credentials.get(result.id)).toBe('ghp-private-value')
    expect(JSON.stringify(await service.list('owner-a'))).not.toContain('ghp-private-value')
  })

  it('keeps account listing and revoke owner-scoped', async () => {
    const service = new GitProviderAccounts({ store: store(), fetch: async () => new Response(JSON.stringify({ login: 'user', name: null }), { status: 200 }) })
    const account = await service.connect('owner-a', 'gitee', 'gitee-secret')
    expect(await service.list('owner-b')).toEqual([])
    expect(await service.status('owner-b', account.id)).toBeNull()
    expect(await service.revoke('owner-b', account.id)).toBe(false)
    expect((await service.list('owner-a'))).toHaveLength(1)
    expect(await service.revoke('owner-a', account.id)).toBe(true)
    expect(await service.list('owner-a')).toEqual([])
  })

  it('rejects arbitrary provider hosts and sanitizes authentication failures', async () => {
    let requests = 0
    const service = new GitProviderAccounts({ store: store(), fetch: async () => { requests++; return new Response('denied', { status: 401 }) } })
    await expect(service.connect('owner-a', 'toString' as any, 'secret')).rejects.toThrow('Invalid Git provider credentials')
    await expect(service.connect('owner-a', 'github', 'secret')).rejects.toThrow('Unable to verify Git provider credentials')
    expect(requests).toBe(1)
  })
})
