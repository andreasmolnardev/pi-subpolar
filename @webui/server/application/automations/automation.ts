import type PocketBase from 'pocketbase'
import { escapeFilter } from '../../persistence/pocketbase.ts'
import { assertSafeIdentifier } from '../task-control-plane.ts'
import { InboxRepository, type InboxItem } from '../../persistence/inbox.ts'
import { NotificationRepository, type NotificationAdapter } from '../../persistence/notifications.ts'
import { redactSensitive } from '../../core/security-redaction.ts'

export const AUTOMATION_STATES = ['active', 'paused', 'disabled', 'deleted'] as const
export type AutomationState = (typeof AUTOMATION_STATES)[number]
export const RUN_STATES = ['pending', 'leased', 'running', 'succeeded', 'failed', 'retrying', 'cancelled', 'unknown', 'interrupted'] as const
export type RunState = (typeof RUN_STATES)[number]

export type AutomationInput = {
  name: string
  prompt: string
  agent_id: string
  project_id?: string
  timezone: string
  schedule: { kind: 'once' | 'recurring'; at?: number; cron?: string }
  retry_policy?: { max_attempts?: number; backoff_ms?: number }
  concurrency_policy?: 'allow' | 'skip' | 'queue'
}
export type AutomationRecord = AutomationInput & { id: string; owner_id: string; state: AutomationState; next_run_at?: number; last_run_at?: number; created_at: number; updated_at: number }
export type AutomationRun = { id: string; automation_id: string; owner_id: string; trigger_key: string; state: RunState; attempt: number; lease_id?: string; lease_expires_at?: number; started_at?: number; finished_at?: number; result?: unknown; error_message?: string; retry_at?: number; retry_backoff_ms?: number; created_at: number }

export type AutomationPersistenceCapability = {
  scope: 'process' | 'durable'
  serialize?: (key: string, work: () => Promise<unknown>) => Promise<unknown>
  transaction?: (work: () => Promise<unknown>) => Promise<unknown>
  notificationAdapter?: NotificationAdapter
}

export class AutomationLeaseError extends Error {
  readonly code = 'AUTOMATION_LEASE_INVALID'

  constructor(message = 'Automation lease is expired or no longer owned') {
    super(message)
    this.name = 'AutomationLeaseError'
  }
}

export type AutomationRepositoryOptions = {
  serializationScope?: AutomationPersistenceCapability['scope']
  serialize?: AutomationPersistenceCapability['serialize']
  transaction?: AutomationPersistenceCapability['transaction']
  inbox?: InboxRepository
  notificationAdapter?: NotificationAdapter
}

const SAFE_PROMPT = /^[^\u0000-\u0008\u000b\u000c\u000e-\u001f]{1,12000}$/
const CRON_RANGES = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]] as const
const MAX_TEXT = 12000
const RETRY_METADATA = '__automation_retry'
const ACTIVE_RUN_STATES: readonly RunState[] = ['pending', 'leased', 'running', 'retrying']

type Collection = {
  create: (input: Record<string, unknown>) => Promise<Record<string, unknown>>
  update: (id: string, input: Record<string, unknown>) => Promise<Record<string, unknown>>
  getOne: (id: string) => Promise<Record<string, unknown>>
  getFirstListItem: (filter: string) => Promise<Record<string, unknown>>
  getFullList: (options?: Record<string, unknown>) => Promise<Record<string, unknown>[]>
}

function collection(client: PocketBase, name: string): Collection {
  return client.collection(name) as unknown as Collection
}

function validCronField(value: string, min: number, max: number): boolean {
  return value.split(',').every((part) => {
    const [base, stepText] = part.split('/')
    if (part.split('/').length > 2 || (stepText !== undefined && (!/^\d+$/.test(stepText) || Number(stepText) < 1))) return false
    const range = base === '*' ? [min, max] : base.split('-').map(Number)
    if (range.length > 2 || range.some((item) => !Number.isInteger(item) || item < min || item > max) || range[0] > range[range.length - 1]) return false
    return true
  })
}

function cronMatches(value: number, field: string, min: number, max: number): boolean {
  return field.split(',').some((part) => {
    const [base, stepText] = part.split('/')
    const step = Number(stepText ?? 1)
    const range = base === '*' ? [min, max] : base.split('-').map(Number)
    const values = value === 0 && max === 7 ? [0, 7] : [value]
    return values.some((candidate) => candidate >= range[0] && candidate <= (range[1] ?? range[0]) && (candidate - range[0]) % step === 0)
  })
}

function localCronParts(date: Date, timezone: string): { minute: number; hour: number; day: number; month: number; weekday: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(date)
  const values = Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]))
  return { minute: Number(values.minute), hour: Number(values.hour), day: Number(values.day), month: Number(values.month), weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(values.weekday) }
}

export function nextCronRun(cron: string, timezone: string, after: number): number {
  const fields = cron.split(' ')
  const candidate = new Date(Math.floor(after / 60000) * 60000 + 60000)
  for (let i = 0; i < 366 * 24 * 60; i++) {
    const local = localCronParts(candidate, timezone)
    if (cronMatches(local.minute, fields[0], 0, 59) && cronMatches(local.hour, fields[1], 0, 23) && cronMatches(local.day, fields[2], 1, 31) && cronMatches(local.month, fields[3], 1, 12) && cronMatches(local.weekday, fields[4], 0, 7)) return candidate.getTime()
    candidate.setUTCMinutes(candidate.getUTCMinutes() + 1)
  }
  throw new Error('Recurring schedule has no run within the supported horizon')
}

export function validateCron(cron: string): string {
  const fields = cron.trim().split(/\s+/)
  if (fields.length !== 5 || fields.some((field, index) => !validCronField(field, CRON_RANGES[index][0], CRON_RANGES[index][1]))) throw new Error('Invalid recurring schedule')
  return fields.join(' ')
}

export function validateAutomationInput(input: AutomationInput): AutomationInput {
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 200) throw new Error('Invalid automation name')
  if (typeof input.prompt !== 'string' || !SAFE_PROMPT.test(input.prompt) || input.prompt.length > MAX_TEXT) throw new Error('Invalid automation prompt')
  assertSafeIdentifier(input.agent_id, 'agent id')
  if (input.project_id) assertSafeIdentifier(input.project_id, 'project id')
  try { new Intl.DateTimeFormat('en-US', { timeZone: input.timezone }) } catch { throw new Error('Invalid timezone') }
  if (input.schedule.kind !== 'once' && input.schedule.kind !== 'recurring') throw new Error('Invalid automation schedule')
  if (input.schedule.kind === 'once' && (!Number.isSafeInteger(input.schedule.at) || input.schedule.at! <= 0)) throw new Error('One-shot automation requires a valid time')
  if (input.schedule.kind === 'recurring' && (!input.schedule.cron || !validateCron(input.schedule.cron))) throw new Error('Invalid recurring schedule')
  if (input.retry_policy?.max_attempts !== undefined && (!Number.isInteger(input.retry_policy.max_attempts) || input.retry_policy.max_attempts < 1 || input.retry_policy.max_attempts > 10)) throw new Error('Invalid retry policy')
  if (input.retry_policy?.backoff_ms !== undefined && (!Number.isInteger(input.retry_policy.backoff_ms) || input.retry_policy.backoff_ms < 0 || input.retry_policy.backoff_ms > 86400000)) throw new Error('Invalid retry backoff')
  return { ...input, name: input.name.trim(), schedule: { ...input.schedule, ...(input.schedule.cron ? { cron: validateCron(input.schedule.cron) } : {}) }, concurrency_policy: input.concurrency_policy ?? 'skip', retry_policy: { max_attempts: 1, backoff_ms: 1000, ...input.retry_policy } }
}

function automation(value: Record<string, unknown>): AutomationRecord { return value as unknown as AutomationRecord }

function run(value: Record<string, unknown>): AutomationRun {
  const retry = value.result && typeof value.result === 'object' && !Array.isArray(value.result) ? (value.result as Record<string, unknown>)[RETRY_METADATA] : undefined
  const metadata = retry && typeof retry === 'object' ? retry as Record<string, unknown> : undefined
  return { ...value, ...(metadata ? { retry_at: metadata.next_attempt_at, retry_backoff_ms: metadata.backoff_ms, result: undefined } : {}) } as unknown as AutomationRun
}

function runOrder(left: AutomationRun, right: AutomationRun): number {
  return left.created_at - right.created_at || left.id.localeCompare(right.id)
}

function queueCanRun(candidate: AutomationRun, runs: AutomationRun[]): boolean {
  if (runs.some((other) => other.id !== candidate.id && ['leased', 'running'].includes(other.state))) return false
  return !runs.some((other) => other.id !== candidate.id
    && ['pending', 'retrying'].includes(other.state)
    && runOrder(other, candidate) < 0)
}

const localLocks = new WeakMap<object, Map<string, Promise<void>>>()

async function withLocalLock<T>(client: object, key: string, work: () => Promise<T>): Promise<T> {
  let locks = localLocks.get(client)
  if (!locks) { locks = new Map(); localLocks.set(client, locks) }
  const previous = locks.get(key) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => { release = resolve })
  locks.set(key, current)
  await previous
  try { return await work() } finally { release(); if (locks.get(key) === current) locks.delete(key) }
}

function capabilityFromClient(client: PocketBase): AutomationPersistenceCapability | undefined {
  return (client as unknown as { automationPersistence?: AutomationPersistenceCapability }).automationPersistence
}

type AutomationResultState = 'succeeded' | 'failed' | 'review_required' | 'interrupted'

function resultRequiresReview(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return record.review_required === true || record.state === 'review_required' || record.status === 'review_required' || record.underlying_state === 'review_required'
}

export class AutomationRepository {
  private readonly options: AutomationRepositoryOptions
  private readonly inbox: InboxRepository
  private readonly notifications: NotificationRepository
  private readonly notificationAdapter?: NotificationAdapter
  constructor(private readonly client: PocketBase, options: AutomationRepositoryOptions = {}) {
    const capability = capabilityFromClient(client)
    this.options = { serializationScope: capability?.scope ?? options.serializationScope, serialize: options.serialize ?? capability?.serialize, transaction: options.transaction ?? capability?.transaction }
    this.inbox = options.inbox ?? new InboxRepository(client)
    this.notifications = new NotificationRepository(client)
    this.notificationAdapter = options.notificationAdapter ?? capability?.notificationAdapter
  }

  private async atomic<T>(key: string, work: () => Promise<T>): Promise<T> {
    if (this.options.transaction) return await this.options.transaction(work as () => Promise<unknown>) as T
    if (this.options.serialize) return await this.options.serialize(key, work as () => Promise<unknown>) as T
    if (this.options.serializationScope === 'process') return withLocalLock(this.client as unknown as object, key, work)
    throw new Error('Durable automation serialization capability unavailable')
  }

  private async getRun(runId: string): Promise<Record<string, unknown> | null> { return collection(this.client, 'automation_runs').getOne(runId).catch(() => null) }

  private async interruptExpiredRun(runId: string, message: string): Promise<void> {
    const updated = await collection(this.client, 'automation_runs').update(runId, { state: 'interrupted', error_message: message, finished_at: Date.now(), lease_id: null, lease_expires_at: null })
    const ownerId = typeof updated.owner_id === 'string' ? updated.owner_id : undefined
    const automationId = typeof updated.automation_id === 'string' ? updated.automation_id : undefined
    if (ownerId && automationId) {
      const definition = await this.getOwned(ownerId, automationId)
      if (definition) await this.projectResult(ownerId, run(updated), definition, 'interrupted', message)
    }
    activeExecutors.get(this.client as unknown as object)?.get(runId)?.abort()
  }

  private async projectResult(ownerId: string, runRecord: AutomationRun, definition: AutomationRecord, state: AutomationResultState, errorMessage?: string): Promise<InboxItem> {
    const item = await this.inbox.upsert({
      owner_id: ownerId,
      ...(definition.project_id ? { project_id: definition.project_id } : {}),
      kind: 'automation_result',
      reference_id: runRecord.id,
      title: state === 'review_required' ? 'Automation requires review' : state === 'failed' ? 'Automation failed' : state === 'interrupted' ? 'Automation interrupted' : 'Automation completed',
      body: state === 'failed' || state === 'interrupted'
        ? (errorMessage ?? 'The automation run needs attention.')
        : state === 'review_required'
          ? 'Review the automation result before accepting it.'
          : 'The automation completed successfully.',
      deep_link: { path: `/runs/${encodeURIComponent(runRecord.id)}`, runId: runRecord.id, automationId: definition.id },
      underlying_state: state,
      metadata: { automation_id: definition.id, run_id: runRecord.id, state },
      reopen: true,
    })
    if (this.notificationAdapter) {
      try { await this.notifications.deliver(ownerId, item, this.notificationAdapter) } catch { /* Inbox state is authoritative. */ }
    }
    return item
  }

  private async runsFor(ownerId: string, automationId: string): Promise<AutomationRun[]> {
    const records = await collection(this.client, 'automation_runs').getFullList({ filter: `owner_id = "${escapeFilter(ownerId)}" && automation_id = "${escapeFilter(automationId)}"` })
    return records.filter((record) => record.owner_id === ownerId && record.automation_id === automationId).map(run)
  }

  private async advanceSchedule(record: AutomationRecord, now: number): Promise<void> {
    const next = record.schedule.kind === 'recurring' ? nextCronRun(record.schedule.cron!, record.timezone, now) : null
    await collection(this.client, 'automations').update(record.id, { next_run_at: next, updated_at: Date.now() })
  }

  async create(ownerId: string, input: AutomationInput): Promise<AutomationRecord> {
    assertSafeIdentifier(ownerId, 'owner id')
    const valid = validateAutomationInput(input)
    const now = Date.now()
    const next = valid.schedule.kind === 'once' ? valid.schedule.at : nextCronRun(valid.schedule.cron!, valid.timezone, now)
    return automation(await collection(this.client, 'automations').create({ ...valid, owner_id: ownerId, state: 'active', next_run_at: next, created_at: now, updated_at: now }))
  }

  async getOwned(ownerId: string, id: string): Promise<AutomationRecord | null> {
    const value = await collection(this.client, 'automations').getOne(id).catch(() => null)
    return value && value.owner_id === ownerId ? automation(value) : null
  }

  async listOwned(ownerId: string): Promise<AutomationRecord[]> {
    return (await collection(this.client, 'automations').getFullList({ filter: `owner_id = "${escapeFilter(ownerId)}" && state != "deleted"`, sort: '-created_at' })).filter((value) => value.owner_id === ownerId && value.state !== 'deleted').map(automation)
  }

  async update(ownerId: string, id: string, input: Partial<AutomationInput>): Promise<AutomationRecord | null> {
    const forbidden = Object.keys(input).filter((key) => !['name', 'prompt', 'agent_id', 'project_id', 'timezone', 'schedule', 'retry_policy', 'concurrency_policy'].includes(key))
    if (forbidden.length) throw new Error(`Unsupported automation field: ${forbidden[0]}`)
    const current = await this.getOwned(ownerId, id)
    if (!current) return null
    const merged = validateAutomationInput({ ...current, ...input, schedule: input.schedule ?? current.schedule, retry_policy: input.retry_policy ? { ...current.retry_policy, ...input.retry_policy } : current.retry_policy, timezone: input.timezone ?? current.timezone })
    const patch: Record<string, unknown> = {}
    for (const key of Object.keys(input)) patch[key] = (merged as unknown as Record<string, unknown>)[key]
    if (input.schedule !== undefined || input.timezone !== undefined) patch.next_run_at = merged.schedule.kind === 'once' ? merged.schedule.at : nextCronRun(merged.schedule.cron!, merged.timezone, Date.now())
    patch.updated_at = Date.now()
    return automation(await collection(this.client, 'automations').update(id, patch))
  }

  async cancel(ownerId: string, id: string): Promise<boolean> {
    const current = await this.getOwned(ownerId, id)
    if (!current) return false
    return this.atomic(`automation:${id}`, async () => {
      const owned = await this.getOwned(ownerId, id)
      if (!owned) return false
      await collection(this.client, 'automations').update(id, { state: 'paused', updated_at: Date.now() })
      return true
    })
  }

  async history(ownerId: string, id: string): Promise<AutomationRun[]> {
    if (!(await this.getOwned(ownerId, id))) return []
    return (await this.runsFor(ownerId, id)).sort((a, b) => b.created_at - a.created_at)
  }

  private async triggerLocked(ownerId: string, record: AutomationRecord, triggerKey: string, now: number): Promise<AutomationRun> {
    const runs = await this.runsFor(ownerId, record.id)
    const existing = runs.find((candidate) => candidate.trigger_key === triggerKey)
    if (existing) return existing
    const active = runs.find((candidate) => ACTIVE_RUN_STATES.includes(candidate.state))
    if (active && record.concurrency_policy === 'skip') return active
    try {
      return run(await collection(this.client, 'automation_runs').create({ automation_id: record.id, owner_id: ownerId, trigger_key: triggerKey, state: 'pending', attempt: 0, created_at: now }))
    } catch (error) {
      const raced = (await this.runsFor(ownerId, record.id)).find((candidate) => candidate.trigger_key === triggerKey)
      if (raced) return raced
      throw new Error('Unable to create automation run', { cause: error })
    }
  }

  async triggerDue(ownerId: string, now = Date.now()): Promise<AutomationRun[]> {
    const due = await this.listOwned(ownerId)
    const triggered: AutomationRun[] = []
    for (const item of due) {
      const result = await this.atomic(`automation:${item.id}`, async () => {
        const record = await this.getOwned(ownerId, item.id)
        if (!record || record.state !== 'active' || (record.next_run_at ?? Number.MAX_SAFE_INTEGER) > now) return null
        const runs = await this.runsFor(ownerId, record.id)
        const retry = runs.find((candidate) => candidate.state === 'retrying')
        if (retry) {
          if ((retry.retry_at ?? Number.MAX_SAFE_INTEGER) <= now) return retry
          if (record.concurrency_policy === 'skip') await this.advanceSchedule(record, now)
          return retry
        }
        const active = runs.find((candidate) => ACTIVE_RUN_STATES.includes(candidate.state))
        if (active && record.concurrency_policy === 'skip') { await this.advanceSchedule(record, now); return active }
        const scheduledAt = record.next_run_at ?? now
        const result = await this.triggerLocked(ownerId, record, `schedule:${record.id}:${scheduledAt}`, now)
        await this.advanceSchedule(record, now)
        return result
      })
      if (result) triggered.push(result)
    }
    return triggered
  }

  async triggerDueAll(now = Date.now()): Promise<AutomationRun[]> {
    const records = await collection(this.client, 'automations').getFullList()
    const owners = [...new Set(records
      .filter((record) => record.state === 'active' && typeof record.owner_id === 'string' && typeof record.next_run_at === 'number' && record.next_run_at <= now)
      .map((record) => record.owner_id as string))]
    const triggered = await Promise.all(owners.map((ownerId) => this.triggerDue(ownerId, now)))
    return triggered.flat()
  }

  async runnableRuns(now = Date.now()): Promise<AutomationRun[]> {
    const records = await collection(this.client, 'automation_runs').getFullList()
    const result: AutomationRun[] = []
    for (const record of records) {
      const candidate = run(record)
      if (!['pending', 'retrying'].includes(candidate.state) || (candidate.state === 'retrying' && (candidate.retry_at ?? Number.MAX_SAFE_INTEGER) > now)) continue
      const definition = await this.getOwned(String(candidate.owner_id), String(candidate.automation_id))
       if (definition?.state !== 'active') continue
       if (definition.concurrency_policy === 'queue' && !queueCanRun(candidate, await this.runsFor(candidate.owner_id, candidate.automation_id))) continue
       result.push(candidate)
    }
    return result
  }

  async trigger(ownerId: string, id: string, triggerKey: string): Promise<AutomationRun> {
    const record = await this.getOwned(ownerId, id)
    if (!record) throw new Error('Automation not found')
    return this.atomic(`automation:${id}`, async () => {
      const current = await this.getOwned(ownerId, id)
      if (!current) throw new Error('Automation not found')
      if (current.state !== 'active') throw new Error('Automation is not active')
      return this.triggerLocked(ownerId, current, triggerKey, Date.now())
    })
  }

  async cancelRun(ownerId: string, runId: string): Promise<AutomationRun | null> {
    const initial = await this.getRun(runId)
    if (!initial || initial.owner_id !== ownerId) return null
    return this.atomic(`automation:${initial.automation_id}`, async () => {
      const current = await this.getRun(runId)
      if (!current || current.owner_id !== ownerId) return null
      const currentRun = run(current)
      if (!ACTIVE_RUN_STATES.includes(currentRun.state)) return currentRun
      const updated = await collection(this.client, 'automation_runs').update(runId, { state: 'cancelled', finished_at: Date.now(), lease_id: null, lease_expires_at: null })
      activeExecutors.get(this.client as unknown as object)?.get(runId)?.abort()
      return run(updated)
    })
  }

  async renewLease(ownerId: string, runId: string, leaseId: string, leaseMs = 60000): Promise<boolean> {
    const initial = await this.getRun(runId)
    if (!initial || initial.owner_id !== ownerId) return false
    return this.atomic(`automation:${initial.automation_id}`, async () => {
      const current = await this.getRun(runId)
      if (!current || current.owner_id !== ownerId || current.state !== 'running' || current.lease_id !== leaseId) return false
      const now = Date.now()
      if (typeof current.lease_expires_at !== 'number' || current.lease_expires_at <= now) {
        await this.interruptExpiredRun(runId, 'Automation lease expired before renewal')
        return false
      }
      if (!Number.isFinite(leaseMs) || leaseMs <= 0) return false
      await collection(this.client, 'automation_runs').update(runId, { lease_expires_at: now + leaseMs })
      return true
    })
  }

  async claimRun(ownerId: string, runId: string, leaseMs: number): Promise<{ run: AutomationRun; automation: AutomationRecord; leaseId?: string }> {
    const initial = await this.getRun(runId)
    if (!initial || initial.owner_id !== ownerId) throw new Error('Run not found')
    return this.atomic(`automation:${initial.automation_id}`, async () => {
      const raw = await this.getRun(runId)
      if (!raw || raw.owner_id !== ownerId) throw new Error('Run not found')
      const record = await this.getOwned(ownerId, String(raw.automation_id))
      if (!record) throw new Error('Automation not found')
      const current = run(raw)
      const now = Date.now()
      if (['leased', 'running'].includes(current.state) && (typeof current.lease_expires_at !== 'number' || current.lease_expires_at <= now)) {
        await this.interruptExpiredRun(runId, 'Automation lease expired before claim')
        const interrupted = await this.getRun(runId)
        return { run: run(interrupted!), automation: record }
      }
      if (record.state !== 'active') return { run: current, automation: record }
      if (!['pending', 'retrying'].includes(current.state)) return { run: current, automation: record }
      if (current.state === 'retrying' && (current.retry_at ?? Number.MAX_SAFE_INTEGER) > now) return { run: current, automation: record }
       const runs = await this.runsFor(ownerId, record.id)
       const active = runs.find((candidate) => candidate.id !== runId && (record.concurrency_policy === 'queue' ? ['leased', 'running'].includes(candidate.state) : ACTIVE_RUN_STATES.includes(candidate.state)))
       if (active && record.concurrency_policy !== 'allow') return { run: current, automation: record }
       if (record.concurrency_policy === 'queue' && !queueCanRun(current, runs)) return { run: current, automation: record }
      const leaseId = crypto.randomUUID()
      await collection(this.client, 'automation_runs').update(runId, { state: 'leased', lease_id: leaseId, lease_expires_at: now + leaseMs, attempt: current.attempt + 1, result: null })
      const running = await collection(this.client, 'automation_runs').update(runId, { state: 'running', started_at: now })
      return { run: run(running), automation: record, leaseId }
    })
  }

  async finishRun(ownerId: string, runId: string, leaseId: string, automationRecord: AutomationRecord, resultValue: unknown, error?: unknown): Promise<AutomationRun> {
    const initial = await this.getRun(runId)
    if (!initial || initial.owner_id !== ownerId) throw new Error('Run not found')
    return this.atomic(`automation:${initial.automation_id}`, async () => {
      const currentRaw = await this.getRun(runId)
      if (!currentRaw || currentRaw.owner_id !== ownerId) throw new Error('Run not found')
      const current = run(currentRaw)
      if (current.state === 'cancelled') return current
      if (current.state !== 'running' || current.lease_id !== leaseId) throw new AutomationLeaseError('Automation lease is not owned by this worker')
      const now = Date.now()
      if (typeof current.lease_expires_at !== 'number' || current.lease_expires_at <= now) {
        await this.interruptExpiredRun(runId, 'Automation lease expired before completion')
        throw new AutomationLeaseError()
      }
      if (error === undefined) {
        const updated = await collection(this.client, 'automation_runs').update(runId, { state: 'succeeded', result: redactSensitive(resultValue), finished_at: now, lease_id: null, lease_expires_at: null })
        const storedDefinition = await this.getOwned(ownerId, automationRecord.id)
        const definition = storedDefinition ?? automationRecord
        if (storedDefinition) {
          const nextRun = definition.next_run_at
          await collection(this.client, 'automations').update(definition.id, { ...(nextRun === undefined || nextRun <= now ? { next_run_at: definition.schedule.kind === 'recurring' ? nextCronRun(definition.schedule.cron!, definition.timezone, now) : null } : {}), last_run_at: now, updated_at: now })
        }
        await this.projectResult(ownerId, run(updated), definition, resultRequiresReview(resultValue) ? 'review_required' : 'succeeded')
        return run(updated)
      }
      const max = automationRecord.retry_policy?.max_attempts ?? 1
      const retry = current.attempt < max
      const backoff = (automationRecord.retry_policy?.backoff_ms ?? 1000) * (2 ** Math.max(0, current.attempt - 1))
      const retryAt = now + backoff
      const message = String(redactSensitive(String(error instanceof Error ? error.message : error))).slice(0, 500)
      const updated = await collection(this.client, 'automation_runs').update(runId, { state: retry ? 'retrying' : 'failed', error_message: message, ...(retry ? { result: { [RETRY_METADATA]: { next_attempt_at: retryAt, backoff_ms: backoff } }, finished_at: null } : { finished_at: now, result: null }), lease_id: null, lease_expires_at: null })
      if (!retry) {
        const definition = await this.getOwned(ownerId, automationRecord.id) ?? automationRecord
        await this.projectResult(ownerId, run(updated), definition, 'failed', message)
      }
      return run(updated)
    })
  }

  async getRunForMaintenance(runId: string): Promise<{ id: string; automation_id: string; state: RunState; lease_id?: string } | null> {
    const value = await this.getRun(runId)
    if (!value || !RUN_STATES.includes(value.state as RunState)) return null
    return { id: String(value.id), automation_id: String(value.automation_id), state: value.state as RunState, ...(typeof value.lease_id === 'string' ? { lease_id: value.lease_id } : {}) }
  }

  async markRunUnknown(initial: { id: string; automation_id: string; state: RunState; lease_id?: string }, message: string): Promise<boolean> {
    return this.atomic(`automation:${initial.automation_id}`, async () => {
      const current = await this.getRun(initial.id)
      if (!current || current.state !== initial.state || current.lease_id !== initial.lease_id) return false
      const updated = await collection(this.client, 'automation_runs').update(initial.id, { state: 'unknown', error_message: message, lease_id: null, lease_expires_at: null })
      const definition = await this.getOwned(String(updated.owner_id), String(updated.automation_id))
      if (definition) await this.projectResult(String(updated.owner_id), run(updated), definition, 'interrupted', message)
      activeExecutors.get(this.client as unknown as object)?.get(initial.id)?.abort()
      return true
    })
  }

  async markRunInterrupted(initial: { id: string; automation_id: string; state: RunState; lease_id?: string }, message: string): Promise<boolean> {
    return this.atomic(`automation:${initial.automation_id}`, async () => {
      const current = await this.getRun(initial.id)
      if (!current || current.state !== initial.state || current.lease_id !== initial.lease_id) return false
      await this.interruptExpiredRun(initial.id, message)
      return true
    })
  }
}

export type AutomationExecutor = (run: AutomationRun, automation: AutomationRecord, signal: AbortSignal) => Promise<unknown>
const activeExecutors = new WeakMap<object, Map<string, AbortController>>()

export async function executeAutomation(repository: AutomationRepository, ownerId: string, runId: string, execute: AutomationExecutor, leaseMs = 60000): Promise<AutomationRun> {
  const claim = await repository.claimRun(ownerId, runId, leaseMs)
  if (!claim.leaseId) return claim.run
  const controller = new AbortController()
  let executors = activeExecutors.get((repository as unknown as { client: PocketBase }).client as unknown as object)
  if (!executors) { executors = new Map(); activeExecutors.set((repository as unknown as { client: PocketBase }).client as unknown as object, executors) }
  executors.set(runId, controller)
  const renew = setInterval(() => { void repository.renewLease(ownerId, runId, claim.leaseId!, leaseMs).then((ok) => { if (!ok) controller.abort() }).catch(() => controller.abort()) }, Math.max(1000, Math.floor(leaseMs / 3)))
  try {
    let result: unknown
    try {
      result = await execute(claim.run, claim.automation, controller.signal)
      if (controller.signal.aborted) throw new Error('Automation cancelled')
    } catch (error) {
      return await repository.finishRun(ownerId, runId, claim.leaseId, claim.automation, undefined, error)
    }
    return await repository.finishRun(ownerId, runId, claim.leaseId, claim.automation, result)
  } finally {
    clearInterval(renew)
    executors.delete(runId)
  }
}

export type AutomationWorker = {
  execute: (ownerId: string, runId: string) => Promise<AutomationRun>
  executeDue: (now?: number) => Promise<AutomationRun[]>
}

export function createAutomationWorker(repository: AutomationRepository, executor: AutomationExecutor, leaseMs = 60000): AutomationWorker {
  const worker: AutomationWorker = {
    execute: (ownerId, runId) => executeAutomation(repository, ownerId, runId, executor, leaseMs),
    executeDue: async (now = Date.now()) => {
      const completed: AutomationRun[] = []
      let triggered = await repository.triggerDueAll(now)
      while (true) {
        const runnable = await repository.runnableRuns(Date.now())
        const runnableIds = new Set(runnable.map((candidate) => candidate.id))
        const runs = [...new Map([...triggered.filter((candidate) => candidate.state === 'retrying' || runnableIds.has(candidate.id)), ...runnable].map((candidate) => [candidate.id, candidate])).values()]
        triggered = []
        if (!runs.length) return completed
        for (const candidate of runs) {
          const result = await executeAutomation(repository, candidate.owner_id, candidate.id, executor, leaseMs)
          completed.push(result)
          if (['pending', 'leased', 'running'].includes(result.state)) return completed
        }
      }
    },
  }
  return worker
}

export async function markInterruptedRuns(client: PocketBase, options: AutomationRepositoryOptions = {}): Promise<void> {
  const repository = new AutomationRepository(client, options)
  const records = await collection(client, 'automation_runs').getFullList({ filter: 'state = "leased" || state = "running"' })
  await Promise.all(records.filter((record) => record.state === 'leased' || record.state === 'running').map(async (record) => {
    const initial = await repository.getRunForMaintenance(String(record.id))
    if (!initial) return
    await repository.markRunUnknown(initial, 'Worker restarted before completion')
  }))
}

export async function expireAutomationLeases(client: PocketBase, now = Date.now(), options: AutomationRepositoryOptions = {}): Promise<number> {
  const repository = new AutomationRepository(client, options)
  const records = await collection(client, 'automation_runs').getFullList({ filter: 'state = "leased" || state = "running"' })
  const expired = await Promise.all(records.filter((record) => (record.state === 'leased' || record.state === 'running') && (typeof record.lease_expires_at !== 'number' || record.lease_expires_at <= now)).map(async (record) => {
    const initial = await repository.getRunForMaintenance(String(record.id))
    return initial ? repository.markRunInterrupted(initial, 'Automation lease expired') : false
  }))
  return expired.filter(Boolean).length
}
