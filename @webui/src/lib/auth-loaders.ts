import { redirect } from 'react-router-dom'

export interface AuthConfig {
  enabledProviders: string[]
  registrationEnabled: boolean
  isFirstUser: boolean
  adminConfigured: boolean
}

async function fetchAuthConfig(): Promise<AuthConfig> {
  const defaultConfig: AuthConfig = {
    enabledProviders: ['credentials'],
    registrationEnabled: true,
    isFirstUser: false,
    adminConfigured: false,
  }
  const response = await fetch('/api/auth-info/config')
  if (!response.ok) {
    return defaultConfig
  }
  try {
    return await response.json()
  } catch {
    return defaultConfig
  }
}

async function checkSession() {
  try {
    const response = await fetch('/api/auth/session')
    if (response.ok) {
      const data = await response.json()
      return !!data.user
    }
  } catch {
    // Session check failed
  }
  return false
}

export async function loginLoader() {
  const [config, isLoggedIn] = await Promise.all([
    fetchAuthConfig(),
    checkSession(),
  ])

  if (isLoggedIn) {
    return redirect('/')
  }

  if (config.isFirstUser && !config.adminConfigured) {
    return redirect('/setup')
  }

  return { config }
}

export async function setupLoader() {
  const [config, isLoggedIn] = await Promise.all([
    fetchAuthConfig(),
    checkSession(),
  ])

  if (isLoggedIn) {
    return redirect('/')
  }

  if (!config.isFirstUser || config.adminConfigured) {
    return redirect('/login')
  }

  return { config }
}

export async function registerLoader() {
  const [config, isLoggedIn] = await Promise.all([
    fetchAuthConfig(),
    checkSession(),
  ])

  if (isLoggedIn) {
    return redirect('/')
  }

  if (!config.registrationEnabled) {
    return redirect('/login')
  }

  if (config.isFirstUser && !config.adminConfigured) {
    return redirect('/setup')
  }

  return { config }
}

export async function protectedLoader() {
  const isLoggedIn = await checkSession()

  if (!isLoggedIn) {
    return redirect('/login')
  }

  return null
}
