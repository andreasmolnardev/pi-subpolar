import type { QueryClient } from '@tanstack/react-query'

export function messagesQueryKey(
  apiUrl: string | null | undefined,
  sessionID: string | null | undefined,
  directory: string | null | undefined,
) {
  return ['subpolar', 'messages', apiUrl, sessionID, directory]
}

export function invalidateProviderCaches(queryClient: QueryClient) {
  queryClient.invalidateQueries({ queryKey: ['provider-credentials'] })
  queryClient.invalidateQueries({ queryKey: ['provider-auth-methods'] })
  queryClient.invalidateQueries({ queryKey: ['providers'] })
  queryClient.invalidateQueries({ queryKey: ['providers-with-models'] })
  queryClient.invalidateQueries({ queryKey: ['subpolar', 'providers'] })
  queryClient.invalidateQueries({ queryKey: ['providers-for-execution-model'] })
}

export function invalidateConfigCaches(queryClient: QueryClient) {
  queryClient.invalidateQueries({ queryKey: ['subpolar', 'config'] })
  queryClient.invalidateQueries({ queryKey: ['subpolar', 'agents'] })
  queryClient.invalidateQueries({ queryKey: ['subpolar-config'] })
  queryClient.invalidateQueries({ queryKey: ['health'] })
  queryClient.invalidateQueries({ queryKey: ['mcp-status'] })
  queryClient.invalidateQueries({ queryKey: ['subpolar-skills'] })
  queryClient.invalidateQueries({ queryKey: ['managed-skills'] })
  invalidateProviderCaches(queryClient)
}

export function invalidateSettingsCaches(queryClient: QueryClient, userId = 'default') {
  queryClient.invalidateQueries({ queryKey: ['settings', userId] })
  invalidateConfigCaches(queryClient)
}

export function invalidateSessionCaches(queryClient: QueryClient) {
  queryClient.invalidateQueries({
    predicate: (query) =>
      query.queryKey[0] === 'subpolar' &&
      (query.queryKey[1] === 'sessions' ||
        query.queryKey[1] === 'session' ||
        query.queryKey[1] === 'messages'),
  })
}

export function invalidateSessionListCaches(queryClient: QueryClient, apiUrl?: string | null) {
  queryClient.invalidateQueries({
    predicate: (query) => {
      if (query.queryKey[0] !== 'subpolar') return false
      if (query.queryKey[1] !== 'sessions') return false
      if (apiUrl && query.queryKey[2] !== apiUrl) return false
      return true
    },
  })
}

const sessionListInvalidationTimers = new WeakMap<QueryClient, ReturnType<typeof setTimeout>>()

export function invalidateSessionListCachesDebounced(queryClient: QueryClient, delayMs = 200) {
  const existing = sessionListInvalidationTimers.get(queryClient)
  if (existing) clearTimeout(existing)
  sessionListInvalidationTimers.set(
    queryClient,
    setTimeout(() => {
      sessionListInvalidationTimers.delete(queryClient)
      invalidateSessionListCaches(queryClient)
    }, delayMs),
  )
}
