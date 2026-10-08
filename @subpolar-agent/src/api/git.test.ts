import { afterEach, describe, expect, it, vi } from 'vitest'
import { changeAuthOwner } from '@/stores/authIdentityStore'
import { fetchRepository } from './git'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  changeAuthOwner(null)
  vi.restoreAllMocks()
})

describe('fetchRepository', () => {
  it('uses the shared-client repository GET route and preserves its response contract', async () => {
    const response = {
      repository: { id: 'repo-1', name: 'workspace' },
      requestId: 'request-1',
    }
    const fetchMock = vi.fn(async () => Response.json(response))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await expect(fetchRepository('project/one')).resolves.toEqual(response)

    expect(fetchMock).toHaveBeenCalledOnce()
    const [input, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(new URL(input).pathname).toBe('/api/projects/project%2Fone/repository')
    expect(init.method).toBeUndefined()
    expect(init.body).toBeUndefined()
    expect(init.credentials).toBe('include')
    expect(init.cache).toBe('no-store')
  })

  it('rejects a response whose body finishes after the auth generation changes', async () => {
    let markJsonStarted!: () => void
    const jsonStarted = new Promise<void>((resolve) => { markJsonStarted = resolve })
    let resolveJson!: (value: unknown) => void
    const jsonResult = new Promise<unknown>((resolve) => { resolveJson = resolve })
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: () => {
        markJsonStarted()
        return jsonResult
      },
    } as Response))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const result = fetchRepository('project-1')
    await jsonStarted
    changeAuthOwner('another-user')
    resolveJson({ repository: { id: 'repo-1' }, requestId: 'request-1' })

    await expect(result).rejects.toMatchObject({ name: 'AbortError', message: 'Account changed' })
  })
})
