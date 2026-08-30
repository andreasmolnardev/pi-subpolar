import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useDeleteSession, useSessionsAcrossDirectories } from './usePiHarness'

vi.mock('../lib/toast', () => ({
  showToast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}))

describe('useDeleteSession', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('falls back to workspace delete for stale workspace session deletes', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('Workspace not found: wrk_stale', { status: 500 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    )

    const { result } = renderHook(() => useDeleteSession('/api/opencode', ['/w/stale']), { wrapper })

    await act(async () => {
      await result.current.mutateAsync([
        { id: 'ses_1', directory: '/w/stale', workspaceID: 'wrk_stale' },
        { id: 'ses_2', directory: '/w/stale', workspaceID: 'wrk_stale' },
      ])
    })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'http://localhost/api/sessions/ses_1?directory=%2Fw%2Fstale',
      expect.objectContaining({ method: 'DELETE' }),
    )
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'http://localhost/api/opencode/experimental/workspace/wrk_stale?directory=%2Fw%2Fstale',
      expect.objectContaining({ method: 'DELETE' }),
    )
  })

  it('falls back to workspace delete for OpenCode unknown session delete failures', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({
        name: 'UnknownError',
        data: { message: 'Unexpected server error. Check server logs for details.' },
      }), { status: 500, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    )

    const { result } = renderHook(() => useDeleteSession('/api/opencode', ['/w/existing']), { wrapper })

    await act(async () => {
      await result.current.mutateAsync([{ id: 'ses_1', directory: '/w/existing', workspaceID: 'wrk_existing' }])
    })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'http://localhost/api/opencode/experimental/workspace/wrk_existing?directory=%2Fw%2Fexisting',
      expect.objectContaining({ method: 'DELETE' }),
    )
  })
})

describe('useSessionsAcrossDirectories', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('fetches first page of sessions with v2 pagination and adapted items', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({
        sessions: [
          { id: 'session-1', projectId: 1, directory: '/repo', title: 'Test Session', createdAt: 1000, updatedAt: 1000 },
        ],
      }), { headers: { 'Content-Type': 'application/json' } }),
    )

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    )

    const { result } = renderHook(() => useSessionsAcrossDirectories('/api/opencode', ['/repo']), { wrapper })

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    expect(result.current.data).toHaveLength(1)
    expect(result.current.data[0].id).toBe('session-1')
    expect(result.current.data[0].title).toBe('Test Session')
    expect(result.current.hasNextPage).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost/api/sessions?limit=25&order=desc&directory=%2Frepo',
      expect.objectContaining({ credentials: 'include' }),
    )
  })

  it('treats an empty project session response as a settled empty list', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ sessions: [] }), { headers: { 'Content-Type': 'application/json' } }),
    )

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    )

    const { result } = renderHook(() => useSessionsAcrossDirectories('/api/opencode', ['/repo']), { wrapper })

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    expect(result.current.data).toEqual([])
    expect(result.current.hasNextPage).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('fetches and flattens sessions across multiple directories', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          sessions: [
            { id: 'session-a1', projectId: 1, directory: '/w/a', title: 'Session A1', createdAt: 1000, updatedAt: 1000 },
          ],
        }), { headers: { 'Content-Type': 'application/json' } }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          sessions: [
            { id: 'session-b1', projectId: 1, directory: '/w/b', title: 'Session B1', createdAt: 1000, updatedAt: 1000 },
          ],
        }), { headers: { 'Content-Type': 'application/json' } }),
      )

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    )

    const { result } = renderHook(
      () => useSessionsAcrossDirectories('/api/opencode', ['/w/a', '/w/b']),
      { wrapper },
    )

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    expect(result.current.data).toHaveLength(2)
    expect(result.current.hasNextPage).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('sends search parameter when search option is provided', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({
        sessions: [
          { id: 'session-1', projectId: 1, directory: '/repo', title: 'Deploy Session', createdAt: 1000, updatedAt: 1000 },
        ],
      }), { headers: { 'Content-Type': 'application/json' } }),
    )

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    )

    const { result } = renderHook(
      () => useSessionsAcrossDirectories('/api/opencode', ['/repo'], { search: 'deploy' }),
      { wrapper },
    )

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost/api/sessions?limit=25&order=desc&search=deploy&directory=%2Frepo',
      expect.objectContaining({ credentials: 'include' }),
    )
  })
})
