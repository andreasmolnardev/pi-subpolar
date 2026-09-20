import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cancelRepoAutomationRun, createRepoAutomation, getAutomationCounts, listAllAutomationRuns, listAllAutomations, runRepoAutomation } from './automations'

describe('automation API routes', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ automation: { id: 'automation-1' }, run: { id: 'run-1' }, runs: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))))
  })

  afterEach(() => vi.restoreAllMocks())

  it('uses the owner-scoped automation routes and translates the editor request', async () => {
    await createRepoAutomation(2, { name: 'Nightly', prompt: 'summarize', automationMode: 'cron', cronExpression: '0 9 * * *', timezone: 'UTC', agentSlug: 'writer' } as never)

    const [url, options] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/api/automations')
    expect(url).not.toContain('userId=')
    expect(url).not.toContain('/repos/')
    expect(JSON.parse(String(options.body))).toMatchObject({ project_id: '2', agent_id: 'writer', schedule: { kind: 'recurring', cron: '0 9 * * *' } })
    expect(JSON.parse(String(options.body))).not.toHaveProperty('owner_id')
  })

  it('uses bounded canonical run endpoints', async () => {
    await listAllAutomationRuns({ limit: 25, offset: 10 })
    await runRepoAutomation(0, 'automation-1')

    const calls = (fetch as ReturnType<typeof vi.fn>).mock.calls
    expect(new URL(calls[0][0]).pathname + new URL(calls[0][0]).search).toBe('/api/automations/runs?limit=25&offset=10')
    expect(new URL(calls[1][0]).pathname).toBe('/api/automations/automation-1/run')
  })

  it('cancels a run using the path-specific endpoint without a request body', async () => {
    await cancelRepoAutomationRun(0, 'automation-1', 'run-1')

    const [url, options] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
    expect(new URL(url).pathname).toBe('/api/automations/automation-1/runs/run-1/cancel')
    expect(options).toMatchObject({ method: 'POST' })
    expect(options).not.toHaveProperty('body')
  })

  it('maps persisted automation fields to the UI contract', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ automations: [{
      id: 'automation-abc', project_id: '42', agent_id: 'writer', state: 'active',
      schedule: { kind: 'recurring', cron: '0 9 * * *' }, next_run_at: 123, created_at: 100,
    }] }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    const { jobs } = await listAllAutomations()
    expect(jobs[0]).toMatchObject({
      id: 'automation-abc', repoId: 42, agentSlug: 'writer', enabled: true,
      automationMode: 'cron', cronExpression: '0 9 * * *', nextRunAt: 123, createdAt: 100,
    })
  })

  it('maps persisted run fields and automation context to the UI contract', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ runs: [{
      id: 'run-abc', automation_id: 'automation-abc', state: 'succeeded', trigger_key: 'manual:1',
      started_at: 200, finished_at: 300, result: { text: 'answer', sessionId: 'session-1' },
      automation: { name: 'Nightly', project_id: '42' },
    }] }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    const { runs } = await listAllAutomationRuns()
    expect(runs[0]).toMatchObject({
      id: 'run-abc', jobId: 'automation-abc', repoId: 42, jobName: 'Nightly',
      status: 'completed', triggerSource: 'manual:1', startedAt: 200, finishedAt: 300,
      responseText: 'answer', sessionId: 'session-1',
    })
  })

  it('gets counts from the bounded automation list route', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ jobs: [
      { id: '1', project_id: '7', state: 'active' },
      { id: '2', project_id: '7', state: 'paused' },
    ] }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    await expect(getAutomationCounts()).resolves.toEqual(new Map([[7, { total: 2, enabled: 1 }]]))
    expect(new URL((fetch as ReturnType<typeof vi.fn>).mock.calls[0][0]).pathname).toBe('/api/automations')
  })
})
