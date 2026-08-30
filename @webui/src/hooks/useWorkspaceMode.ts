import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  getGeneralChatStatus,
  initializeGeneralChat,
} from '@/api/projects'
import { GENERAL_CHAT_PROJECT_ID } from '@subpolar/shared/utils'
import type { GeneralChatStatus, GeneralChatInitRequest } from '@subpolar/shared/types'

export function useWorkspaceMode(repoId?: number) {
  const queryClient = useQueryClient()

  const statusQuery = useQuery<GeneralChatStatus>({
    queryKey: ['workspace-mode'],
    queryFn: () => getGeneralChatStatus(GENERAL_CHAT_PROJECT_ID),
    enabled: repoId === GENERAL_CHAT_PROJECT_ID,
  })

  const initializeMutation = useMutation({
    mutationFn: (options?: GeneralChatInitRequest) =>
      initializeGeneralChat(GENERAL_CHAT_PROJECT_ID, options),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ['workspace-mode'],
      })
    },
  })

  return {
    status: statusQuery.data,
    isLoading: statusQuery.isLoading,
    isError: statusQuery.isError,
    error: statusQuery.error,
    initialize: initializeMutation.mutateAsync,
    isInitializing: initializeMutation.isPending,
  }
}
