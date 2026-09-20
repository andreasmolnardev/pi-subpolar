import { describe, expect, it } from 'vitest'
import { AutomationLeaseError, AutomationRepository, createAutomationWorker, executeAutomation, expireAutomationLeases, nextCronRun, validateAutomationInput } from './automation.ts'
import { InboxRepository } from './inbox.ts'
import { NotificationRepository } from './notifications.ts'
import { TaskRepository } from './task-control-plane.ts'

function fakeClient(store = { records: new Map<string, Record<string, unknown>[]>(), sequence: 0 }) {
  const { records } = store
  const collection = (name: string) => {
    const rows = records.get(name) ?? []; records.set(name, rows)
    return {
      create: async (input: Record<string, unknown>) => {
        if (name === 'notification_deliveries' && rows.some((row) => row.delivery_key === input.delivery_key)) throw Object.assign(new Error('unique delivery key'), { status: 400 })
        const value = { id: `${name}-${++store.sequence}`, ...input }; rows.push(value); return value
      },
       update: async (id: string, input: Record<string, unknown>) => { const row = rows.find((candidate) => candidate.id === id)!; Object.assign(row, input); return row },
      getOne: async (id: string) => { const row = rows.find((candidate) => candidate.id === id); if (!row) throw new Error('not found'); return row },
       getFullList: async (_options?: unknown) => rows,
    }
  }
  return { collection }
}

describe('durable automation and inbox foundation', () => {
   it('rejects unsafe prompts, identifiers, schedules, and timezones', () => {
    expect(() => validateAutomationInput({ name: 'x', prompt: 'ok\u0000', agent_id: 'agent', timezone: 'UTC', schedule: { kind: 'once', at: Date.now() } })).toThrow()
    expect(() => validateAutomationInput({ name: 'x', prompt: 'ok', agent_id: 'bad id', timezone: 'UTC', schedule: { kind: 'once', at: Date.now() } })).toThrow()
    expect(() => validateAutomationInput({ name: 'x', prompt: 'ok', agent_id: 'agent', timezone: 'not/a-zone', schedule: { kind: 'recurring', cron: '* * *' } })).toThrow()
    expect(() => validateAutomationInput({ name: 'x', prompt: 'ok', agent_id: 'agent', timezone: 'UTC', schedule: { kind: 'recurring', cron: '61 * * * *' } })).toThrow()
  })

  it('does not allow two workers to acquire one run', async () => {
     const client = fakeClient(); const repository = new AutomationRepository(client as never, { serializationScope: 'process' })
    const definition = await repository.create('owner-a', { name: 'Race', prompt: 'run', agent_id: 'agent-a', timezone: 'UTC', schedule: { kind: 'once', at: Date.now() } })
    const pending = await repository.trigger('owner-a', definition.id, 'race')
    const started: Promise<unknown>[] = []
    const executor = async () => { const promise = new Promise((resolve) => setTimeout(resolve, 10)); started.push(promise); await promise }
    await Promise.all([executeAutomation(repository, 'owner-a', pending.id, executor), executeAutomation(repository, 'owner-a', pending.id, executor)])
    expect(started).toHaveLength(1)
  })

  it('fails closed without a serialized persistence capability', async () => {
    const client = fakeClient(); const repository = new AutomationRepository(client as never)
    const definition = await repository.create('owner-a', { name: 'Closed', prompt: 'run', agent_id: 'agent-a', timezone: 'UTC', schedule: { kind: 'once', at: Date.now() } })
    await expect(repository.trigger('owner-a', definition.id, 'manual')).rejects.toThrow('serialization capability')
  })

  it('calculates recurring due times in the configured timezone', async () => {
    const now = Date.parse('2026-01-01T23:30:00.000Z')
    const next = nextCronRun('0 0 * * *', 'America/Los_Angeles', now)
    expect(new Date(next).toISOString()).toBe('2026-01-02T08:00:00.000Z')
    const client = fakeClient(); const repository = new AutomationRepository(client as never, { serializationScope: 'process' })
    const definition = await repository.create('owner-a', { name: 'Timezone', prompt: 'run', agent_id: 'agent-a', timezone: 'America/Los_Angeles', schedule: { kind: 'recurring', cron: '* * * * *' } })
    expect(definition.next_run_at).toBeGreaterThan(Date.now())
    expect(await repository.triggerDue('owner-a', Date.now())).toHaveLength(0)
  })

  it('does not duplicate a due schedule while a skip-policy run is active', async () => {
    const client = fakeClient(); const repository = new AutomationRepository(client as never, { serializationScope: 'process' })
    const definition = await repository.create('owner-a', { name: 'Skip', prompt: 'run', agent_id: 'agent-a', timezone: 'UTC', schedule: { kind: 'once', at: Date.now() }, concurrency_policy: 'skip' })
    const manual = await repository.trigger('owner-a', definition.id, 'manual')
    await client.collection('automations').update(definition.id, { next_run_at: 0 })
    const due = await repository.triggerDue('owner-a', Date.now())
    expect(due).toEqual([expect.objectContaining({ id: manual.id })])
    expect(await repository.history('owner-a', definition.id)).toHaveLength(1)
  })

  it('drains queued runs in creation order after completion', async () => {
    const client = fakeClient(); const repository = new AutomationRepository(client as never, { serializationScope: 'process' })
    const definition = await repository.create('owner-a', { name: 'Queue', prompt: 'run', agent_id: 'agent-a', timezone: 'UTC', schedule: { kind: 'once', at: Date.now() }, concurrency_policy: 'queue' })
    const first = await repository.trigger('owner-a', definition.id, 'one'); const second = await repository.trigger('owner-a', definition.id, 'two')
    const order: string[] = []; const worker = createAutomationWorker(repository, async (current) => { order.push(current.trigger_key); return current.trigger_key })
    await worker.execute('owner-a', first.id); await worker.executeDue()
    expect(order).toEqual(['one', 'two']); expect(second.id).not.toBe(first.id)
  })

  it('drains a queued run after cancellation', async () => {
    const client = fakeClient(); const repository = new AutomationRepository(client as never, { serializationScope: 'process' })
    const definition = await repository.create('owner-a', { name: 'Queue cancel', prompt: 'run', agent_id: 'agent-a', timezone: 'UTC', schedule: { kind: 'once', at: Date.now() }, concurrency_policy: 'queue' })
    const first = await repository.trigger('owner-a', definition.id, 'one'); const second = await repository.trigger('owner-a', definition.id, 'two')
    const worker = createAutomationWorker(repository, async (current, _definition, signal) => {
      if (current.id === first.id) await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
      return current.trigger_key
    })
    const execution = worker.execute('owner-a', first.id); await new Promise((resolve) => setTimeout(resolve, 0)); await repository.cancelRun('owner-a', first.id)
    await expect(execution).resolves.toMatchObject({ state: 'cancelled' }); await worker.executeDue()
    expect((await repository.history('owner-a', definition.id)).find((item) => item.id === second.id)).toMatchObject({ state: 'succeeded' })
  })

  it('drains a queued run after lease expiry', async () => {
    const client = fakeClient(); const repository = new AutomationRepository(client as never, { serializationScope: 'process' })
    const definition = await repository.create('owner-a', { name: 'Queue lifecycle', prompt: 'run', agent_id: 'agent-a', timezone: 'UTC', schedule: { kind: 'once', at: Date.now() }, concurrency_policy: 'queue' })
    const first = await repository.trigger('owner-a', definition.id, 'one'); const second = await repository.trigger('owner-a', definition.id, 'two')
    const claimed = await repository.claimRun('owner-a', first.id, 1)
    await new Promise((resolve) => setTimeout(resolve, 5)); await expect(expireAutomationLeases(client as never, Date.now(), { serializationScope: 'process' })).resolves.toBe(1)
    const worker = createAutomationWorker(repository, async (current) => current.trigger_key)
    const drained = await worker.executeDue()
    expect(drained.find((item) => item.id === second.id)).toMatchObject({ state: 'succeeded' })
    expect((await repository.cancelRun('owner-a', second.id))?.state).toBe('succeeded')
    expect(claimed.run.state).toBe('running')
  })

  it('keeps duplicate queued triggers idempotent', async () => {
    const client = fakeClient(); const repository = new AutomationRepository(client as never, { serializationScope: 'process' })
    const definition = await repository.create('owner-a', { name: 'Queue duplicate', prompt: 'run', agent_id: 'agent-a', timezone: 'UTC', schedule: { kind: 'once', at: Date.now() }, concurrency_policy: 'queue' })
    const first = await repository.trigger('owner-a', definition.id, 'same'); const duplicate = await repository.trigger('owner-a', definition.id, 'same')
    expect(duplicate.id).toBe(first.id); expect((await repository.history('owner-a', definition.id)).filter((item) => item.trigger_key === 'same')).toHaveLength(1)
  })

   it('deduplicates by owner, project, kind, and reference without reopening resolved items', async () => {
     const repository = new InboxRepository(fakeClient() as never)
     const input = { owner_id: 'owner-a', kind: 'task_completed' as const, reference_id: 'task-1', title: 'Finished', metadata: { token: 'hidden' } }
     const first = await repository.upsert(input); const second = await repository.upsert({ ...input, title: 'Still finished' })
     expect(first.id).toBe(second.id); expect(second.metadata).toEqual({ token: '[REDACTED]' }); expect(await repository.resolveReference('owner-b', input.kind, input.reference_id)).toBe(false); expect(await repository.resolveReference('owner-a', input.kind, input.reference_id)).toBe(true)
     const duplicate = await repository.upsert({ ...input, title: 'Still done' })
     expect(duplicate.resolved).toBe(true)
      const transitioned = await repository.upsert({ ...input, title: 'Failed later', underlying_state: 'failed' })
      expect(transitioned.id).toBe(first.id); expect(transitioned.resolved).toBe(false); expect(transitioned.underlying_state).toBe('failed')
      const stored = await repository.upsert({ ...input, title: 'Still failed', metadata: { state: 'completed' } })
      expect(stored.resolved).toBe(false); expect(stored.underlying_state).toBe('failed')
     const projectItem = await repository.upsert({ ...input, project_id: 'project-a' })
     expect(projectItem.id).not.toBe(first.id)
     await expect(repository.upsert({ ...input, title: 'Bearer secret-token' })).resolves.toMatchObject({ title: 'Bearer [REDACTED]' })
    })

    it('converges concurrent unprojected upserts to one identity', async () => {
      const client = fakeClient()
      const repository = new InboxRepository(client as never)
      const input = { owner_id: 'owner-a', kind: 'task_completed' as const, reference_id: 'concurrent-task', title: 'Finished' }
      const results = await Promise.all(Array.from({ length: 8 }, () => repository.upsert(input)))
      expect(new Set(results.map((item) => item.id)).size).toBe(1)
      expect((await client.collection('inbox_items').getFullList({}))).toHaveLength(1)
    })

    it('bounds deep links and keeps only internal navigation values', async () => {
      const repository = new InboxRepository(fakeClient() as never)
      await expect(repository.upsert({ owner_id: 'owner-a', kind: 'agent_question', reference_id: 'question-1', title: 'Question', deep_link: { path: '/tasks/task-1', taskId: 'task-1' } })).resolves.toMatchObject({ deep_link: { path: '/tasks/task-1', taskId: 'task-1' } })
      await expect(repository.upsert({ owner_id: 'owner-a', kind: 'agent_question', reference_id: 'question-encoded', title: 'Question', deep_link: { path: '/tasks/task%2F1', taskId: 'task%2F1' } })).resolves.toMatchObject({ deep_link: { path: '/tasks/task%2F1', taskId: 'task%2F1' } })
      await expect(repository.upsert({ owner_id: 'owner-a', kind: 'agent_question', reference_id: 'question-project', title: 'Question', deep_link: { path: '/projects/project-1/sessions/session-1' } })).resolves.toMatchObject({ deep_link: { path: '/projects/project-1/sessions/session-1' } })
      await expect(repository.upsert({ owner_id: 'owner-a', kind: 'agent_question', reference_id: 'question-automation', title: 'Question', deep_link: { path: '/repos/project-1/automations' } })).resolves.toMatchObject({ deep_link: { path: '/repos/project-1/automations' } })
      await expect(repository.upsert({ owner_id: 'owner-a', kind: 'agent_question', reference_id: 'question-2', title: 'Question', deep_link: { url: 'https://external.example.test' } })).rejects.toThrow('deep link')
      await expect(repository.upsert({ owner_id: 'owner-a', kind: 'agent_question', reference_id: 'question-network', title: 'Question', deep_link: { path: '//evil' } })).rejects.toThrow('deep link')
      await expect(repository.upsert({ owner_id: 'owner-a', kind: 'agent_question', reference_id: 'question-unknown', title: 'Question', deep_link: { path: '/unknown/task-1' } })).rejects.toThrow('deep link')
     await expect(repository.upsert({ owner_id: 'owner-a', kind: 'agent_question', reference_id: 'question-3', title: 'Question', deep_link: { token: 'secret' } })).rejects.toThrow('deep link')
     await expect(repository.upsert({ owner_id: 'owner-a', kind: 'agent_question', reference_id: 'question-4', title: 'Question', deep_link: { path: '/'.repeat(501) } })).rejects.toThrow('deep link')
   })

  it('projects task review and terminal transitions into authoritative inbox items', async () => {
    const client = fakeClient(); const tasks = new TaskRepository(client as never)
    const task = await tasks.create({ owner_id: 'owner-a', project_id: 'project-a', state: 'queued', kind: 'task', title: 'Build', input: {} })
    await tasks.transition('owner-a', task.id, 'running'); await tasks.transition('owner-a', task.id, 'review_required'); await tasks.transition('owner-a', task.id, 'completed')
    const items = await client.collection('inbox_items').getFullList({})
    expect(items).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'review_required', resolved: true, underlying_state: 'review_required', project_id: 'project-a' }), expect.objectContaining({ kind: 'task_completed', resolved: false, underlying_state: 'completed', deep_link: { taskId: task.id } })]))

    const returning = await tasks.create({ owner_id: 'owner-a', project_id: 'project-a', state: 'queued', kind: 'task', title: 'Review again', input: {} })
    await tasks.transition('owner-a', returning.id, 'running'); await tasks.transition('owner-a', returning.id, 'review_required')
    await tasks.transition('owner-a', returning.id, 'running'); await tasks.transition('owner-a', returning.id, 'review_required')
    expect((await client.collection('inbox_items').getFullList({})).find((item) => item.reference_id === returning.id && item.kind === 'review_required')).toMatchObject({ resolved: false, underlying_state: 'review_required' })
  })

  it('projects each terminal automation outcome once and preserves inbox state when delivery fails', async () => {
    const client = fakeClient(); let deliveries = 0
    const repository = new AutomationRepository(client as never, {
      serializationScope: 'process',
      notificationAdapter: async () => { deliveries += 1; throw Object.assign(new Error('Bearer adapter-secret'), { code: 'adapter_failed' }) },
    })
    const notifications = new NotificationRepository(client as never)
    await notifications.subscribe('owner-a', { channel: 'email', target: 'owner@example.test' })
    const definition = await repository.create('owner-a', { name: 'Outcomes', prompt: 'run', agent_id: 'agent-a', timezone: 'UTC', schedule: { kind: 'once', at: Date.now() } })

    const success = await repository.trigger('owner-a', definition.id, 'success')
    await expect(executeAutomation(repository, 'owner-a', success.id, async () => ({ ok: true }))).resolves.toMatchObject({ state: 'succeeded' })
    await expect(executeAutomation(repository, 'owner-a', success.id, async () => ({ ok: true }))).resolves.toMatchObject({ state: 'succeeded' })

    const review = await repository.trigger('owner-a', definition.id, 'review')
    await executeAutomation(repository, 'owner-a', review.id, async () => ({ review_required: true, secret: 'hidden' }))
    const failure = await repository.trigger('owner-a', definition.id, 'failure')
    await executeAutomation(repository, 'owner-a', failure.id, async () => { throw new Error('Bearer failure-secret') })
    const interrupted = await repository.trigger('owner-a', definition.id, 'interrupted')
    const claimed = await repository.claimRun('owner-a', interrupted.id, 60000)
    await repository.markRunInterrupted({ id: interrupted.id, automation_id: definition.id, state: claimed.run.state, lease_id: claimed.leaseId }, 'Worker stopped')

    const items = (await client.collection('inbox_items').getFullList({})).filter((item) => item.kind === 'automation_result')
    expect(items).toHaveLength(4)
    expect(items).toEqual(expect.arrayContaining([
      expect.objectContaining({ reference_id: success.id, underlying_state: 'succeeded', deep_link: { path: `/runs/${success.id}`, runId: success.id, automationId: definition.id } }),
      expect.objectContaining({ reference_id: review.id, underlying_state: 'review_required' }),
      expect.objectContaining({ reference_id: failure.id, underlying_state: 'failed', body: 'Bearer [REDACTED]' }),
      expect.objectContaining({ reference_id: interrupted.id, underlying_state: 'interrupted' }),
    ]))
    expect(deliveries).toBe(4)
    expect((await client.collection('notification_deliveries').getFullList({}))).toEqual([expect.objectContaining({ state: 'failed', error_message: 'ADAPTER_FAILED: Bearer [REDACTED]' }), expect.objectContaining({ state: 'failed' }), expect.objectContaining({ state: 'failed' }), expect.objectContaining({ state: 'failed' })])
  })

  it('makes manual triggers idempotent and retries through the injected executor seam', async () => {
     const client = fakeClient(); const repository = new AutomationRepository(client as never, { serializationScope: 'process' })
    const definition = await repository.create('owner-a', { name: 'Nightly', prompt: 'summarize', agent_id: 'agent-a', timezone: 'UTC', schedule: { kind: 'once', at: Date.now() }, retry_policy: { max_attempts: 2, backoff_ms: 1000 } })
    const first = await repository.trigger('owner-a', definition.id, 'manual-1'); const duplicate = await repository.trigger('owner-a', definition.id, 'manual-1')
    expect(duplicate.id).toBe(first.id)
    await expect(executeAutomation(repository, 'owner-b', first.id, async () => undefined)).rejects.toThrow('Run not found')
    const failed = await executeAutomation(repository, 'owner-a', first.id, async () => { throw new Error('temporary') })
     expect(failed.state).toBe('retrying'); expect(failed.attempt).toBe(1); expect(failed.retry_at).toBeGreaterThan(Date.now()); expect(failed.retry_backoff_ms).toBe(1000)
    await expect(executeAutomation(repository, 'owner-a', first.id, async () => undefined)).resolves.toMatchObject({ state: 'retrying' })
     const storedRetry = await client.collection('automation_runs').getOne(first.id); await client.collection('automation_runs').update(first.id, { result: { __automation_retry: { next_attempt_at: 0, backoff_ms: 1000 } } }); expect(storedRetry.result).toBeDefined()
    const completed = await executeAutomation(repository, 'owner-a', first.id, async () => ({ secret: 'not persisted' }))
    expect(completed.state).toBe('succeeded'); expect(completed.result).toEqual({ secret: '[REDACTED]' })
  })

  it('passes a bounded redacted projection and keeps delivery durable when an adapter fails', async () => {
     const client = fakeClient(); const notifications = new NotificationRepository(client as never); const inbox = new InboxRepository(client as never)
     const item = await inbox.upsert({ owner_id: 'owner-a', kind: 'automation_result', reference_id: 'run-1', title: 'Bearer secret-token', body: 'Bearer another-secret', deep_link: { path: '/runs/run-1' }, metadata: { password: 'hidden', visible: 'ok' } })
     await notifications.subscribe('owner-a', { channel: 'email', target: 'owner@example.test' })
     let projection: Record<string, unknown> | undefined
     await expect(notifications.deliver('owner-a', item, async (_subscription, value) => { projection = value as unknown as Record<string, unknown>; expect(value).not.toHaveProperty('owner_id'); throw Object.assign(new Error('Bearer adapter-secret'), { code: 'adapter_failed' }) })).resolves.toBeUndefined()
      expect(projection).toMatchObject({ title: 'Bearer [REDACTED]', body: 'Bearer [REDACTED]', deep_link: { path: '/runs/run-1' }, metadata: { password: '[REDACTED]', visible: 'ok' } })
      const stored = await client.collection('inbox_items').getOne(item.id)
      stored.deep_link = { path: '//evil' }
      stored.underlying_state = 'failed'
      await notifications.deliver('owner-a', item, async (_subscription, value) => {
        expect(value).not.toHaveProperty('deep_link')
        expect(value).toHaveProperty('underlying_state', 'failed')
      })
      const deliveries = await client.collection('notification_deliveries').getFullList({}); expect(deliveries[0]).toMatchObject({ state: 'failed', error_message: 'ADAPTER_FAILED: Bearer [REDACTED]' }); expect(deliveries[0].error_message).not.toContain('adapter-secret')
    })

     it('deduplicates delivery across concurrent workers using the durable key', async () => {
      const store = { records: new Map<string, Record<string, unknown>[]>(), sequence: 0 }
      const client = fakeClient(store); const otherClient = fakeClient(store)
      const notifications = new NotificationRepository(client as never); const otherNotifications = new NotificationRepository(otherClient as never); const inbox = new InboxRepository(client as never)
      const item = await inbox.upsert({ owner_id: 'owner-a', kind: 'automation_result', reference_id: 'run-race', title: 'Result' })
      await notifications.subscribe('owner-a', { channel: 'push', target: 'https://push.example.test/subscription' })
      let sends = 0
      const adapter = async () => { sends += 1; await new Promise((resolve) => setTimeout(resolve, 5)) }
      await Promise.all([notifications.deliver('owner-a', item, adapter), otherNotifications.deliver('owner-a', item, adapter)])
      expect(sends).toBe(1)
       expect(await client.collection('notification_deliveries').getFullList({})).toHaveLength(1)
     })

      it('retries stale pending delivery reservations but suppresses fresh ones', async () => {
       const client = fakeClient(); const notifications = new NotificationRepository(client as never, { scope: 'durable', serialize: async (_key, work) => work() }); const inbox = new InboxRepository(client as never)
       const item = await inbox.upsert({ owner_id: 'owner-a', kind: 'automation_result', reference_id: 'run-stale', title: 'Result' })
       const subscription = await notifications.subscribe('owner-a', { channel: 'push', target: 'https://push.example.test/subscription' })
       const old = Date.now() - 10 * 60 * 1000
       await client.collection('notification_deliveries').create({ owner_id: 'owner-a', inbox_id: item.id, subscription_id: subscription.id, delivery_key: JSON.stringify(['owner-a', item.id, subscription.id]), state: 'pending', attempt: 1, lease_expires_at: old, created_at: old, updated_at: old })
       let retries = 0
       await notifications.deliver('owner-a', item, async () => { retries += 1 })
       expect(retries).toBe(1)

       const freshItem = await inbox.upsert({ owner_id: 'owner-a', kind: 'automation_result', reference_id: 'run-fresh', title: 'Fresh' })
       await client.collection('notification_deliveries').create({ owner_id: 'owner-a', inbox_id: freshItem.id, subscription_id: subscription.id, delivery_key: JSON.stringify(['owner-a', freshItem.id, subscription.id]), state: 'pending', attempt: 1, lease_expires_at: Date.now() + 60000, created_at: Date.now() })
       await notifications.deliver('owner-a', freshItem, async () => { retries += 1 })
        expect(retries).toBe(1)
      })

      it('fails closed instead of recovering stale delivery without durable serialization', async () => {
        const client = fakeClient(); const notifications = new NotificationRepository(client as never); const inbox = new InboxRepository(client as never)
        const item = await inbox.upsert({ owner_id: 'owner-a', kind: 'automation_result', reference_id: 'run-no-lease', title: 'Result' })
        const subscription = await notifications.subscribe('owner-a', { channel: 'push', target: 'https://push.example.test/subscription' })
        const old = Date.now() - 10 * 60 * 1000
        await client.collection('notification_deliveries').create({ owner_id: 'owner-a', inbox_id: item.id, subscription_id: subscription.id, delivery_key: JSON.stringify(['owner-a', item.id, subscription.id]), state: 'pending', attempt: 1, lease_expires_at: old, created_at: old, updated_at: old })
        let sends = 0
        await notifications.deliver('owner-a', item, async () => { sends += 1 })
        expect(sends).toBe(0)
        expect((await client.collection('notification_deliveries').getFullList({}))[0]).toMatchObject({ state: 'pending', attempt: 1 })
      })

      it('retries stale pending delivery reservations but suppresses fresh ones', async () => {
       const client = fakeClient(); const notifications = new NotificationRepository(client as never, { scope: 'durable', serialize: async (_key, work) => work() }); const inbox = new InboxRepository(client as never)
       const item = await inbox.upsert({ owner_id: 'owner-a', kind: 'automation_result', reference_id: 'run-stale', title: 'Result' })
       const subscription = await notifications.subscribe('owner-a', { channel: 'push', target: 'https://push.example.test/subscription' })
       const old = Date.now() - 10 * 60 * 1000
       await client.collection('notification_deliveries').create({ owner_id: 'owner-a', inbox_id: item.id, subscription_id: subscription.id, delivery_key: JSON.stringify(['owner-a', item.id, subscription.id]), state: 'pending', attempt: 1, lease_expires_at: old, created_at: old, updated_at: old })
       let retries = 0
       await notifications.deliver('owner-a', item, async () => { retries += 1 })
       expect(retries).toBe(1)

       const freshItem = await inbox.upsert({ owner_id: 'owner-a', kind: 'automation_result', reference_id: 'run-fresh', title: 'Fresh' })
       await client.collection('notification_deliveries').create({ owner_id: 'owner-a', inbox_id: freshItem.id, subscription_id: subscription.id, delivery_key: JSON.stringify(['owner-a', freshItem.id, subscription.id]), state: 'pending', attempt: 1, lease_expires_at: Date.now() + 60000, created_at: Date.now() })
       await notifications.deliver('owner-a', freshItem, async () => { retries += 1 })
       expect(retries).toBe(1)
     })

   it('denies cross-user inbox and notification access', async () => {
     const client = fakeClient(); const notifications = new NotificationRepository(client as never); const inbox = new InboxRepository(client as never)
     const item = await inbox.upsert({ owner_id: 'owner-a', kind: 'automation_result', reference_id: 'run-cross-user', title: 'Result' })
     await notifications.subscribe('owner-a', { channel: 'email', target: 'owner@example.test' })
     expect(await inbox.list('owner-b')).toEqual([])
     await expect(inbox.resolve('owner-b', item.id)).resolves.toBeNull()
     await expect(notifications.deliver('owner-b', item, async () => undefined)).rejects.toThrow('not owned')
     expect(await notifications.list('owner-b')).toEqual([])
   })

  it('cancellation transitions the run and signals the injected executor', async () => {
     const client = fakeClient(); const repository = new AutomationRepository(client as never, { serializationScope: 'process' })
    const definition = await repository.create('owner-a', { name: 'Cancelable', prompt: 'run', agent_id: 'agent-a', timezone: 'UTC', schedule: { kind: 'once', at: Date.now() } })
    const pending = await repository.trigger('owner-a', definition.id, 'cancel')
    let signaled = false
    const execution = executeAutomation(repository, 'owner-a', pending.id, async (_run, _automation, signal) => await new Promise<void>((resolve) => { signal.addEventListener('abort', () => { signaled = true; resolve() }, { once: true }) }))
    await new Promise((resolve) => setTimeout(resolve, 0)); await repository.cancelRun('owner-a', pending.id); await expect(execution).resolves.toMatchObject({ state: 'cancelled' }); expect(signaled).toBe(true)
  })

  it('rejects ownership mutation fields even when the record is owned', async () => {
    const client = fakeClient(); const repository = new AutomationRepository(client as never, { serializationScope: 'process' })
    const definition = await repository.create('owner-a', { name: 'Owned', prompt: 'run', agent_id: 'agent-a', timezone: 'UTC', schedule: { kind: 'once', at: Date.now() } })
    await expect(repository.update('owner-a', definition.id, { owner_id: 'owner-b' } as never)).rejects.toThrow('Unsupported automation field')
    expect((await repository.getOwned('owner-a', definition.id))?.owner_id).toBe('owner-a')
  })

  it('denies manual and scheduler triggers for paused automations', async () => {
    const client = fakeClient(); const repository = new AutomationRepository(client as never, { serializationScope: 'process' })
    const definition = await repository.create('owner-a', { name: 'Paused', prompt: 'run', agent_id: 'agent-a', timezone: 'UTC', schedule: { kind: 'once', at: Date.now() } })
    await client.collection('automations').update(definition.id, { state: 'paused', next_run_at: 0 })
    await expect(repository.trigger('owner-a', definition.id, 'manual')).rejects.toThrow('not active')
    expect(await repository.triggerDue('owner-a', Date.now())).toEqual([])
  })

  it('fails closed for disabled automation records', async () => {
    const client = fakeClient(); const repository = new AutomationRepository(client as never, { serializationScope: 'process' })
    const definition = await repository.create('owner-a', { name: 'Disabled', prompt: 'run', agent_id: 'agent-a', timezone: 'UTC', schedule: { kind: 'once', at: Date.now() } })
    await client.collection('automations').update(definition.id, { state: 'disabled', next_run_at: 0 })
    await expect(repository.trigger('owner-a', definition.id, 'manual')).rejects.toThrow('not active')
    expect(await repository.triggerDue('owner-a', Date.now())).toEqual([])
  })

  it('rejects expired lease renewal and finish and interrupts the stale run', async () => {
    const client = fakeClient(); const repository = new AutomationRepository(client as never, { serializationScope: 'process' })
    const definition = await repository.create('owner-a', { name: 'Lease', prompt: 'run', agent_id: 'agent-a', timezone: 'UTC', schedule: { kind: 'once', at: Date.now() } })
    const pending = await repository.trigger('owner-a', definition.id, 'lease')
    const claimed = await repository.claimRun('owner-a', pending.id, 10)
    expect(await repository.renewLease('owner-b', pending.id, claimed.leaseId!)).toBe(false)
    await expect(repository.finishRun('owner-b', pending.id, claimed.leaseId!, definition, { ok: true })).rejects.toThrow('Run not found')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(await repository.renewLease('owner-a', pending.id, claimed.leaseId!)).toBe(false)
    await expect(repository.finishRun('owner-a', pending.id, claimed.leaseId!, definition, { ok: true })).rejects.toBeInstanceOf(AutomationLeaseError)
    expect((await repository.history('owner-a', definition.id))[0]).toMatchObject({ state: 'interrupted' })
  })

  it('executes due runs through the injected worker and preserves retry idempotency', async () => {
    const client = fakeClient(); const repository = new AutomationRepository(client as never, { serializationScope: 'process' })
    const definition = await repository.create('owner-a', { name: 'Worker', prompt: 'run', agent_id: 'agent-a', timezone: 'UTC', schedule: { kind: 'once', at: Date.now() }, retry_policy: { max_attempts: 2, backoff_ms: 0 } })
    await client.collection('automations').update(definition.id, { next_run_at: 0 })
    let attempts = 0
    const worker = createAutomationWorker(repository, async () => { attempts += 1; if (attempts === 1) throw new Error('temporary'); return { ok: true } }, 1000)
    const first = await worker.executeDue(Date.now())
    expect(first[0]).toMatchObject({ state: 'retrying', attempt: 1 })
    await client.collection('automation_runs').update(first[0].id, { result: { __automation_retry: { next_attempt_at: 0, backoff_ms: 0 } } })
    const second = [await executeAutomation(repository, 'owner-a', first[0].id, async () => ({ ok: true }))]
    expect(second[0]).toMatchObject({ state: 'succeeded', attempt: 2 })
    const manual = await repository.trigger('owner-a', definition.id, 'manual')
    expect((await repository.trigger('owner-a', definition.id, 'manual')).id).toBe(manual.id)
    expect((await worker.executeDue(Date.now()))[0]).toMatchObject({ id: manual.id, state: 'succeeded' })
  })
})
