import { afterEach, describe, expect, it, vi } from 'vitest'
import { createProject, deleteProject, getProject, listProjects, updateProject } from './projects'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
})

describe('project API shared-client operations', () => {
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

  it('creates, updates, and deletes projects through @subpolar/client', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname
      if (path === '/api/projects/4') return Response.json({ ok: true })
      return Response.json({ id: 4, name: 'workspace', directory: '/workspace', fullPath: '/workspace' }, { status: 201 })
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await createProject({ name: 'workspace', directory: '/workspace', agentNames: ['helper'] })
    await updateProject(4, { name: 'renamed', directory: '/workspace/renamed' })
    await deleteProject(4)

    expect(fetchMock).toHaveBeenCalledTimes(3)
    const calls = fetchMock.mock.calls as unknown as Array<[RequestInfo | URL, RequestInit]>
    expect(calls.map(([input]) => new URL(String(input)).pathname)).toEqual([
      '/api/projects', '/api/projects/4', '/api/projects/4',
    ])
    expect(calls.map(([, init]) => init.method)).toEqual(['POST', 'PATCH', 'DELETE'])
    expect(JSON.parse(String(calls[0]?.[1].body))).toEqual({ name: 'workspace', directory: '/workspace', agentNames: ['helper'] })
    expect(JSON.parse(String(calls[1]?.[1].body))).toEqual({ name: 'renamed', directory: '/workspace/renamed' })
    expect(calls.every(([, init]) => init.credentials === 'include' && init.cache === 'no-store')).toBe(true)
  })

  it('keeps piConfigName create and update payloads on the existing adapter', async () => {
    const fetchMock = vi.fn(async () => Response.json({ id: 4, name: 'workspace' }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await createProject({ name: 'workspace', piConfigName: 'custom' })
    await updateProject(4, { piConfigName: 'custom' })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>
    expect(calls.map(([input]) => new URL(input).pathname)).toEqual(['/api/projects', '/api/projects/4'])
    expect(calls.map(([, init]) => init.method)).toEqual(['POST', 'PATCH'])
    expect(JSON.parse(String(calls[0]?.[1].body))).toEqual({ name: 'workspace', piConfigName: 'custom' })
    expect(JSON.parse(String(calls[1]?.[1].body))).toEqual({ piConfigName: 'custom' })
    expect(calls.every(([, init]) => init.credentials === 'include' && init.cache === 'no-store')).toBe(true)
  })

  it('keeps the General Chat compatibility route outside ordinary project lookup', async () => {
    const fetchMock = vi.fn(async () => Response.json({ directory: '/workspace/general-chat' }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await expect(getProject(0)).resolves.toMatchObject({ id: 0, isGeneralChat: true })
    expect(new URL((fetchMock.mock.calls[0] as unknown as [string])[0]).pathname).toBe('/api/projects/general-chat')
  })
})
