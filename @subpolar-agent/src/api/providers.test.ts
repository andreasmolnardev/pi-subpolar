import { afterEach, describe, expect, it, vi } from 'vitest'
import { getProviderCatalog, providerAccountsApi } from './providers'

describe('getProviderCatalog shared client', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('uses shared-client reads for sanitized account metadata while preserving WebUI response shapes', async () => {
    const account = {
      id: 'openai:account/1', instanceId: 'openai:account/1', providerId: 'openai', label: 'Work',
      source: 'pocketbase', authMethod: 'api_key',
      status: { state: 'authenticated', configured: true, method: 'api_key' },
    }
    const status = {
      instanceId: account.instanceId, providerType: 'openai', authType: 'api_key', status: 'active',
      hasCredential: true, configured: true, expired: false,
    }
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname
      if (path === '/api/providers/accounts') return Response.json({ accounts: [account] })
      if (path.endsWith('/status')) return Response.json({ status })
      return Response.json({ account })
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(providerAccountsApi.list()).resolves.toEqual([account])
    await expect(providerAccountsApi.get('openai:account/1')).resolves.toEqual(account)
    await expect(providerAccountsApi.status('openai:account/1')).resolves.toEqual(status)

    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(fetchMock.mock.calls.map(([input]) => new URL(String(input)).pathname)).toEqual([
      '/api/providers/accounts',
      '/api/providers/accounts/openai%3Aaccount%2F1',
      '/api/providers/accounts/openai%3Aaccount%2F1/status',
    ])
    expect(fetchMock.mock.calls.every(([, init]) => init?.credentials === 'include' && init.cache === 'no-store')).toBe(true)
  })

  it('preserves directory, envelope, cookie, and no-store request semantics without enabling refresh', async () => {
    const catalog = { providers: [], accounts: [], models: [] }
    const fetchMock = vi.fn(async () => Response.json({ catalog }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(getProviderCatalog('/workspace/one & two')).resolves.toEqual(catalog)

    expect(fetchMock).toHaveBeenCalledOnce()
    const [input, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    const url = new URL(input)
    expect(url.pathname).toBe('/api/providers/catalog')
    expect(url.searchParams.get('directory')).toBe('/workspace/one & two')
    expect(url.searchParams.has('refresh')).toBe(false)
    expect(init.credentials).toBe('include')
    expect(init.cache).toBe('no-store')
  })
})
