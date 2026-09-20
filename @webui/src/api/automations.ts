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
  jobId?: number | string
  triggerSource?: string
}

export interface AutomationCount {
  total: number
  enabled: number
}

type AutomationEnvelope = { automation?: AutomationJob; job?: AutomationJob }
type AutomationRecord = Record<string, unknown>

function identifier(value: unknown): number | string {
  if (typeof value === 'number') return value
  const text = String(value ?? '')
  const numeric = Number(text)
  return text !== '' && Number.isSafeInteger(numeric) ? numeric : text
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function mapAutomation(value: AutomationJob | AutomationRecord): AutomationJob {
  const raw = value as AutomationRecord
  const schedule = raw.schedule && typeof raw.schedule === 'object' ? raw.schedule as AutomationRecord : {}
  const state = raw.state
  const mode = raw.automationMode ?? (schedule.kind === 'recurring' ? 'cron' : 'once')
  return {
    ...raw,
    id: identifier(raw.id),
    repoId: raw.repoId ?? (raw.project_id === undefined ? undefined : identifier(raw.project_id)),
    agentSlug: raw.agentSlug ?? raw.agent_id,
    automationMode: mode,
    cronExpression: raw.cronExpression ?? schedule.cron,
    nextRunAt: numberOrNull(raw.nextRunAt ?? raw.next_run_at),
    lastRunAt: numberOrNull(raw.lastRunAt ?? raw.last_run_at),
    createdAt: numberOrNull(raw.createdAt ?? raw.created_at),
    updatedAt: numberOrNull(raw.updatedAt ?? raw.updated_at),
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : state === 'active',
  } as AutomationJob
}

function mapRun(value: AutomationRun | AutomationRecord): AutomationRun {
  const raw = value as AutomationRecord
  const result = raw.result && typeof raw.result === 'object' && !Array.isArray(raw.result) ? raw.result as AutomationRecord : {}
  const automation = raw.automation && typeof raw.automation === 'object' ? raw.automation as AutomationRecord : undefined
  const state = String(raw.state ?? raw.status ?? '')
  const status = raw.status ?? (state === 'succeeded' ? 'completed' : state)
  return {
    ...raw,
    id: identifier(raw.id),
    jobId: identifier(raw.jobId ?? raw.automation_id),
    repoId: raw.repoId === undefined && automation?.project_id === undefined ? undefined : identifier(raw.repoId ?? automation?.project_id),
    jobName: raw.jobName ?? automation?.name,
    triggerSource: raw.triggerSource ?? raw.trigger_key,
    status,
    startedAt: numberOrNull(raw.startedAt ?? raw.started_at),
    finishedAt: numberOrNull(raw.finishedAt ?? raw.finished_at),
    createdAt: numberOrNull(raw.createdAt ?? raw.created_at),
    errorText: raw.errorText ?? raw.error_message,
    responseText: raw.responseText ?? result.responseText ?? result.text,
    logText: raw.logText ?? result.logText,
    sessionId: raw.sessionId ?? result.sessionId,
  } as AutomationRun
}

function automationInput(data: CreateAutomationJobRequest | UpdateAutomationJobRequest, repoId?: number): Record<string, unknown> {
  const input = data as Record<string, unknown>
  if (Object.keys(input).length === 1 && typeof input.enabled === 'boolean') return { enabled: input.enabled }
  const schedule = input.schedule
  if (schedule && typeof schedule === 'object' && !Array.isArray(schedule)) {
    return { ...input, ...(repoId === undefined || repoId === 0 ? {} : { project_id: String(repoId) }), agent_id: input.agent_id ?? input.agentSlug ?? 'master' }
  }
  const mode = input.automationMode
  const interval = typeof input.intervalMinutes === 'number' && Number.isInteger(input.intervalMinutes) ? input.intervalMinutes : 60
  const cron = typeof input.cronExpression === 'string' && input.cronExpression.trim()
    ? input.cronExpression.trim()
    : interval >= 1440
      ? '0 0 * * *'
      : `*/${Math.max(1, Math.min(interval, 59))} * * * *`
  return {
    name: input.name,
    prompt: input.prompt,
    agent_id: input.agent_id ?? input.agentSlug ?? 'master',
    timezone: typeof input.timezone === 'string' && input.timezone.trim() ? input.timezone : 'UTC',
    schedule: mode === 'cron' || typeof input.cronExpression === 'string' ? { kind: 'recurring', cron } : { kind: 'recurring', cron },
    ...(repoId === undefined || repoId === 0 ? {} : { project_id: String(repoId) }),
    ...(input.retry_policy && typeof input.retry_policy === 'object' ? { retry_policy: input.retry_policy } : {}),
    ...(input.concurrency_policy ? { concurrency_policy: input.concurrency_policy } : {}),
    ...(typeof input.enabled === 'boolean' ? { enabled: input.enabled } : {}),
  }
}

function jobEnvelope(response: AutomationEnvelope): { job: AutomationJob } {
  const job = response.job ?? response.automation
  if (!job) throw new Error('Automation response did not include a job')
  return { job }
}

export async function listAllAutomations(): Promise<{ jobs: AutomationJobWithRepo[] }> {
  const response = await fetchWrapper<{ jobs?: AutomationJobWithRepo[]; automations?: AutomationJobWithRepo[] }>(`${API_BASE_URL}/api/automations`)
  return { jobs: (response.jobs ?? response.automations ?? []).map(mapAutomation) as AutomationJobWithRepo[] }
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
  const response = await fetchWrapper<{ runs?: AutomationRunWithContext[] }>(`${API_BASE_URL}/api/automations/runs${qs ? `?${qs}` : ''}`)
  return { runs: (response.runs ?? []).map(mapRun) as AutomationRunWithContext[] }
}

export async function listRepoAutomations(repoId: number): Promise<{ jobs: AutomationJob[] }> {
  const response = await fetchWrapper<{ jobs?: AutomationJob[]; automations?: AutomationJob[] }>(`${API_BASE_URL}/api/automations?projectId=${encodeURIComponent(String(repoId))}`)
  return { jobs: (response.jobs ?? response.automations ?? []).map(mapAutomation) }
}

export async function getAutomationCounts(): Promise<Map<number, AutomationCount>> {
  const response = await listAllAutomations()
  const jobs = response.jobs
  const counts = new Map<number, AutomationCount>()

  jobs.forEach((job) => {
    const repoId = Number(job.repoId)
    if (!Number.isSafeInteger(repoId)) return
    const existing = counts.get(repoId)
    if (existing) {
      existing.total += 1
      if (job.enabled) {
        existing.enabled += 1
      }
    } else {
      counts.set(repoId, { total: 1, enabled: job.enabled ? 1 : 0 })
    }
  })

  return counts
}

export async function getRepoAutomation(_repoId: number, jobId: number | string): Promise<{ job: AutomationJob }> {
  return { job: mapAutomation(jobEnvelope(await fetchWrapper<AutomationEnvelope>(`${API_BASE_URL}/api/automations/${encodeURIComponent(String(jobId))}`)).job) }
}

export async function createRepoAutomation(repoId: number, data: CreateAutomationJobRequest): Promise<{ job: AutomationJob }> {
  return { job: mapAutomation(jobEnvelope(await fetchWrapper<AutomationEnvelope>(`${API_BASE_URL}/api/automations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(automationInput(data, repoId)),
  }))).job }
}

export async function updateRepoAutomation(repoId: number, jobId: number | string, data: UpdateAutomationJobRequest): Promise<{ job: AutomationJob }> {
  return { job: mapAutomation(jobEnvelope(await fetchWrapper<AutomationEnvelope>(`${API_BASE_URL}/api/automations/${encodeURIComponent(String(jobId))}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(automationInput(data, repoId)),
  }))).job }
}

export async function deleteRepoAutomation(_repoId: number, jobId: number | string): Promise<void> {
  return fetchWrapperVoid(`${API_BASE_URL}/api/automations/${encodeURIComponent(String(jobId))}`, {
    method: 'DELETE',
  })
}

export async function runRepoAutomation(_repoId: number, jobId: number | string): Promise<{ run: AutomationRun }> {
  const response = await fetchWrapper<{ run: AutomationRun }>(`${API_BASE_URL}/api/automations/${encodeURIComponent(String(jobId))}/run`, {
    method: 'POST',
  })
  return { run: mapRun(response.run) }
}

export async function listRepoAutomationRuns(_repoId: number, jobId: number | string, limit: number = 20): Promise<{ runs: AutomationRun[] }> {
  const response = await fetchWrapper<{ runs?: AutomationRun[] }>(`${API_BASE_URL}/api/automations/${encodeURIComponent(String(jobId))}/history?limit=${Math.min(Math.max(limit, 1), 100)}`)
  return { runs: (response.runs ?? []).map(mapRun) }
}

export async function getRepoAutomationRun(_repoId: number, jobId: number | string, runId: number | string): Promise<{ run: AutomationRun }> {
  const response = await fetchWrapper<{ run: AutomationRun }>(`${API_BASE_URL}/api/automations/${encodeURIComponent(String(jobId))}/runs/${encodeURIComponent(String(runId))}`)
  return { run: mapRun(response.run) }
}

export async function cancelRepoAutomationRun(_repoId: number, jobId: number | string, runId: number | string): Promise<{ run: AutomationRun }> {
  const response = await fetchWrapper<{ run: AutomationRun }>(`${API_BASE_URL}/api/automations/${encodeURIComponent(String(jobId))}/runs/${encodeURIComponent(String(runId))}/cancel`, {
    method: 'POST',
  })
  return { run: mapRun(response.run) }
}
