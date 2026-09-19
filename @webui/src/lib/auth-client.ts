export type AuthUser = { id?: string; name?: string; email?: string; image?: string; avatar?: string } | null

let currentUser: AuthUser = null
let authChangeListeners: Array<(user: AuthUser) => void> = []

export function onAuthChange(listener: (user: AuthUser) => void) {
  authChangeListeners.push(listener)
  return () => {
    authChangeListeners = authChangeListeners.filter((item) => item !== listener)
  }
}

function notifyAuthChange(user: AuthUser) {
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
  const response = await fetch('/api/auth/sign-up/email', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, name }),
  })
  if (!response.ok) throw await parseError(response, 'Sign up failed')
  const data = await response.json() as { user: AuthUser; token?: string }
  notifyAuthChange(data.user)
  return data
}

export async function signIn(email: string, password: string) {
  const response = await fetch('/api/auth/sign-in/email', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  if (!response.ok) throw await parseError(response, 'Sign in failed')
  const data = await response.json() as { user: AuthUser; token?: string }
  notifyAuthChange(data.user)
  return data
}

export async function signOut() {
  await fetch('/api/auth/sign-out', { method: 'POST', credentials: 'include' })
  notifyAuthChange(null)
}

export async function fetchSession() {
  const response = await fetch('/api/auth/session', { credentials: 'include' })
  if (!response.ok) {
    notifyAuthChange(null)
    return { user: null, token: null }
  }
  const data = await response.json() as { user?: AuthUser; token?: string | null }
  notifyAuthChange(data.user ?? null)
  return { user: data.user ?? null, token: data.token ?? null }
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
