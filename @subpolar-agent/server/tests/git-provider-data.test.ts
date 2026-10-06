import { describe, expect, it, vi } from 'vitest'
import { createBridgeRequestHandler } from '../bridge-request-handler.ts'
import { GatewayAuthError } from '../persistence/gateway-credentials.ts'

const token = 'private-git-token-value'
const path = '/api/git/provider-accounts/account_123/repos/acme/project/repository'
const listingPath = '/api/git/provider-accounts/account_123/repos/acme/project/branches'

function fixture(options: { account?: unknown; userId?: string } = {}) {
  const account = options.account ?? { providerType: 'git:github', status: 'active', authType: 'api_key', hasCredential: true }
  const getAccount = vi.fn(async (ownerId: string) => ownerId === 'alice' ? account : null)
  const loadCredential = vi.fn(async (ownerId: string) => ownerId === 'alice' ? { type: 'api_key', key: token } : null)
  const fetch = vi.fn(async (_url: URL, init?: RequestInit) => {
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${token}`)
    return Response.json({ id: 7, full_name: 'acme/project', name: 'project', owner: { login: 'acme' }, description: token, default_branch: 'main', html_url: 'https://github.com/acme/project', private: true })
  })
  const deps = {
    requestId: () => 'request', internalToken: 'internal-secret', GatewayAuthError,
    json: (body: unknown, status = 200) => Response.json(body, { status }),
    authenticateRequest: vi.fn(async () => ({ id: options.userId ?? 'alice' })),
    applicationDatabase: vi.fn(async () => ({})),
    authenticateGatewayCredential: vi.fn(async () => ({ ownerId: 'alice' })),
    providerAccountService: vi.fn(async () => ({ getAccount, loadCredential })),
    gitProviderFetch: fetch,
  }
  return { handle: createBridgeRequestHandler(deps), deps, getAccount, loadCredential, fetch }
}

describe('authenticated Git provider read routes', () => {
  it('returns only adapter repository DTOs and never exposes the loaded token', async () => {
    const { handle, fetch } = fixture()
    const response = await handle(new Request(`http://local${path}`))
    const payload = await response.json() as { repository: Record<string, unknown> }
    expect(response.status).toBe(200)
    expect(payload.repository).toMatchObject({ fullName: 'acme/project', owner: 'acme', private: true, description: '[REDACTED]' })
    expect(JSON.stringify(payload)).not.toContain(token)
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('caps adapter collection routes explicitly with truncation metadata', async () => {
    const result = Array.from({ length: 100 }, (_, index) => ({ name: `branch-${index}`, commit: { sha: 'abc' }, protected: false }))
    const { handle, fetch } = fixture()
    fetch.mockResolvedValueOnce(Response.json(result))
    const response = await handle(new Request(`http://local${listingPath}`))
    expect(await response.json()).toMatchObject({ branches: expect.arrayContaining([{ name: 'branch-0', sha: 'abc', protected: false }]), truncated: true })
  })

  it('denies another user account ID before loading its credential and does not disclose tokens', async () => {
    const { handle, getAccount, loadCredential, fetch } = fixture({ userId: 'bob' })
    const response = await handle(new Request(`http://local${path}`))
    expect(response.status).toBe(404)
    expect(getAccount).toHaveBeenCalledWith('bob', 'account_123')
    expect(loadCredential).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
    expect(await response.text()).not.toContain(token)
  })

  it('rejects provider mismatches and invalid repository segments without contacting upstream', async () => {
    const mismatch = fixture({ account: { providerType: 'git:unsupported', status: 'active', authType: 'api_key', hasCredential: true } })
    const response = await mismatch.handle(new Request(`http://local${path}`))
    expect(response.status).toBe(404)
    expect(mismatch.fetch).not.toHaveBeenCalled()
    const invalid = fixture()
    expect((await invalid.handle(new Request('http://local/api/git/provider-accounts/account_123/repos/acme%2Fevil/project/repository'))).status).toBe(400)
  })

  it.each(['Bearer subpolar_gw_token', 'Bearer internal-secret'])('keeps gateway/internal principals denied for Git data routes (%s)', async (authorization) => {
    const { handle, deps } = fixture()
    const response = await handle(new Request(`http://local${path}`, { headers: { authorization, cookie: 'session-cookie' } }))
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ error: { code: authorization.endsWith('internal-secret') ? 'INTERNAL_ROUTE_DENIED' : 'GATEWAY_ROUTE_DENIED' } })
    expect(deps.authenticateRequest).not.toHaveBeenCalled()
    expect(deps.providerAccountService).not.toHaveBeenCalled()
  })

  it('rejects write methods and does not expose upstream error text', async () => {
    const fixtureState = fixture()
    const write = await fixtureState.handle(new Request(`http://local${path}`, { method: 'POST' }))
    expect(write.status).toBe(405)
    fixtureState.fetch.mockRejectedValueOnce(new Error(token))
    const failed = await fixtureState.handle(new Request(`http://local${path}`))
    expect(failed.status).toBe(502)
    expect(await failed.text()).not.toContain(token)
  })
})
