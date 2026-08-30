import { useMutation, useQueryClient } from '@tanstack/react-query'
import { createSubpolarClient } from '@/api/subpolar'
import { showToast } from '@/lib/toast'
import { messagesQueryKey } from '@/lib/queryInvalidation'
import type { Message, Part, MessageWithParts } from '@/api/types'

interface UseRemoveMessageOptions {
  apiUrl: string | null
  sessionId: string
  directory?: string
}

interface RemoveMessageContext {
  previousMessages?: MessageWithParts[]
}

export function useRemoveMessage({ apiUrl, sessionId, directory }: UseRemoveMessageOptions) {
  const queryClient = useQueryClient()

  return useMutation<unknown, Error, { messageID: string; partID?: string }, RemoveMessageContext>({
    mutationFn: async ({ messageID, partID }: { messageID: string, partID?: string }) => {
      if (!apiUrl) throw new Error('Subpolar URL not available')
      
      const client = createSubpolarClient(apiUrl, directory)
      return client.revertMessage(sessionId, { messageID, partID })
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
    onError: (_error, _variables, _context: RemoveMessageContext | undefined) => {
      if (_context?.previousMessages) {
        queryClient.setQueryData(
          messagesQueryKey(apiUrl, sessionId, directory),
          _context.previousMessages
        )
      }
      
      showToast.error('Failed to remove message')
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: messagesQueryKey(apiUrl, sessionId, directory)
      })
      queryClient.invalidateQueries({
        queryKey: ['subpolar', 'session', apiUrl, sessionId, directory]
      })
    }
  })
}

interface UseRefreshMessageOptions {
  apiUrl: string | null
  sessionId: string
  directory?: string
}

export function useRefreshMessage({ apiUrl, sessionId, directory }: UseRefreshMessageOptions) {
  const queryClient = useQueryClient()
  const removeMessage = useRemoveMessage({ apiUrl, sessionId, directory })

  return useMutation({
    mutationFn: async ({ 
      assistantMessageID, 
      userMessageContent,
      model,
      agent
    }: { 
      assistantMessageID: string
      userMessageContent: string
      model?: string
      agent?: string
    }) => {
      if (!apiUrl) throw new Error('Subpolar URL not available')
      
      await removeMessage.mutateAsync({ messageID: assistantMessageID })
      
      const client = createSubpolarClient(apiUrl, directory)
      
      const optimisticUserID = `optimistic_user_${Date.now()}_${Math.random()}`
      const userMessageInfo = {
        id: optimisticUserID,
        role: 'user' as const,
        sessionID: sessionId,
        time: { created: Date.now() }
      } as Message

      const userMessageParts = [{
        id: `${optimisticUserID}_part_0`,
        type: 'text' as const,
        text: userMessageContent,
        messageID: optimisticUserID,
        sessionID: sessionId
      }] as Part[]

      const optimisticMessageWithParts: MessageWithParts = {
        info: userMessageInfo,
        parts: userMessageParts,
      }

      queryClient.setQueryData<MessageWithParts[]>(
        messagesQueryKey(apiUrl, sessionId, directory),
        (old) => [...(old || []), optimisticMessageWithParts]
      )
      
      interface SendPromptRequest {
        parts: Array<{ type: 'text'; text: string }>
        model?: { providerID: string; modelID: string }
        agent?: string
      }
      
      const requestData: SendPromptRequest = {
        parts: [{ type: 'text', text: userMessageContent }]
      }
      
      if (model) {
        const [providerID, modelID] = model.split('/')
        if (providerID && modelID) {
          requestData.model = { providerID, modelID }
        }
      }
      
      if (agent) {
        requestData.agent = agent
      }
      
      await client.sendPrompt(sessionId, requestData)

      return { optimisticUserID, userMessageContent }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: messagesQueryKey(apiUrl, sessionId, directory)
      })
      queryClient.invalidateQueries({
        queryKey: ['subpolar', 'session', apiUrl, sessionId, directory]
      })
    },
    onError: (_, variables) => {
      void variables
      queryClient.setQueryData<MessageWithParts[]>(
        messagesQueryKey(apiUrl, sessionId, directory),
        (old) => {
          const messages = old || []
          const optimisticIndex = messages.findIndex((m) => m.info.id.startsWith('optimistic_user_'))
          if (optimisticIndex !== -1) {
            return messages.slice(0, optimisticIndex)
          }
          return messages
        }
      )
      showToast.error('Failed to refresh message')
    }
  })
}