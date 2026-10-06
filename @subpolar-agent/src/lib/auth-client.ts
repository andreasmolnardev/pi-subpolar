import { changeAuthOwner } from '@/stores/authIdentityStore'

export type AuthUser = { id?: string; name?: string; email?: string; image?: string; avatar?: string } | null

let currentUser: AuthUser = null
let authRevision = 0
let authChangeListeners: Array<(user: AuthUser) => void> = []
let sessionRequest = 0
let sessionController: AbortController | null = null

const AUTH_CHANNEL = 'subpolar:auth'
const AUTH_STORAGE_KEY = 'subpolar:auth-invalidated'
type AuthInvalidation = { type: 'auth-invalidated'; id: string }
let channel: BroadcastChannel | null = null
let stopSync: (() => void) | null = null
const seenInvalidations = new Set<string>()

function rememberInvalidation(id: string) {
  seenInvalidations.add(id)
  if (seenInvalidations.size > 64) seenInvalidations.delete(seenInvalidations.values().next().value!)
}

function cancelSessionRequest() {
  sessionRequest++
  sessionController?.abort()
  sessionController = null
}

function receiveInvalidation(data: unknown) {
  if (!data || typeof data !== 'object') return
  const message = data as Partial<AuthInvalidation>
  if (message.type !== 'auth-invalidated' || typeof message.id !== 'string' || !message.id || message.id.length > 128) return
  if (seenInvalidations.has(message.id)) return
  rememberInvalidation(message.id)
  invalidateAndRefresh()
}

function invalidateAndRefresh() {
  ++authRevision
  cancelSessionRequest()
  // Never use a peer's identity. Fence the old account before reading the cookie.
  notifyAuthChange(null)
  void fetchSession().catch(() => { /* The failed refresh leaves this tab unauthenticated. */ })
}

function startIdentitySync() {
  if (stopSync || typeof window === 'undefined') return
  try {
    if (typeof BroadcastChannel !== 'undefined') {
      channel = new BroadcastChannel(AUTH_CHANNEL)
      channel.onmessage = event => receiveInvalidation(event.data)
    }
  } catch { channel = null }
  const onStorage = (event: StorageEvent) => {
    if (event.key !== AUTH_STORAGE_KEY || !event.newValue || event.newValue.length > 256) return
    if (event.storageArea && event.storageArea !== window.localStorage) return
    try { receiveInvalidation(JSON.parse(event.newValue)) } catch { /* Ignore malformed signals. */ }
  }
  window.addEventListener('storage', onStorage)
  stopSync = () => {
    window.removeEventListener('storage', onStorage)
    if (channel) {
      channel.onmessage = null
      channel.close()
      channel = null
    }
    stopSync = null
  }
}

function publishInvalidation() {
  if (typeof window === 'undefined') return
  // Only random event IDs cross tabs: no tokens, user IDs, emails or response data.
  const message: AuthInvalidation = { type: 'auth-invalidated', id: crypto.getRandomValues(new Uint32Array(4)).join('-') }
  rememberInvalidation(message.id)
  let sender = channel
  try {
    if (!sender && typeof BroadcastChannel !== 'undefined') sender = new BroadcastChannel(AUTH_CHANNEL)
    sender?.postMessage(message)
  } catch { /* Storage events can still deliver the invalidation. */ }
  finally { if (sender && sender !== channel) sender.close() }
  // Send both transports for mixed-support tabs; event IDs deduplicate delivery.
  try { window.localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(message)) } catch { /* Storage may be disabled. */ }
}

export function onAuthChange(listener: (user: AuthUser) => void) {
  authChangeListeners.push(listener)
  startIdentitySync()
  return () => {
    authChangeListeners = authChangeListeners.filter((item) => item !== listener)
    if (!authChangeListeners.length) stopSync?.()
  }
}

function notifyAuthChange(user: AuthUser) {
  // An authenticated identity without an ID cannot safely share owner-scoped state.
  user = user?.id ? user : null
  changeAuthOwner(user?.id ?? null)
  currentUser = user
  authChangeListeners.forEach((listener) => listener(user))
}

export function getCurrentUser(): AuthUser {
  return currentUser
}

async function parseError(response: Response, fallback: string): Promise<Error> {
  const data = await response.json().catch(() => ({})) as { message?: string; error?: string }
  return new Error(data.message || data.error || fallback)
}

export async function signUp(email: string, password: string, name: string) {
  const revision = ++authRevision
  cancelSessionRequest()
  const response = await fetch('/api/auth/sign-up/email', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, name }),
  })
  if (!response.ok) throw await parseError(response, 'Sign up failed')
  publishInvalidation()
  const data = await response.json() as { user: AuthUser; token?: string }
  if (revision !== authRevision) {
    invalidateAndRefresh()
    throw new Error('Authentication superseded')
  }
  cancelSessionRequest()
  notifyAuthChange(data.user)
  return { ...data, user: currentUser }
}

export async function signIn(email: string, password: string) {
  const revision = ++authRevision
  cancelSessionRequest()
  const response = await fetch('/api/auth/sign-in/email', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  if (!response.ok) throw await parseError(response, 'Sign in failed')
  publishInvalidation()
  const data = await response.json() as { user: AuthUser; token?: string }
  if (revision !== authRevision) {
    invalidateAndRefresh()
    throw new Error('Authentication superseded')
  }
  cancelSessionRequest()
  notifyAuthChange(data.user)
  return { ...data, user: currentUser }
}

export async function signOut() {
  const revision = ++authRevision
  cancelSessionRequest()
  notifyAuthChange(null)
  const response = await fetch('/api/auth/sign-out', { method: 'POST', credentials: 'include', cache: 'no-store' })
  if (!response.ok) throw await parseError(response, 'Sign out failed')
  publishInvalidation()
  if (revision !== authRevision) invalidateAndRefresh()
  else {
    cancelSessionRequest()
    notifyAuthChange(null)
  }
}

export async function fetchSession() {
  const revision = authRevision
  cancelSessionRequest()
  const request = sessionRequest
  const controller = new AbortController()
  sessionController = controller
  const isCurrent = () => revision === authRevision && request === sessionRequest
  try {
    const response = await fetch('/api/auth/session', { credentials: 'include', cache: 'no-store', signal: controller.signal })
    if (!isCurrent()) return { user: currentUser, token: null }
    if (!response.ok) {
      notifyAuthChange(null)
      return { user: null, token: null }
    }
    const data = await response.json() as { user?: AuthUser; token?: string | null }
    if (!isCurrent()) return { user: currentUser, token: null }
    notifyAuthChange(data.user ?? null)
    return { user: currentUser, token: data.token ?? null }
  } catch (error) {
    // Canceled/stale refreshes must not make a caller clear a newer identity.
    if (!isCurrent()) return { user: currentUser, token: null }
    notifyAuthChange(null)
    throw error
  } finally {
    if (sessionController === controller) sessionController = null
  }
}

export async function changePassword(currentPassword: string, newPassword: string) {
  const response = await fetch('/api/auth/change-password', {
    method: 'PUT',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ currentPassword, newPassword }),
  })
  if (!response.ok) throw await parseError(response, 'Failed to change password')
  return response.json()
}
