import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom'
import { useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AuthProvider, useAuth } from './AuthContext'
import { signIn, signOut, fetchSession } from '@/lib/auth-client'
import { useUIState } from '@/stores/uiStateStore'
import { useSendErrorStore } from '@/stores/sendErrorStore'
import { useSessionStatus } from '@/stores/sessionStatusStore'
import { fetchWrapper } from '@/api/fetchWrapper'

function User() {
  const { user, isLoading } = useAuth()
  const [draft, setDraft] = useState('')
  const location = useLocation()
  const navigate = useNavigate()
  return <><div>{isLoading ? 'Loading identity' : user?.id ?? 'anonymous'}</div>
    <input aria-label="Local draft" value={draft} onChange={event => setDraft(event.target.value)} />
    <button onClick={() => navigate(location.pathname, { state: { pendingPrompt: { prompt: 'account A route prompt' } } })}>Queue route prompt</button>
    <div data-testid="route-state">{JSON.stringify(location.state)}</div>
  </>
}
function mockAuth() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
    const path = String(url)
    if (path.endsWith('/api/auth/session')) return Response.json({ user: null })
    if (path.endsWith('/api/auth/sign-in/email')) {
      const { email } = JSON.parse(String(options?.body))
      return Response.json({ user: { id: email, email } })
    }
    return Response.json({})
  })
}
const originalStorage = window.localStorage
beforeEach(() => {
  // The shared test storage omits Storage.key/length, which namespace cleanup uses.
  const values = new Map<string, string>()
  Object.defineProperty(window, 'localStorage', { configurable: true, value: {
    get length() { return values.size },
    key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    removeItem: (key: string) => { values.delete(key) },
  } })
})
afterEach(async () => {
  cleanup()
  vi.restoreAllMocks()
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({}))
  await signOut()
  fetch.mockRestore()
  vi.unstubAllGlobals()
  Object.defineProperty(window, 'localStorage', { configurable: true, value: originalStorage })
})

describe('account identity boundary', () => {
  it('clears caches, pending callbacks, prompts and optimistic status only on identity changes', async () => {
    mockAuth()
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<MemoryRouter><QueryClientProvider client={client}><AuthProvider><User /></AuthProvider></QueryClientProvider></MemoryRouter>)
    await screen.findByText('anonymous')
    await act(async () => { await signIn('account-a', 'password') })
    await screen.findByText('account-a')
    fireEvent.change(screen.getByLabelText('Local draft'), { target: { value: 'account A local draft' } })
    fireEvent.click(screen.getByRole('button', { name: 'Queue route prompt' }))
    client.setQueryData(['private'], 'private account A preview')
    useUIState.getState().selectPromptFile('/account-a/private')
    useSendErrorStore.getState().setQueuedPrompt('same-session', 'account A pending prompt')
    useSessionStatus.getState().setOptimisticActive('same-session')
    window.localStorage.setItem('subpolar:pending-session-prompt:same-session', 'private handoff')
    window.localStorage.setItem('provider-secret-test', 'keep-me')
    await act(async () => { await signIn('account-a', 'password') })
    expect(client.getQueryData(['private'])).toBe('private account A preview')
    let resolve!: () => void
    const onSuccess = vi.fn(() => client.setQueryData(['private'], 'late account A preview'))
    const mutation = client.getMutationCache().build(client, {
      mutationFn: () => new Promise<void>(done => { resolve = done }), onSuccess,
    })
    const pending = mutation.execute(undefined)
    await waitFor(() => expect(resolve).toBeTypeOf('function'))
    await act(async () => { await signIn('account-b', 'password') })
    await screen.findByText('account-b')
    expect(screen.getByLabelText('Local draft')).toHaveValue('')
    expect(screen.getByTestId('route-state')).not.toHaveTextContent('account A route prompt')
    expect(client.getQueryCache().getAll()).toHaveLength(0)
    expect(useUIState.getState().pendingPromptFile).toBeNull()
    expect(useSendErrorStore.getState().queuedPrompts).toEqual({})
    expect(useSessionStatus.getState().statuses.size).toBe(0)
    expect(window.localStorage.getItem('subpolar:pending-session-prompt:same-session')).toBeNull()
    expect(window.localStorage.getItem('provider-secret-test')).toBe('keep-me')
    await act(async () => { resolve(); await pending })
    expect(onSuccess).not.toHaveBeenCalled()
    expect(client.getQueryData(['private'])).toBeUndefined()
    await act(async () => { await signOut() })
    await screen.findByText('anonymous')
    window.localStorage.removeItem('provider-secret-test')
  })

  it('clears provider caches and local drafts before a cross-tab server refresh completes', async () => {
    const transport = {
      onmessage: null as ((event: MessageEvent) => void) | null,
      postMessage: vi.fn(), close: vi.fn(),
    }
    vi.stubGlobal('BroadcastChannel', class { constructor() { return transport } })
    const fetch = mockAuth()
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<MemoryRouter><QueryClientProvider client={client}><AuthProvider><User /></AuthProvider></QueryClientProvider></MemoryRouter>)
    await screen.findByText('anonymous')
    await act(async () => { await signIn('account-a', 'password') })
    fireEvent.change(screen.getByLabelText('Local draft'), { target: { value: 'account A private draft' } })
    client.setQueryData(['private-preview'], 'account A preview')
    let finish!: (value: Response) => void
    fetch.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
    act(() => transport.onmessage!(new MessageEvent('message', { data: { type: 'auth-invalidated', id: 'peer-account-change' } })))
    expect(screen.getByText('anonymous')).toBeInTheDocument()
    expect(screen.getByLabelText('Local draft')).toHaveValue('')
    expect(client.getQueryData(['private-preview'])).toBeUndefined()
    await act(async () => { finish(Response.json({ user: { id: 'account-b' } })) })
    await screen.findByText('account-b')
    expect(transport.postMessage).toHaveBeenCalledTimes(1)
  })

  it('retains a persisted recovery handoff when the initial session has the same stored owner', async () => {
    mockAuth()
    window.localStorage.setItem('subpolar:auth-owner', 'account-a')
    window.localStorage.setItem('subpolar:pending-session-prompt:session', 'same-owner recovery')
    await signIn('account-a', 'password')
    expect(window.localStorage.getItem('subpolar:pending-session-prompt:session')).toBe('same-owner recovery')
    await signOut()
    expect(window.localStorage.getItem('subpolar:pending-session-prompt:session')).toBeNull()
  })

  it('rejects a previous account response even if its JSON body finishes after account switch', async () => {
    const fetch = mockAuth()
    await signIn('account-a', 'password')
    let finish!: (value: unknown) => void
    const response = Response.json({})
    vi.spyOn(response, 'json').mockImplementation(() => new Promise(resolve => { finish = resolve }))
    fetch.mockResolvedValueOnce(response)
    const pending = fetchWrapper('/api/private')
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await waitFor(() => expect(finish).toBeTypeOf('function'))
    await signIn('account-b', 'password')
    finish({ source: 'account A private source' })
    await rejected
  })

  it('does not let a stale session refresh undo logout', async () => {
    const fetch = mockAuth()
    await signIn('account-a', 'password')
    let finish!: (value: Response) => void
    fetch.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
    const refreshing = fetchSession()
    await signOut()
    finish(Response.json({ user: { id: 'account-a' } }))
    expect((await refreshing).user).toBeNull()
  })
})
