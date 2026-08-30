import { fetchWrapper, fetchWrapperVoid } from './fetchWrapper'
import { API_BASE_URL } from '@/config'
import type {
  CreateAutomationJobRequest,
  AutomationJob,
  AutomationRun,
  UpdateAutomationJobRequest,
} from '@subpolar/shared/types'

export interface AutomationJobWithRepo extends AutomationJob {
  repoName: string
  repoPath: string
  repoUrl: string
}

export interface AutomationRunWithContext extends AutomationRun {
  jobName: string
  repoName: string
  repoPath: string
}

export interface ListAllAutomationRunsParams {
  limit?: number
  offset?: number
  status?: string
  repoId?: number
  jobId?: number
  triggerSource?: string
}

export interface AutomationCount {
  total: number
  enabled: number
}

export async function listAllAutomations(): Promise<{ jobs: AutomationJobWithRepo[] }> {
  return fetchWrapper(`${API_BASE_URL}/api/automations/all`)
}

export async function listAllAutomationRuns(params: ListAllAutomationRunsParams = {}): Promise<{ runs: AutomationRunWithContext[] }> {
  const searchParams = new URLSearchParams()
  if (params.limit !== undefined) searchParams.set('limit', String(params.limit))
  if (params.offset !== undefined) searchParams.set('offset', String(params.offset))
  if (params.status) searchParams.set('status', params.status)
  if (params.repoId !== undefined) searchParams.set('repoId', String(params.repoId))
  if (params.jobId !== undefined) searchParams.set('jobId', String(params.jobId))
  if (params.triggerSource) searchParams.set('triggerSource', params.triggerSource)
  const qs = searchParams.toString()
  return fetchWrapper(`${API_BASE_URL}/api/automations/all/runs${qs ? `?${qs}` : ''}`)
}

export async function listRepoAutomations(repoId: number): Promise<{ jobs: AutomationJob[] }> {
  return fetchWrapper(`${API_BASE_URL}/api/repos/${repoId}/automations`)
}

export async function getAutomationCounts(): Promise<Map<number, AutomationCount>> {
  const response = await fetchWrapper<{ jobs: AutomationJobWithRepo[] }>(`${API_BASE_URL}/api/automations/all`)
  const jobs = response.jobs
  const counts = new Map<number, AutomationCount>()

  jobs.forEach((job) => {
    const existing = counts.get(job.repoId)
    if (existing) {
      existing.total += 1
      if (job.enabled) {
        existing.enabled += 1
      }
    } else {
      counts.set(job.repoId, { total: 1, enabled: job.enabled ? 1 : 0 })
    }
  })

  return counts
}

export async function getRepoAutomation(repoId: number, jobId: number): Promise<{ job: AutomationJob }> {
  return fetchWrapper(`${API_BASE_URL}/api/repos/${repoId}/automations/${jobId}`)
}

export async function createRepoAutomation(repoId: number, data: CreateAutomationJobRequest): Promise<{ job: AutomationJob }> {
  return fetchWrapper(`${API_BASE_URL}/api/repos/${repoId}/automations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
}

export async function updateRepoAutomation(repoId: number, jobId: number, data: UpdateAutomationJobRequest): Promise<{ job: AutomationJob }> {
  return fetchWrapper(`${API_BASE_URL}/api/repos/${repoId}/automations/${jobId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
}

export async function deleteRepoAutomation(repoId: number, jobId: number): Promise<void> {
  return fetchWrapperVoid(`${API_BASE_URL}/api/repos/${repoId}/automations/${jobId}`, {
    method: 'DELETE',
  })
}

export async function runRepoAutomation(repoId: number, jobId: number): Promise<{ run: AutomationRun }> {
  return fetchWrapper(`${API_BASE_URL}/api/repos/${repoId}/automations/${jobId}/run`, {
    method: 'POST',
  })
}

export async function listRepoAutomationRuns(repoId: number, jobId: number, limit: number = 20): Promise<{ runs: AutomationRun[] }> {
  return fetchWrapper(`${API_BASE_URL}/api/repos/${repoId}/automations/${jobId}/runs?limit=${limit}`)
}

export async function getRepoAutomationRun(repoId: number, jobId: number, runId: number): Promise<{ run: AutomationRun }> {
  return fetchWrapper(`${API_BASE_URL}/api/repos/${repoId}/automations/${jobId}/runs/${runId}`)
}

export async function cancelRepoAutomationRun(repoId: number, jobId: number, runId: number): Promise<{ run: AutomationRun }> {
  return fetchWrapper(`${API_BASE_URL}/api/repos/${repoId}/automations/${jobId}/runs/${runId}/cancel`, {
    method: 'POST',
  })
}
