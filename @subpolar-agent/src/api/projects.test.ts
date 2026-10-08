import { afterEach, describe, expect, it, vi } from 'vitest'
import { getProject, listProjects } from './projects'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
})

describe('project API shared-client reads', () => {
  it('lists ordinary projects through @subpolar/client using authenticated fetch transport', async () => {
    const projects = [{ id: 3, name: 'workspace', directory: '/workspace', fullPath: '/workspace' }]
    const fetchMock = vi.fn(async () => Response.json({ projects }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await expect(listProjects()).resolves.toEqual(projects)
    expect(fetchMock).toHaveBeenCalledOnce()
    const [input, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(new URL(input).pathname).toBe('/api/projects')
    expect(init.credentials).toBe('include')
    expect(init.cache).toBe('no-store')
  })

  it('keeps the General Chat compatibility route outside ordinary project lookup', async () => {
    const fetchMock = vi.fn(async () => Response.json({ directory: '/workspace/general-chat' }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await expect(getProject(0)).resolves.toMatchObject({ id: 0, isGeneralChat: true })
    expect(new URL((fetchMock.mock.calls[0] as unknown as [string])[0]).pathname).toBe('/api/projects/general-chat')
  })
})
