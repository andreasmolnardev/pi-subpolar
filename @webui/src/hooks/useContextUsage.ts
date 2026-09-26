import { useMemo } from 'react'
import { useConfig, useMessages, useSession } from './usePiHarness'
import { useQuery } from '@tanstack/react-query'
import { fetchWrapper } from '@/api/fetchWrapper'

interface ContextUsage {
  totalTokens: number
  contextLimit: number | null
  usagePercentage: number | null
  currentModel: string | null
  modelName: string | null
  pricing: { input: number; output: number; cacheRead: number; cacheWrite: number } | null
  isLoading: boolean
}

type AssistantMessage = {
  info: {
    role: string
    modelID?: string
    providerID?: string
    model?: { providerID?: string; modelID?: string }
    tokens?: {
      input?: number
      output?: number
      reasoning?: number
      cache?: { read?: number }
    }
  }
  parts: Array<{
    type: string
    text?: string
    tokens?: {
      input?: number
      output?: number
      reasoning?: number
      cache?: { read?: number }
    }
  }>
}

interface ModelLimit {
  context: number
  output: number
}

interface ProviderModel {
  id: string
  name: string
  limit?: ModelLimit
  cost?: {
    input: number
    output: number
    cache: { read: number; write: number }
  }
}

interface Provider {
  id: string
  name: string
  models: Record<string, ProviderModel>
}

interface ProvidersResponse {
  providers: Provider[]
}

async function fetchProviders(apiUrl: string): Promise<ProvidersResponse> {
  return fetchWrapper<ProvidersResponse>(`${apiUrl}/config/providers`)
}

function getMessageTokens(message: AssistantMessage | undefined): number {
  if (!message) return 0
  const completedPart = message.parts.find((part) => part.type === 'step-finish')
  const tokens = completedPart?.tokens ?? message.info.tokens
  if (tokens) {
    return (tokens.input ?? 0) + (tokens.output ?? 0) + (tokens.reasoning ?? 0) + (tokens.cache?.read ?? 0)
  }

  return estimateStreamedTokens(message)
}

function estimateStreamedTokens(message: AssistantMessage): number {
  const streamedCharacters = message.parts.reduce((total, part) => {
    if (part.type !== 'text' && part.type !== 'reasoning') return total
    return total + (part.text?.length ?? 0)
  }, 0)

  return streamedCharacters > 0 ? Math.ceil(streamedCharacters / 4) : 0
}

function getMessageModel(message: AssistantMessage | undefined): string | null {
  if (!message) return null
  if (message.info.modelID?.includes('/')) return message.info.modelID
  if (message.info.providerID && message.info.modelID) return `${message.info.providerID}/${message.info.modelID}`
  return null
}

export const useContextUsage = (apiUrl: string | null | undefined, sessionID: string | undefined, directory?: string): ContextUsage => {
  const { data: messages, isLoading: messagesLoading } = useMessages(apiUrl, sessionID, directory)
  const { data: session, isLoading: sessionLoading } = useSession(apiUrl, sessionID, directory)
  const { data: config, isLoading: configLoading } = useConfig(apiUrl, directory)

  const { data: providersData } = useQuery({
    queryKey: ['providers', apiUrl],
    queryFn: () => {
      if (!apiUrl) throw new Error('apiUrl is required')
      return fetchProviders(apiUrl)
    },
    enabled: !!apiUrl,
    staleTime: 5 * 60 * 1000,
  })

  return useMemo(() => {
    const assistantMessages = (messages?.filter(msg => msg.info.role === 'assistant') || []) as AssistantMessage[]
    let latestAssistantMessage = assistantMessages[assistantMessages.length - 1]

    if (getMessageTokens(latestAssistantMessage) === 0 && assistantMessages.length > 1) {
      latestAssistantMessage = assistantMessages[assistantMessages.length - 2]
    }

    const messageModel = getMessageModel(latestAssistantMessage)
    const currentModel = messageModel ?? session?.model ?? config?.model ?? null

    let contextLimit: number | null = null
    let modelName: string | null = null
    let pricing: ContextUsage['pricing'] = null
    if (currentModel && providersData) {
      const separator = currentModel.indexOf('/')
      const providerId = separator >= 0 ? currentModel.slice(0, separator) : ''
      const modelId = separator >= 0 ? currentModel.slice(separator + 1) : currentModel
      const provider = providersData.providers.find(p => p.id === providerId)
      if (provider?.models) {
        const model = provider.models[modelId]
        if (model) {
          modelName = model.name
          contextLimit = model.limit?.context ?? null
          pricing = model.cost ? {
            input: model.cost.input,
            output: model.cost.output,
            cacheRead: model.cost.cache.read,
            cacheWrite: model.cost.cache.write,
          } : null
        }
      }
    }

    if (!messages || messages.length === 0) {
      return {
        totalTokens: 0,
        contextLimit,
        usagePercentage: contextLimit ? 0 : null,
        currentModel,
        modelName,
        pricing,
        isLoading: messagesLoading || sessionLoading || configLoading,
      }
    }
    
    const totalTokens = getMessageTokens(latestAssistantMessage)

    const usagePercentage = contextLimit ? (totalTokens / contextLimit) * 100 : null

    return {
      totalTokens,
      contextLimit,
      usagePercentage,
      currentModel,
      modelName,
      pricing,
      isLoading: false
    }
  }, [messages, messagesLoading, session?.model, sessionLoading, config?.model, configLoading, providersData])
}
