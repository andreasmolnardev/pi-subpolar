import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

class TestChannel {
  static channels: TestChannel[] = []
  static messages: unknown[] = []
  onmessage: ((event: { data: unknown }) => void) | null = null
  closed = false
  constructor(readonly name: string) { TestChannel.channels.push(this) }
  postMessage(data: unknown) {
    TestChannel.messages.push(structuredClone(data))
    for (const peer of TestChannel.channels) {
      if (peer !== this && peer.name === this.name && !peer.closed) {
        queueMicrotask(() => { if (!peer.closed) peer.onmessage?.({ data: structuredClone(data) }) })
      }
    }
  }
  close() { this.closed = true }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const unsubscribes: Array<() => void> = []
async function tab() {
  // Separate module graphs model separate browser-tab memory; cookies/server are shared.
  vi.resetModules()
  const client = await import('./auth-client')
  const identity = await import('@/stores/authIdentityStore')
  const { useSendErrorStore: prompts } = await import('@/stores/sendErrorStore')
  const { workspaceDrafts: drafts, workspaceDraftKey } = await import('@/components/workspace/cache')
  const changes = vi.fn()
  unsubscribes.push(client.onAuthChange(changes))
  return { client, identity, prompts, drafts, workspaceDraftKey, changes, channel: TestChannel.channels.at(-1)! }
}
type User = { id: string; email: string; name: string }
let serverUser: User | null
let queuedSessions: Array<Promise<Response>>
let fetchMock: ReturnType<typeof vi.spyOn<typeof globalThis, 'fetch'>>
const originalStorage = window.localStorage
let storage: Map<string, string>
beforeEach(() => {
  TestChannel.channels = []
  TestChannel.messages = []
  serverUser = null
  queuedSessions = []
  vi.stubGlobal('BroadcastChannel', TestChannel)
  storage = new Map()
  Object.defineProperty(window, 'localStorage', { configurable: true, value: {
    get length() { return storage.size },
    key: (index: number) => [...storage.keys()][index] ?? null,
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value) },
    removeItem: (key: string) => { storage.delete(key) },
  } })
  fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
    const path = String(url)
    if (path === '/api/auth/session') return queuedSessions.shift() ?? Response.json({ user: serverUser, token: 'server-session-token' })
    if (path === '/api/auth/sign-out') serverUser = null
    else if (path === '/api/auth/sign-in/email' || path === '/api/auth/sign-up/email') {
      const { email } = JSON.parse(String(options?.body))
      serverUser = { id: email, email, name: `Private ${email}` }
    }
    return Response.json({ user: serverUser, token: 'private-auth-token' })
  })
})
afterEach(() => {
  for (const unsubscribe of unsubscribes.splice(0)) unsubscribe()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  Object.defineProperty(window, 'localStorage', { configurable: true, value: originalStorage })
})
function storageSignal(value: string | null, key = 'subpolar:auth-invalidated') {
  window.dispatchEvent(new StorageEvent('storage', { key, newValue: value }))
}

describe('cross-tab auth identity synchronization', () => {
  it('invalidates account A promptly and fetches actual account B without broadcasting identity or tokens', async () => {
    const a = await tab()
    const b = await tab()
    await a.client.signIn('account-a', 'password')
    await vi.waitFor(() => expect(b.client.getCurrentUser()?.id).toBe('account-a'))
    a.prompts.getState().setQueuedPrompt('shared-session', 'private account A prompt')
    a.drafts.set(a.workspaceDraftKey('shared-session'), [{ path: 'private.ts', content: 'private draft', expectedContent: '' }])
    const oldGeneration = a.identity.getAuthGeneration()
    const cleanup = vi.fn()
    const stopCleanup = a.identity.onIdentityCleanup(cleanup)
    const refresh = deferred<Response>()
    queuedSessions.push(refresh.promise)
    await b.client.signIn('account-b', 'password')
    expect(a.client.getCurrentUser()).toBeNull()
    expect(a.identity.getAuthGeneration()).toBeGreaterThan(oldGeneration)
    expect(cleanup).toHaveBeenCalled()
    expect(a.prompts.getState().queuedPrompts).toEqual({})
    expect(a.drafts.size).toBe(0)
    const sessionCall = fetchMock.mock.calls.filter(([url]) => url === '/api/auth/session').at(-1)!
    expect(sessionCall[1]).toMatchObject({ credentials: 'include', cache: 'no-store' })
    refresh.resolve(Response.json({ user: serverUser }))
    await vi.waitFor(() => expect(a.client.getCurrentUser()?.id).toBe('account-b'))
    expect(TestChannel.messages).toHaveLength(2)
    for (const message of TestChannel.messages) {
      expect(Object.keys(message as object).sort()).toEqual(['id', 'type'])
      expect(message).toMatchObject({ type: 'auth-invalidated', id: expect.any(String) })
      expect(JSON.stringify(message)).not.toMatch(/account-|token|Private|password/)
    }
    expect(JSON.parse(storage.get('subpolar:auth-invalidated')!)).toEqual(TestChannel.messages.at(-1))
    stopCleanup()
  })

  it('propagates logout and sign-up, and deduplicates storage/channel delivery without refresh loops', async () => {
    const a = await tab()
    const b = await tab()
    await a.client.signUp('account-a', 'password', 'Private name')
    await vi.waitFor(() => expect(b.client.getCurrentUser()?.id).toBe('account-a'))
    const before = fetchMock.mock.calls.length
    const signal = storage.get('subpolar:auth-invalidated')!
    storageSignal(signal)
    storageSignal(signal)
    expect(fetchMock.mock.calls).toHaveLength(before)
    await a.client.signOut()
    await vi.waitFor(() => expect(b.client.getCurrentUser()).toBeNull())
    expect(TestChannel.messages).toHaveLength(2)
    expect(b.changes).toHaveBeenLastCalledWith(null)
    expect(fetchMock.mock.calls.filter(([url]) => url === '/api/auth/session')).toHaveLength(2)
  })

  it('uses storage events when BroadcastChannel is unavailable and ignores malformed/unrelated signals', async () => {
    vi.stubGlobal('BroadcastChannel', undefined)
    const a = await tab()
    await a.client.signIn('account-a', 'password')
    expect(TestChannel.messages).toHaveLength(0)
    expect(JSON.parse(storage.get('subpolar:auth-invalidated')!)).toMatchObject({ type: 'auth-invalidated' })
    const before = fetchMock.mock.calls.length
    storageSignal('not json')
    storageSignal(null)
    storageSignal(JSON.stringify({ type: 'auth-invalidated' }))
    storageSignal(JSON.stringify({ type: 'unrelated', id: 'wrong-type' }))
    storageSignal('account-b', 'subpolar:auth-owner')
    expect(fetchMock.mock.calls).toHaveLength(before)
    serverUser = { id: 'account-b', email: 'private-b', name: 'Private B' }
    const refresh = deferred<Response>()
    queuedSessions.push(refresh.promise)
    storageSignal(JSON.stringify({ type: 'auth-invalidated', id: 'peer-event' }))
    expect(a.client.getCurrentUser()).toBeNull()
    refresh.resolve(Response.json({ user: serverUser }))
    await vi.waitFor(() => expect(a.client.getCurrentUser()?.id).toBe('account-b'))
    expect(fetchMock.mock.calls).toHaveLength(before + 1)
    expect(TestChannel.messages).toHaveLength(0)
  })

  it('aborts superseded refreshes and ignores late bodies, failures and local sign-in results', async () => {
    const a = await tab()
    await a.client.signIn('account-a', 'password')
    const oldBody = deferred<unknown>()
    const response = Response.json({})
    vi.spyOn(response, 'json').mockReturnValue(oldBody.promise)
    queuedSessions.push(Promise.resolve(response))
    const older = a.client.fetchSession()
    await vi.waitFor(() => expect(response.json).toHaveBeenCalled())
    const oldSignal = fetchMock.mock.calls.at(-1)![1]!.signal!
    const latest = deferred<Response>()
    queuedSessions.push(latest.promise)
    a.channel.onmessage!({ data: { type: 'auth-invalidated', id: 'first-peer-switch' } })
    expect(oldSignal.aborted).toBe(true)
    expect(a.client.getCurrentUser()).toBeNull()
    latest.resolve(Response.json({ user: { id: 'account-b' } }))
    await vi.waitFor(() => expect(a.client.getCurrentUser()?.id).toBe('account-b'))
    oldBody.resolve({ user: { id: 'account-a' }, token: 'old-token' })
    expect((await older).user?.id).toBe('account-b')

    const failing = deferred<Response>()
    queuedSessions.push(failing.promise)
    const failedRefresh = a.client.fetchSession()
    serverUser = { id: 'account-c', email: 'c', name: 'C' }
    a.channel.onmessage!({ data: { type: 'auth-invalidated', id: 'second-peer-switch' } })
    await vi.waitFor(() => expect(a.client.getCurrentUser()?.id).toBe('account-c'))
    failing.reject(new Error('late network failure'))
    expect((await failedRefresh).user?.id).toBe('account-c')

    const oldLogin = deferred<Response>()
    fetchMock.mockReturnValueOnce(oldLogin.promise)
    const login = a.client.signIn('stale-login', 'password')
    const superseded = expect(login).rejects.toThrow('Authentication superseded')
    a.channel.onmessage!({ data: { type: 'auth-invalidated', id: 'third-peer-switch' } })
    await vi.waitFor(() => expect(a.client.getCurrentUser()?.id).toBe('account-c'))
    oldLogin.resolve(Response.json({ user: { id: 'stale-login' } }))
    await superseded
    await vi.waitFor(() => expect(a.client.getCurrentUser()?.id).toBe('account-c'))
    expect(a.changes.mock.calls.map(([user]) => user?.id)).not.toContain('stale-login')
  })

  it('does not publish failed mutations and tolerates blocked signal storage when the channel works', async () => {
    const a = await tab()
    const b = await tab()
    const setItem = window.localStorage.setItem.bind(window.localStorage)
    vi.spyOn(window.localStorage, 'setItem').mockImplementation((key, value) => {
      if (key === 'subpolar:auth-invalidated') throw new Error('Signal storage disabled')
      setItem(key, value)
    })
    await a.client.signIn('account-a', 'password')
    await vi.waitFor(() => expect(b.client.getCurrentUser()?.id).toBe('account-a'))
    expect(TestChannel.messages).toHaveLength(1)
    fetchMock.mockResolvedValueOnce(Response.json({ error: 'Invalid password' }, { status: 401 }))
    await expect(a.client.signIn('account-b', 'wrong')).rejects.toThrow('Invalid password')
    expect(TestChannel.messages).toHaveLength(1)
    expect(a.client.getCurrentUser()?.id).toBe('account-a')
    fetchMock.mockResolvedValueOnce(Response.json({ error: 'Sign out failed' }, { status: 503 }))
    await expect(a.client.signOut()).rejects.toThrow('Sign out failed')
    expect(TestChannel.messages).toHaveLength(1)
    expect(a.client.getCurrentUser()).toBeNull()
  })

  it('leaves the tab unauthenticated on refresh failure and releases listeners with the last subscriber', async () => {
    const a = await tab()
    await a.client.signIn('account-a', 'password')
    queuedSessions.push(Promise.reject(new Error('offline')))
    a.channel.onmessage!({ data: { type: 'auth-invalidated', id: 'offline-switch' } })
    expect(a.client.getCurrentUser()).toBeNull()
    await vi.waitFor(() => expect(a.changes).toHaveBeenLastCalledWith(null))
    const stopSecond = a.client.onAuthChange(() => {})
    unsubscribes.shift()!()
    expect(a.channel.closed).toBe(false)
    stopSecond()
    expect(a.channel.closed).toBe(true)
    expect(a.channel.onmessage).toBeNull()
    const before = fetchMock.mock.calls.length
    storageSignal(JSON.stringify({ type: 'auth-invalidated', id: 'after-unmount' }))
    expect(fetchMock.mock.calls).toHaveLength(before)
  })
})
