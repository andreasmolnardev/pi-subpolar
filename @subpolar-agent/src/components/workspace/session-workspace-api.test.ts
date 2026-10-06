import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sessionWorkspaceApi as api } from '@/api/session-workspace'
import { FetchError } from '@/api/fetchWrapper'

const fetchMock = vi.fn<typeof fetch>()
beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset()
  fetchMock.mockImplementation(async () => new Response(JSON.stringify({ content: 'saved' }), { status: 200 }))
})
afterEach(() => vi.unstubAllGlobals())
function request() {
  const [url, options] = fetchMock.mock.calls.at(-1)!
  return { url: new URL(String(url)), options, body: options?.body ? JSON.parse(String(options.body)) : undefined }
}

describe('session workspace API contract', () => {
  it('encodes session IDs and query paths without treating filenames as URL syntax', async () => {
    await api.diff('session/id', 'src/a #?.ts')
    expect(request().url.pathname).toBe('/api/sessions/session%2Fid/workspace/diff')
    expect(request().url.searchParams.get('path')).toBe('src/a #?.ts')
    expect(request().options?.credentials).toBe('include')
    await api.files('id')
    expect(request().url.searchParams.get('path')).toBe('')
    await api.file('id', 'a.ts')
    expect(request().url.pathname).toBe('/api/sessions/id/workspace/file')
  })
  it('searches the stored session workspace with an encoded query and cancellation', async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ paths: ['src/a.ts'], truncated: true }), { status: 200 }))
    const controller = new AbortController()
    await expect(api.search('session/id', 'a #?', controller.signal)).resolves.toEqual({ paths: ['src/a.ts'], truncated: true })
    expect(request().url.pathname).toBe('/api/sessions/session%2Fid/workspace/search')
    expect(request().url.searchParams.get('query')).toBe('a #?')
    expect(request().options?.credentials).toBe('include')
    fetchMock.mockImplementation((_url, options) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
    }))
    const pending = api.search('id', 'abc', controller.signal)
    const failure = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort()
    expect(request().options?.signal?.aborted).toBe(true)
    await failure
  })
  it('sends the original content as the optimistic concurrency precondition', async () => {
    await api.save('id', 'a.ts', 'new content', 'original content')
    expect(request().options?.method).toBe('PUT')
    expect(request().options?.headers).toEqual({ 'Content-Type': 'application/json' })
    expect(request().body).toEqual({ path: 'a.ts', content: 'new content', expectedContent: 'original content' })
  })
  it('uses the backend group, stage, unstage, and commit payloads', async () => {
    await api.createGroup('id', 'Review')
    expect(request().body).toEqual({ name: 'Review' })
    await api.updateGroup('id', 'group/id', { message: 'Ship it', name: 'Ready' })
    expect(request().url.pathname).toBe('/api/sessions/id/workspace/groups/group%2Fid')
    expect(request().options?.method).toBe('PATCH')
    expect(request().body).toEqual({ message: 'Ship it', name: 'Ready' })
    await api.stage('id', 'a.ts', 'group')
    expect(request().body).toEqual({ path: 'a.ts', groupId: 'group' })
    await api.unstage('id', 'a.ts')
    expect(request().body).toEqual({ path: 'a.ts' })
    await api.commit('id', 'group')
    expect(request().url.pathname).toBe('/api/sessions/id/workspace/commit')
    expect(request().body).toEqual({ groupId: 'group' })
  })
  it('preserves conflict status/code from fetchWrapper', async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ error: 'Changed on disk', code: 'CONTENT_CONFLICT' }), { status: 409 }))
    await expect(api.save('id', 'a.ts', 'draft', 'old')).rejects.toMatchObject({ statusCode: 409, code: 'CONTENT_CONFLICT' })
    await expect(api.save('id', 'a.ts', 'draft', 'old')).rejects.toBeInstanceOf(FetchError)
  })
})
