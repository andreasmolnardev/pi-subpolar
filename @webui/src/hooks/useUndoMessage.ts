import { useMutation, useQueryClient } from '@tanstack/react-query'
import { createSubpolarClient } from '@/api/subpolar'
import { showToast } from '@/lib/toast'
import { messagesQueryKey } from '@/lib/queryInvalidation'
import type { MessageWithParts } from '@/api/types'

interface UseUndoMessageOptions {
  apiUrl: string | null
  sessionId: string
  directory?: string
  onSuccess?: (restoredPrompt: string) => void
}

interface UndoMessageContext {
  previousMessages?: MessageWithParts[]
}

export function useUndoMessage({ 
  apiUrl, 
  sessionId, 
  directory,
  onSuccess 
}: UseUndoMessageOptions) {
  const queryClient = useQueryClient()

  return useMutation<string, Error, { messageID: string; messageContent: string }, UndoMessageContext>({
    mutationFn: async ({ messageID, messageContent }: { messageID: string, messageContent: string }) => {
      if (!apiUrl) throw new Error('Subpolar URL not available')
      
      const client = createSubpolarClient(apiUrl, directory)
      await client.revertMessage(sessionId, { messageID })
      return messageContent
    },
    onMutate: async ({ messageID }) => {
      const queryKey = messagesQueryKey(apiUrl, sessionId, directory)
      
      await queryClient.cancelQueries({ queryKey })
      
      const previousMessages = queryClient.getQueryData<MessageWithParts[]>(queryKey)
      
      if (previousMessages) {
        const messageIndex = previousMessages.findIndex(m => m.info.id === messageID)
        if (messageIndex !== -1) {
          const newMessages = previousMessages.slice(0, messageIndex)
          queryClient.setQueryData(queryKey, newMessages)
        }
      }
      
      return { previousMessages }
    },
    onError: (_error, _variables, _context: UndoMessageContext | undefined) => {
      if (_context?.previousMessages) {
        queryClient.setQueryData(
          messagesQueryKey(apiUrl, sessionId, directory),
          _context.previousMessages
        )
      }
      
      showToast.error('Failed to undo message')
    },
    onSuccess: (restoredPrompt) => {
      queryClient.invalidateQueries({
        queryKey: messagesQueryKey(apiUrl, sessionId, directory)
      })
      queryClient.invalidateQueries({
        queryKey: ['subpolar', 'session', apiUrl, sessionId, directory]
      })
      onSuccess?.(restoredPrompt)
    }
  })
}
