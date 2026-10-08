import PocketBase from 'pocketbase'
import {
  authCookie,
  clearAuthCookie,
  getPocketBaseAdmin,
  newPocketBaseClient,
  type PocketBaseUser,
} from '../persistence/pocketbase'

export type AuthConfig = {
  enabledProviders: string[]
  registrationEnabled: boolean
  isFirstUser: boolean
  adminConfigured: boolean
}

export async function signIn(email: string, password: string): Promise<{ user: PocketBaseUser; cookie: string; token: string }> {
  const client = newPocketBaseClient()
  const result = await client.collection('users').authWithPassword(email, password)
  return { user: result.record as PocketBaseUser, cookie: authCookie(client), token: result.token }
}

export async function signUp(email: string, password: string, name: string): Promise<{ user: PocketBaseUser; cookie: string; token: string }> {
  const admin = await getPocketBaseAdmin()
  await admin.collection('users').create({ email, password, passwordConfirm: password, name })
  return signIn(email, password)
}

export async function signOut(): Promise<void> {
  // User clients are request-scoped. Clearing the browser cookie is sufficient.
}

export async function changePassword(userId: string, currentPassword: string, newPassword: string): Promise<void> {
  const admin = await getPocketBaseAdmin()
  const user = await admin.collection('users').getOne(userId)
  const verifier = newPocketBaseClient()
  await verifier.collection('users').authWithPassword(String(user.email), currentPassword)
  await admin.collection('users').update(userId, {
    password: newPassword,
    passwordConfirm: newPassword,
    oldPassword: currentPassword,
  })
}

export async function authConfig(): Promise<AuthConfig> {
  const admin = await getPocketBaseAdmin()
  const users = await admin.collection('users').getList(1, 1, { fields: 'id' })
  const adminConfigured = Boolean(process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD)
  return {
    enabledProviders: ['credentials'],
    registrationEnabled: process.env.AUTH_REGISTRATION_ENABLED !== 'false' && !adminConfigured,
    isFirstUser: users.totalItems === 0,
    adminConfigured,
  }
}

export async function syncAdminFromEnv(): Promise<void> {
  const email = process.env.ADMIN_EMAIL?.trim()
  const password = process.env.ADMIN_PASSWORD
  if (!email || !password) return
  const admin = await getPocketBaseAdmin()
  const existing = await admin.collection('users').getFirstListItem(`email = "${email.replaceAll('"', '\\"')}"`).catch(() => null)
  if (!existing) await admin.collection('users').create({ email, password, passwordConfirm: password, name: 'Admin' })
}

export { clearAuthCookie }
export { PocketBase }
