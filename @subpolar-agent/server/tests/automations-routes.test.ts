import { describe, expect, it, vi } from 'vitest'
import { handleAutomationsRoute } from '../routes/automations.ts'
import { handleNotificationsRoute } from '../routes/notifications.ts'
import { handleInboxRoute } from '../routes/inbox.ts'
import { AutomationRepository } from '../application/automations/automation.ts'
import { InboxRepository } from '../persistence/inbox.ts'
import { NotificationRepository } from '../persistence/notifications.ts'

function harness(seed: Record<string, Record<string, unknown>[]> = {}) {
  const collections = new Map(Object.entries(seed))
  const client = { collection: (name: string) => {
    const rows = collections.get(name) ?? []
    collections.set(name, rows)
    return {
      getFullList: vi.fn(async () => rows),
      getList: vi.fn(async (_page: number, limit: number) => ({ items: rows.slice(0, limit) })),
      getOne: async (id: string) => { const row = rows.find((item) => item.id === id); if (!row) throw new Error('not found'); return row },
      create: async (input: Record<string, unknown>) => { const row = { ...input, id: `${name}-${rows.length}` }; rows.push(row); return row },
      update: async (id: string, input: Record<string, unknown>) => { const row = rows.find((item) => item.id === id)!; Object.assign(row, input); return row },
      delete: async (id: string) => { rows.splice(rows.findIndex((item) => item.id === id), 1) },
    }
  } }
  const deps = {
    applicationDatabase: async () => client, AutomationRepository, InboxRepository, NotificationRepository,
    json: (value: unknown, status = 200) => Response.json(value, { status }),
    routeError: (_id: string, code: string, error: string, status: number) => Response.json({ code, error }, { status }),
    escapeFilter: (value: string) => value,
    routeLimit: (value: string | null, fallback = 50) => value === null ? fallback : Math.min(Number(value), 100),
    ownedProjectIdForRoute: async (_client: unknown, _owner: string, value: unknown) => value,
    body: (request: Request) => request.json(),
    object: (value: unknown) => value && typeof value === 'object' ? value : {},
    listAgents: async () => [{ id: 'agent-a' }],
    RequestSecurityError: class extends Error {},
    TRIGGER_KEY_ERROR: 'Invalid trigger_key',
  }
  const context = (path: string, method = 'GET', input?: unknown) => {
    const url = new URL(path, 'http://localhost')
    return { url, path: url.pathname.split('/').slice(1), request: new Request(url.href, { method, ...(input === undefined ? {} : { body: JSON.stringify(input), headers: { 'content-type': 'application/json' } }) }), correlationId: 'test', authenticatedUser: { id: 'owner-a' }, deps } as never
  }
  return { client, collections, deps, context }
}

const definition = { id: 'job-a', owner_id: 'owner-a', state: 'active', name: 'Daily', agent_id: 'agent-a', prompt: 'run', timezone: 'UTC', schedule: { kind: 'once', at: 1 } }

describe('automation and notification owner-scoped routes', () => {
  it('filters before pagination, crosses page boundaries, and translates completed status', async () => {
    const rows = Array.from({ length: 230 }, (_, index) => ({ id: `run-${index}`, owner_id: index % 2 ? 'owner-b' : 'owner-a', automation_id: 'job-a', state: 'succeeded', trigger_key: 'manual:1' }))
    const h = harness({ automations: [definition], automation_runs: rows })
    const response = await handleAutomationsRoute(h.context('/api/automations/runs?offset=95&limit=20&status=completed'))
    const result = await response!.json() as { runs: Array<Record<string, unknown>> }
    expect(result.runs).toHaveLength(20)
    expect(result.runs[0].id).toBe('run-190')
    expect(result.runs[19].id).toBe('run-228')
    expect(result.runs.every((run: Record<string, unknown>) => run.owner_id === 'owner-a')).toBe(true)
  })

  it('denies cross-user histories, run details, cancellation, and manual execution', async () => {
    const h = harness({ automations: [{ ...definition, owner_id: 'owner-b' }], automation_runs: [{ id: 'foreign-run', owner_id: 'owner-b', automation_id: 'job-a', state: 'running' }] })
    const history = await handleAutomationsRoute(h.context('/api/automations/job-a/history'))
    expect(await history!.json()).toEqual({ runs: [] })
    for (const [path, method] of [['/api/automations/job-a/runs/foreign-run', 'GET'], ['/api/automations/job-a/runs/foreign-run/cancel', 'POST'], ['/api/automations/job-a/run', 'POST']]) {
      expect((await handleAutomationsRoute(h.context(path, method)))!.status).toBe(404)
    }
    expect(h.collections.get('automation_runs')![0].state).toBe('running')
  })

  it('returns the paused state when creating a disabled job', async () => {
    const h = harness()
    const response = await handleAutomationsRoute(h.context('/api/automations', 'POST', { name: 'Paused', prompt: 'run', agent_id: 'agent-a', timezone: 'UTC', schedule: { kind: 'once', at: 1 }, enabled: false }))
    expect(response!.status).toBe(201)
    expect((await response!.json() as { automation: { state: string } }).automation.state).toBe('paused')
  })

  it('merges notification preferences without losing other preferences or event flags', async () => {
    const h = harness()
    const stored = { preferences: { theme: 'dark', notifications: { enabled: true, events: { permissionAsked: false, sessionError: true } } } }
    const save = vi.fn(async (_client, _owner, preferences) => ({ preferences, updated_at: 123 }))
    Object.assign(h.deps, { getUserPreferences: async () => stored, saveUserPreferences: save, notificationPreferenceValue: (value: unknown) => value })
    const response = await handleNotificationsRoute(h.context('/api/notifications/preferences', 'PATCH', { preferences: { events: { sessionIdle: true } } }))
    expect(response!.status).toBe(200)
    expect(save.mock.calls[0][1]).toBe('owner-a')
    expect(save.mock.calls[0][2]).toEqual({ theme: 'dark', notifications: { enabled: true, events: { permissionAsked: false, sessionError: true, sessionIdle: true } } })
  })

  it('never exposes another owner’s subscription or delivery, or accepts their deletion', async () => {
    const h = harness({ notification_subscriptions: [{ id: 'foreign', owner_id: 'owner-b', target: 'https://secret.example', enabled: true, channel: 'push' }], notification_deliveries: [{ id: 'foreign-delivery', owner_id: 'owner-b', state: 'failed', error_message: 'private' }] })
    expect(await (await handleNotificationsRoute(h.context('/api/notifications/subscriptions')))!.json()).toEqual({ subscriptions: [] })
    expect(await (await handleNotificationsRoute(h.context('/api/notifications/delivery-status')))!.json()).toEqual({ deliveries: [] })
    expect((await handleNotificationsRoute(h.context('/api/notifications/subscriptions/foreign', 'DELETE')))!.status).toBe(404)
    expect(h.collections.get('notification_subscriptions')).toHaveLength(1)
  })

  it('rejects forged approvals/results and foreign links; resolve only acknowledges an owned item', async () => {
    const h = harness({ inbox_items: [{ id: 'approval-a', owner_id: 'owner-a', kind: 'approval_required', reference_id: 'approval', title: 'Approve?', resolved: false }, { id: 'approval-b', owner_id: 'owner-b', kind: 'approval_required', reference_id: 'foreign', title: 'Private', resolved: false }], tool_approvals: [{ id: 'approval', state: 'pending' }] })
    for (const kind of ['approval_required', 'automation_result', 'browser_approval']) {
      expect((await handleInboxRoute(h.context('/api/inbox/items', 'POST', { kind, reference_id: 'foreign', title: 'Fake', deep_link: { path: '/runs/foreign' } })))!.status).toBe(403)
    }
    const list = await (await handleInboxRoute(h.context('/api/inbox')))!.json() as { items: Array<{ id: string }> }
    expect(list.items.map((item: { id: string }) => item.id)).toEqual(['approval-a'])
    expect((await handleInboxRoute(h.context('/api/inbox/approval-b/resolve', 'POST')))!.status).toBe(404)
    expect((await handleInboxRoute(h.context('/api/inbox/approval-a/resolve', 'POST')))!.status).toBe(200)
    expect(h.collections.get('tool_approvals')![0].state).toBe('pending')
    expect(h.collections.get('inbox_items')![1].resolved).toBe(false)
  })
})
