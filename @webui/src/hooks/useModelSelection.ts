import { useEffect, useMemo } from 'react'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useConfig } from './usePiHarness'
import { useSubpolarClient } from './usePiHarness'
import { useModelStore, modelExists, type ModelSelection } from '@/stores/modelStore'
import { addPiRecentModel, getPiModelState, getProviders, removePiRecentModel, togglePiFavoriteModel, type PiModelState } from '@/api/providers'

interface UseModelSelectionResult {
  model: ModelSelection | null
  modelString: string | null
  recentModels: ModelSelection[]
  favoriteModels: ModelSelection[]
  setModel: (model: ModelSelection) => void
  setActiveModel: (model: ModelSelection) => boolean
  restoreSessionModel: (model: ModelSelection) => void
  toggleFavorite: (model: ModelSelection) => void
  removeRecentModel: (model: ModelSelection) => void
  isModelStateLoading: boolean
}

const modelStateQueryKey = ['subpolar', 'model-state']

const isSameModel = (left: ModelSelection, right: ModelSelection) => (
  left.providerID === right.providerID && left.modelID === right.modelID
)

export function useModelSelection(
  apiUrl: string | null | undefined,
  directory?: string
): UseModelSelectionResult {
  const { data: config } = useConfig(apiUrl, directory)
  const client = useSubpolarClient(apiUrl, directory)
  const queryClient = useQueryClient()
  
  const { data: providersData } = useQuery({
    queryKey: ['subpolar', 'providers', apiUrl, directory],
    queryFn: () => getProviders(directory),
    enabled: !!client,
    staleTime: 30000,
  })

  const { 
    model, 
    setModel: setStoreModel,
    setActiveModel: setStoreActiveModel,
    syncModelState,
    validateAndSyncModel, 
    getModelString 
  } = useModelStore()

  const { data: modelState, isLoading: isModelStateLoading } = useQuery({
    queryKey: [...modelStateQueryKey, apiUrl, directory],
    queryFn: () => getPiModelState(),
    enabled: !!client,
    staleTime: 30000,
    placeholderData: keepPreviousData,
  })

  const updateRecentModel = useMutation({
    mutationFn: addPiRecentModel,
    onSuccess: (state) => {
      syncModelState(state)
      queryClient.setQueryData([...modelStateQueryKey, apiUrl, directory], state)
      queryClient.invalidateQueries({ queryKey: [...modelStateQueryKey, apiUrl, directory] })
    },
    onError: (error) => {
      console.error('Failed to sync recent model to backend', error)
    },
  })

  const updateFavoriteModel = useMutation({
    mutationFn: togglePiFavoriteModel,
    onSuccess: (state) => {
      syncModelState(state)
      queryClient.setQueryData([...modelStateQueryKey, apiUrl, directory], state)
      queryClient.invalidateQueries({ queryKey: [...modelStateQueryKey, apiUrl, directory] })
    },
    onError: (error) => {
      console.error('Failed to toggle favorite model on backend', error)
    },
  })

  const removeRecentMutation = useMutation({
    mutationFn: removePiRecentModel,
    onMutate: async (removedModel) => {
      const queryKey = [...modelStateQueryKey, apiUrl, directory]
      await queryClient.cancelQueries({ queryKey })
      const previousState = queryClient.getQueryData<PiModelState>(queryKey)

      if (previousState) {
        const nextState: PiModelState = {
          ...previousState,
          recent: previousState.recent.filter((model) => !isSameModel(model, removedModel)),
        }
        queryClient.setQueryData(queryKey, nextState)
        syncModelState(nextState)
      }

      return { previousState }
    },
    onSuccess: (state) => {
      syncModelState(state)
      queryClient.setQueryData([...modelStateQueryKey, apiUrl, directory], state)
      queryClient.invalidateQueries({ queryKey: [...modelStateQueryKey, apiUrl, directory] })
    },
    onError: (error, _removedModel, context) => {
      if (context?.previousState) {
        syncModelState(context.previousState)
        queryClient.setQueryData([...modelStateQueryKey, apiUrl, directory], context.previousState)
      }
      console.error('Failed to remove recent model on backend', error)
    },
  })

  const providers = providersData?.providers

  const recentModels = useMemo(() => {
    const raw = modelState?.recent ?? []
    if (!providers || providers.length === 0) return raw
    return raw.filter((m) => modelExists(m, providers))
  }, [modelState?.recent, providers])

  const favoriteModels = useMemo(() => {
    const raw = modelState?.favorite ?? []
    if (!providers || providers.length === 0) return raw
    return raw.filter((m) => modelExists(m, providers))
  }, [modelState?.favorite, providers])

  const defaultModelString = providersData?.providers
    .map((provider) => {
      const modelID = providersData.default[provider.id] || Object.keys(provider.models || {})[0]
      return modelID ? `${provider.id}/${modelID}` : null
    })
    .find((value): value is string => Boolean(value))

  useEffect(() => {
    validateAndSyncModel(config?.model || defaultModelString, providersData?.providers)
  }, [config?.model, defaultModelString, providersData, validateAndSyncModel])

  useEffect(() => {
    if (modelState) {
      syncModelState(modelState)
    }
  }, [modelState, syncModelState])

  const setModel = (nextModel: ModelSelection) => {
    setStoreModel(nextModel)
    updateRecentModel.mutate(nextModel)
  }

  const setActiveModel = (nextModel: ModelSelection): boolean => {
    const providers = providersData?.providers
    if (!providers) return false

    const isAvailable = providers.some(
      (provider) => provider.id === nextModel.providerID && provider.models && nextModel.modelID in provider.models
    )

    if (!isAvailable) return false

    setStoreActiveModel(nextModel)
    return true
  }

  const restoreSessionModel = (sessionModel: ModelSelection): void => {
    setStoreActiveModel(sessionModel)
  }

  const toggleFavorite = (nextModel: ModelSelection) => {
    updateFavoriteModel.mutate(nextModel)
  }

  const removeRecentModel = (nextModel: ModelSelection) => {
    removeRecentMutation.mutate(nextModel)
  }

  return {
    model,
    modelString: getModelString(),
    recentModels,
    favoriteModels,
    setModel,
    setActiveModel,
    restoreSessionModel,
    toggleFavorite,
    removeRecentModel,
    isModelStateLoading,
  }
}
