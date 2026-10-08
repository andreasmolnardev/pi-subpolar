/* eslint-disable react-refresh/only-export-components */
import { createContext, useEffect, useMemo, useState, useCallback, useRef, Fragment, type ReactNode } from 'react'
import { signUp, signIn, signOut, fetchSession, onAuthChange, getCurrentUser, type AuthUser } from '@/lib/auth-client'
import { useNavigate, useLocation } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { onIdentityCleanup, useAuthGeneration } from '@/stores/authIdentityStore'


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
  const generation = useAuthGeneration()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const location = useLocation()
  const locationRef = useRef(location)
  locationRef.current = location
  const ownerRef = useRef(user?.id ?? null)

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

    const stopCleanup = onIdentityCleanup(() => {
      void queryClient.cancelQueries()
      // Clearing the mutation cache alone does not stop its pending callbacks.
      for (const mutation of queryClient.getMutationCache().getAll()) {
        mutation.setOptions({ ...mutation.options, onSuccess: undefined, onError: undefined, onSettled: undefined })
      }
      queryClient.clear()
    })
    void initialize()

    const unsubscribe = onAuthChange((newUser) => {
      if (!mounted) return
      const nextOwner = newUser?.id ?? null
      if (ownerRef.current !== nextOwner) {
        const current = locationRef.current
        const state = current.state as Record<string, unknown> | null
        if (state && 'pendingPrompt' in state) {
          const { pendingPrompt: _pendingPrompt, ...rest } = state
          navigate(current.pathname + current.search, { replace: true, state: rest })
        }
      }
      ownerRef.current = nextOwner
      setUser(newUser)
    })

    return () => {
      mounted = false
      unsubscribe?.()
      stopCleanup()
    }
  }, [refreshSession, queryClient, navigate])

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
    try {
      await signOut()
    } finally {
      setUser(null)
      navigate('/login', { replace: true })
    }
  }, [navigate])

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
      <Fragment key={generation}>{children}</Fragment>
    </AuthContext.Provider>
  )
}
