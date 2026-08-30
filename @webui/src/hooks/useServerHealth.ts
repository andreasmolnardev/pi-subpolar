import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { settingsApi } from '@/api/settings'
import { invalidateConfigCaches, invalidateSettingsCaches } from '@/lib/queryInvalidation'
import { fetchWrapper } from '@/api/fetchWrapper'
import { useSettingsDialog } from '@/hooks/useSettingsDialog'

const MISSING_PASSWORD_ERROR_PATTERN = /no password is configured|SERVER_PASSWORD/i

function isMissingPasswordError(error: string | undefined): boolean {
  return !!error && MISSING_PASSWORD_ERROR_PATTERN.test(error)
}

interface HealthResponse {
  status: 'healthy' | 'degraded' | 'unhealthy'
  timestamp: string
  database: 'connected' | 'disconnected'
  runtime: 'pi'
  pi: 'healthy' | 'unhealthy'
  error?: string
}

async function fetchHealth(): Promise<HealthResponse> {
  return fetchWrapper<HealthResponse>('/api/health')
}

export function useServerHealth(enabled = true) {
  const queryClient = useQueryClient()
  const { isOpen: isSettingsOpen, setActiveTab } = useSettingsDialog()
  const lastHealthStatusRef = useRef<'healthy' | 'unhealthy'>('healthy')
  const prevHealthRef = useRef<string | null>(null)
  const hasAutoOpenedSettingsRef = useRef(false)

  const restartMutation = useMutation({
    mutationFn: async () => {
      return await settingsApi.reloadConfig()
    },
    onSuccess: () => {
      invalidateConfigCaches(queryClient)
      toast.success('Server configuration reloaded successfully', { id: 'reload-config' })
    },
    onError: (error: unknown) => {
      const errorMessage = error && typeof error === 'object' && 'response' in error
        ? ((error as { response?: { data?: { details?: string; error?: string } } }).response?.data?.details
           || (error as { response?: { data?: { details?: string; error?: string } } }).response?.data?.error
           || 'Failed to reload configuration')
        : 'Failed to reload configuration'
      toast.error(errorMessage, { id: 'reload-config' })
    },
  })

  const rollbackMutation = useMutation({
    mutationFn: async () => {
      return await settingsApi.rollbackConfig()
    },
    onSuccess: (data) => {
      invalidateSettingsCaches(queryClient)
      toast.success(data.message, { id: 'rollback-config' })
    },
    onError: () => {
      toast.error('Failed to rollback to previous config', { id: 'rollback-config' })
    },
  })

  const query = useQuery<HealthResponse>({
    queryKey: ['health'],
    queryFn: fetchHealth,
    refetchInterval: 30000,
    retry: false,
    enabled,
    staleTime: 10000,
  })

  const { data: health } = query

  useEffect(() => {
    if (!health) return

    const isUnhealthy = health.pi !== 'healthy'
    const currentStatus = isUnhealthy ? 'unhealthy' : 'healthy'
    const previousStatus = lastHealthStatusRef.current
    const prevHealth = prevHealthRef.current
    const missingPassword = isUnhealthy && isMissingPasswordError(health.error)

    if (isUnhealthy && missingPassword && !hasAutoOpenedSettingsRef.current && !isSettingsOpen) {
      hasAutoOpenedSettingsRef.current = true
      setActiveTab('runtime')
      toast.error(health.error || 'Server requires a password', {
        id: 'server-health-password',
        duration: Infinity,
        description: 'Set a password under Settings to start the server.',
      })
    } else if (prevHealth && currentStatus !== prevHealth) {
      if (isUnhealthy && previousStatus === 'healthy') {
        toast.error(health.error || 'Server is currently unhealthy', {
          id: 'server-health-unhealthy',
          duration: Infinity,
          action: {
            label: 'Reload',
            onClick: () => restartMutation.mutate(),
          },
        })
      } else if (!isUnhealthy && previousStatus === 'unhealthy') {
        toast.success('Server is back online', { id: 'server-health-online' })
        hasAutoOpenedSettingsRef.current = false
      }
    }

    lastHealthStatusRef.current = currentStatus
    prevHealthRef.current = currentStatus
  }, [health, restartMutation, isSettingsOpen, setActiveTab])

  return {
    ...query,
    restartMutation,
    rollbackMutation,
  }
}
