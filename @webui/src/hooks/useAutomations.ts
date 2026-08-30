import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { CreateAutomationJobRequest, UpdateAutomationJobRequest } from '@subpolar/shared/types'
import {
  cancelRepoAutomationRun,
  createRepoAutomation,
  deleteRepoAutomation,
  getRepoAutomation,
  getRepoAutomationRun,
  listAllAutomationRuns,
  listAllAutomations,
  listRepoAutomationRuns,
  listRepoAutomations,
  runRepoAutomation,
  updateRepoAutomation,
} from '@/api/automations'
import { showToast } from '@/lib/toast'
import type { ListAllAutomationRunsParams, AutomationJobWithRepo, AutomationRunWithContext } from '@/api/automations'

export function useAllAutomations() {
  return useQuery({
    queryKey: ['all-automations'],
    queryFn: async () => {
      const response = await listAllAutomations()
      return response.jobs as AutomationJobWithRepo[]
    },
  })
}

export function useAllAutomationRuns(params: ListAllAutomationRunsParams, enabled: boolean = true) {
  return useQuery({
    queryKey: ['all-automation-runs', params],
    queryFn: async () => {
      const response = await listAllAutomationRuns(params)
      return response.runs as AutomationRunWithContext[]
    },
    enabled,
    refetchInterval: 5000,
  })
}

export function useRepoAutomations(repoId: number | undefined) {
  return useQuery({
    queryKey: ['repo-automations', repoId],
    queryFn: async () => {
      const response = await listRepoAutomations(repoId!)
      return response.jobs
    },
    enabled: repoId !== undefined,
    refetchInterval: 5000,
  })
}

export function useRepoAutomation(repoId: number | undefined, jobId: number | null) {
  return useQuery({
    queryKey: ['repo-automation', repoId, jobId],
    queryFn: async () => {
      const response = await getRepoAutomation(repoId!, jobId!)
      return response.job
    },
    enabled: repoId !== undefined && jobId !== null,
    refetchInterval: jobId !== null ? 5000 : false,
  })
}

export function useRepoAutomationRuns(repoId: number | undefined, jobId: number | null, limit: number = 20) {
  return useQuery({
    queryKey: ['repo-automation-runs', repoId, jobId, limit],
    queryFn: async () => {
      const response = await listRepoAutomationRuns(repoId!, jobId!, limit)
      return response.runs
    },
    enabled: repoId !== undefined && jobId !== null,
    refetchInterval: jobId !== null ? 5000 : false,
  })
}

export function useRepoAutomationRun(repoId: number | undefined, jobId: number | null, runId: number | null) {
  return useQuery({
    queryKey: ['repo-automation-run', repoId, jobId, runId],
    queryFn: async () => {
      const response = await getRepoAutomationRun(repoId!, jobId!, runId!)
      return response.run
    },
    enabled: repoId !== undefined && jobId !== null && runId !== null,
    refetchInterval: runId !== null ? 5000 : false,
  })
}

export function useCreateRepoAutomation() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({ repoId, data }: { repoId: number; data: CreateAutomationJobRequest }) => {
      const response = await createRepoAutomation(repoId, data)
      return response.job
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['repo-automations', variables.repoId] })
      queryClient.invalidateQueries({ queryKey: ['all-automations'] })
      showToast.success('Automation created')
    },
    onError: (error: unknown) => {
      showToast.error(`Failed to create automation: ${error instanceof Error ? error.message : String(error)}`)
    },
  })
}

export function useUpdateRepoAutomation() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({ repoId, jobId, data }: { repoId: number; jobId: number; data: UpdateAutomationJobRequest }) => {
      const response = await updateRepoAutomation(repoId, jobId, data)
      return response.job
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['repo-automations', variables.repoId] })
      queryClient.invalidateQueries({ queryKey: ['repo-automation', variables.repoId, variables.jobId] })
      queryClient.invalidateQueries({ queryKey: ['all-automations'] })
      showToast.success('Automation updated')
    },
    onError: (error: unknown) => {
      showToast.error(`Failed to update automation: ${error instanceof Error ? error.message : String(error)}`)
    },
  })
}

export function useDeleteRepoAutomation() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({ repoId, jobId }: { repoId: number; jobId: number }) => {
      return deleteRepoAutomation(repoId, jobId)
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['repo-automations', variables.repoId] })
      queryClient.invalidateQueries({ queryKey: ['all-automations'] })
      showToast.success('Automation deleted')
    },
    onError: (error: unknown) => {
      showToast.error(`Failed to delete automation: ${error instanceof Error ? error.message : String(error)}`)
    },
  })
}

export function useRunRepoAutomation() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({ repoId, jobId }: { repoId: number; jobId: number }) => {
      const response = await runRepoAutomation(repoId, jobId)
      return response.run
    },
    onSuccess: (run, variables) => {
      queryClient.invalidateQueries({ queryKey: ['repo-automations', variables.repoId] })
      queryClient.invalidateQueries({ queryKey: ['repo-automation-runs', variables.repoId, run.jobId] })
      queryClient.invalidateQueries({ queryKey: ['repo-automation', variables.repoId, run.jobId] })
      queryClient.invalidateQueries({ queryKey: ['repo-automation-run', variables.repoId, run.jobId, run.id] })
      queryClient.invalidateQueries({ queryKey: ['all-automations'] })
      showToast.success(run.status === 'running' ? 'Automation started' : 'Automation run completed')
    },
    onError: (error: unknown) => {
      showToast.error(`Failed to run automation: ${error instanceof Error ? error.message : String(error)}`)
    },
  })
}

export function useCancelRepoAutomationRun() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({ repoId, jobId, runId }: { repoId: number; jobId: number; runId: number }) => {
      const response = await cancelRepoAutomationRun(repoId, jobId, runId)
      return response.run
    },
    onSuccess: (run, variables) => {
      queryClient.invalidateQueries({ queryKey: ['repo-automations', variables.repoId] })
      queryClient.invalidateQueries({ queryKey: ['repo-automation-runs', variables.repoId, run.jobId] })
      queryClient.invalidateQueries({ queryKey: ['repo-automation', variables.repoId, run.jobId] })
      queryClient.invalidateQueries({ queryKey: ['repo-automation-run', variables.repoId, run.jobId, run.id] })
      queryClient.invalidateQueries({ queryKey: ['all-automations'] })
      showToast.success('Automation run cancelled')
    },
    onError: (error) => {
      showToast.error(`Failed to cancel automation run: ${error instanceof Error ? error.message : String(error)}`)
    },
  })
}
