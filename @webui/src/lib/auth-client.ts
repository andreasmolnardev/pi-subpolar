export type AuthUser = Record<string, unknown> | null

let currentUser: AuthUser = null
let authChangeListeners: Array<(user: AuthUser) => void> = []

export function onAuthChange(listener: (user: AuthUser) => void) {
  authChangeListeners.push(listener)
  return () => {
    authChangeListeners = authChangeListeners.filter(l => l !== listener)
  }
}

function notifyAuthChange(user: AuthUser) {
  currentUser = user
  authChangeListeners.forEach(l => l(user))
}

export function getCurrentUser() {
  return currentUser
}

export async function signUp(email: string, password: string, name: string) {
  const response = await fetch('/api/auth/sign-up/email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, name }),
  })
  if (!response.ok) {
    const data = await response.json()
    throw new Error(data.message || 'Sign up failed')
  }
  const data = await response.json()
  notifyAuthChange(data.user)
  return data
}

export async function signIn(email: string, password: string) {
  const response = await fetch('/api/auth/sign-in/email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  if (!response.ok) {
    const data = await response.json()
    throw new Error(data.message || 'Sign in failed')
  }
  const data = await response.json()
  notifyAuthChange(data.user)
  return data
}

export async function signOut() {
  await fetch('/api/auth/sign-out', { method: 'POST' })
  notifyAuthChange(null)
}

export async function fetchSession() {
  try {
    const response = await fetch('/api/auth/session')
    if (response.ok) {
      const data = await response.json()
      notifyAuthChange(data.user)
      return data
    }
  } catch {
    // Session fetch failed
  }
  notifyAuthChange(null)
  return { user: null, token: null }
}

export async function changePassword(currentPassword: string, newPassword: string) {
  const response = await fetch('/api/auth/change-password', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ currentPassword, newPassword }),
  })
  if (!response.ok) {
    const data = await response.json()
    throw new Error(data.message || 'Failed to change password')
  }
  return response.json()
}
