/* eslint-disable react-refresh/only-export-components */
import { createContext, useEffect, useMemo, useState, useCallback, type ReactNode } from 'react'
import { signUp, signIn, signOut, fetchSession, onAuthChange, getCurrentUser, type AuthUser } from '@/lib/auth-client'
import { useNavigate, useLocation } from 'react-router-dom'

interface AuthConfig {
  enabledProviders: string[]
  registrationEnabled: boolean
  isFirstUser: boolean
  adminConfigured: boolean
}

interface AuthContextValue {
  user: AuthUser | null
  isAuthenticated: boolean
  isLoading: boolean
  config: AuthConfig | null
  signInWithEmail: (email: string, password: string) => Promise<{ error?: string }>
  signUpWithEmail: (email: string, password: string, name: string) => Promise<{ error?: string }>
  logout: () => Promise<void>
  refreshSession: () => Promise<void>
}

export const AuthContext = createContext<AuthContextValue | null>(null)

export { useAuth } from '@/hooks/useAuth'

interface AuthProviderProps {
  children: ReactNode
}

export function AuthProvider({ children }: AuthProviderProps) {
  const [user, setUser] = useState<AuthUser | null>(() => getCurrentUser())
  const [isLoading, setIsLoading] = useState(true)
  const [isConfigLoading, setIsConfigLoading] = useState(true)
  const [config, setConfig] = useState<AuthConfig | null>(null)
  const navigate = useNavigate()
  const location = useLocation()

  const refreshSession = useCallback(async () => {
    const result = await fetchSession()
    setUser(result.user)
  }, [])

  useEffect(() => {
    let mounted = true
    const defaultConfig: AuthConfig = {
      enabledProviders: ['credentials'],
      registrationEnabled: true,
      isFirstUser: true,
      adminConfigured: false,
    }

    const initialize = async () => {
      await Promise.all([
        refreshSession().catch(() => {
          if (mounted) setUser(null)
        }),
        (async () => {
          try {
            const response = await fetch('/api/auth-info/config')
            const data = response.ok ? await response.json() : defaultConfig
            if (mounted) setConfig(data as AuthConfig)
          } catch {
            if (mounted) setConfig(defaultConfig)
          } finally {
            if (mounted) setIsConfigLoading(false)
          }
        })(),
      ])
      if (mounted) setIsLoading(false)
    }

    void initialize()

    const unsubscribe = onAuthChange((newUser) => {
      if (mounted) setUser(newUser)
    })

    return () => {
      mounted = false
      unsubscribe?.()
    }
  }, [refreshSession])

  const signInWithEmail = useCallback(async (email: string, password: string) => {
    try {
      const data = await signIn(email, password)
      setUser(data.user)
      const from = (location.state as { from?: string })?.from || '/'
      navigate(from, { replace: true })
      return {}
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'Sign in failed' }
    }
  }, [navigate, location])

  const signUpWithEmail = useCallback(async (email: string, password: string, name: string) => {
    try {
      const data = await signUp(email, password, name)
      setUser(data.user)
      navigate('/', { replace: true })
      return {}
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'Sign up failed' }
    }
  }, [navigate])

  const logout = useCallback(async () => {
    await signOut()
    setUser(null)
    window.location.href = '/login'
  }, [])

  const value = useMemo<AuthContextValue>(() => ({
    user,
    isAuthenticated: !!user,
    isLoading: isLoading || isConfigLoading,
    config,
    signInWithEmail,
    signUpWithEmail,
    logout,
    refreshSession,
  }), [
    user,
    isLoading,
    isConfigLoading,
    config,
    signInWithEmail,
    signUpWithEmail,
    logout,
    refreshSession,
  ])

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  )
}
