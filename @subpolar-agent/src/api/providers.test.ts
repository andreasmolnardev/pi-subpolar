import { afterEach, describe, expect, it, vi } from 'vitest'
import { getProviderCatalog } from './providers'

describe('getProviderCatalog shared client', () => {
  afterEach(() => vi.unstubAllGlobals())

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
