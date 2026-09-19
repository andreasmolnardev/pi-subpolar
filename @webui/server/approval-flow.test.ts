import type PocketBase from 'pocketbase'
import { describe, expect, it, vi } from 'vitest'
import { ApprovalFlowService } from './approval-flow'

type FakeRecord = Record<string, unknown> & { id: string }

type ListOptions = { filter?: string; sort?: string }

class FakeCollection {
  readonly records: FakeRecord[] = []
  private nextId = 1

  async create(data: Record<string, unknown>): Promise<FakeRecord> {
    const record = { ...data, id: `approval-${this.nextId++}` }
    this.records.push(record)
    return record
  }

  async getOne(id: string): Promise<FakeRecord> {
    const record = this.records.find((candidate) => candidate.id === id)
    if (!record) throw Object.assign(new Error('Record not found'), { status: 404 })
    return { ...record }
  }

  async getFullList(options: ListOptions): Promise<FakeRecord[]> {
    const userId = /user_id = "([^"]*)"/.exec(options.filter ?? '')?.[1]
    const sessionId = /session_id = "([^"]*)"/.exec(options.filter ?? '')?.[1]
    const pendingOnly = options.filter?.includes('status = "pending"') ?? false
    return this.records
      .filter((record) => userId === undefined || record.user_id === userId)
      .filter((record) => !pendingOnly || record.status === 'pending')
      .filter((record) => sessionId === undefined || record.session_id === sessionId)
      .sort((left, right) => Number(right.created_at) - Number(left.created_at))
      .map((record) => ({ ...record }))
  }

  async update(id: string, data: Record<string, unknown>): Promise<FakeRecord> {
    const record = this.records.find((candidate) => candidate.id === id)
    if (!record) throw Object.assign(new Error('Record not found'), { status: 404 })
    Object.assign(record, data)
    return { ...record }
  }
}

class FakeContinuationCollection {
  readonly records: FakeRecord[] = []
  failUpdates = false

  async create(data: Record<string, unknown>): Promise<FakeRecord> {
    if (this.records.some((record) => record.approval_id === data.approval_id)) {
      throw Object.assign(new Error('unique constraint'), { status: 400 })
    }
    const record = { ...data, id: `continuation-${this.records.length + 1}` }
    this.records.push(record)
    return record
  }

  async getFirstListItem(filter: string): Promise<FakeRecord> {
    const approvalId = /approval_id = "([^\"]*)"/.exec(filter)?.[1]
    const record = this.records.find((candidate) => candidate.approval_id === approvalId)
    if (!record) throw Object.assign(new Error('Record not found'), { status: 404 })
    return { ...record }
  }

  async update(id: string, data: Record<string, unknown>): Promise<FakeRecord> {
    if (this.failUpdates) throw new Error('claim update unavailable')
    const record = this.records.find((candidate) => candidate.id === id)
    if (!record) throw Object.assign(new Error('Record not found'), { status: 404 })
    Object.assign(record, data)
    return { ...record }
  }
}

class FakeResolutionCollection extends FakeContinuationCollection {}

class FakePocketBase {
  readonly approvals: FakeCollection
  readonly continuations: FakeContinuationCollection
  readonly resolutions: FakeResolutionCollection

  constructor(store?: { approvals: FakeCollection; continuations: FakeContinuationCollection; resolutions: FakeResolutionCollection }) {
    this.approvals = store?.approvals ?? new FakeCollection()
    this.continuations = store?.continuations ?? new FakeContinuationCollection()
    this.resolutions = store?.resolutions ?? new FakeResolutionCollection()
  }

  collection(name: string): FakeCollection {
    if (name === 'tool_approvals') return this.approvals
    if (name === 'tool_approval_continuations') return this.continuations as unknown as FakeCollection
    if (name === 'tool_approval_resolutions') return this.resolutions as unknown as FakeCollection
    throw new Error(`Unexpected collection: ${name}`)
  }
}

const owner = { userId: 'user-1', agentId: 'agent-1', sessionId: 'session-1' } as const

function service(now: () => number, expirationMs = 100, claimLeaseMs = 30_000): { flow: ApprovalFlowService; client: FakePocketBase } {
  const client = new FakePocketBase()
  return {
    client,
    flow: new ApprovalFlowService(client as unknown as PocketBase, { now, expirationMs, claimLeaseMs }),
  }
}

describe('ApprovalFlowService', () => {
  it('creates durable pending state and resumes without polling', async () => {
    let currentTime = 1_000
    const { flow } = service(() => currentTime)
    const created = await flow.create({
      ...owner,
      toolId: 'write',
      input: { path: 'README.md', content: 'updated' },
      reason: 'write requires approval',
    })

    expect(created).toMatchObject({ ok: true, state: 'pending', approvalId: created.approval.id })
    expect(created.approval.expires_at).toBe(1_100)
    expect((await flow.pending(owner)).approvals).toHaveLength(1)

    const resume = vi.fn((approval) => approval.input)
    const stillPending = await flow.continue(owner, created.approvalId, resume)
    expect(stillPending).toMatchObject({ ok: true, state: 'pending' })
    expect(resume).not.toHaveBeenCalled()

    const resolved = await flow.resolve(owner, created.approvalId, 'approve')
    expect(resolved).toMatchObject({ ok: true, state: 'approved' })
    const continued = await flow.continue(owner, created.approvalId, resume)
    expect(continued).toMatchObject({ ok: true, state: 'continued', result: { path: 'README.md', content: 'updated' } })
    expect(resume).toHaveBeenCalledTimes(1)

    currentTime = 1_050
    const repeated = await flow.resolve(owner, created.approvalId, 'reject')
    expect(repeated).toMatchObject({ ok: true, state: 'approved' })
  })

  it('redacts persisted input and permits only one concurrent continuation', async () => {
    const { flow, client } = service(() => 1_000)
    const created = await flow.create({ ...owner, toolId: 'bash', input: { command: 'echo ok', apiKey: 'secret' }, reason: 'token=secret' })
    expect(client.approvals.records[0]?.input).toEqual({ command: 'echo ok', apiKey: '[REDACTED]' })
    await flow.resolve(owner, created.approvalId, 'approve')
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const resume = vi.fn(async () => { await gate; return 'executed' })
    const first = flow.continue(owner, created.approvalId, resume)
    const second = await flow.continue(owner, created.approvalId, resume)
    expect(second).toMatchObject({ ok: false, error: { code: 'APPROVAL_ALREADY_CONTINUED' } })
    release()
    await expect(first).resolves.toMatchObject({ ok: true, state: 'continued', result: 'executed' })
    expect(resume).toHaveBeenCalledTimes(1)
  })

  it('clears the local continuation flag after a failed resume without permitting replay', async () => {
    const { flow } = service(() => 1_000)
    const created = await flow.create({ ...owner, toolId: 'bash', input: { command: 'echo ok' }, reason: 'command requires approval' })
    await flow.resolve(owner, created.approvalId, 'approve')
    const resume = vi.fn().mockRejectedValue(new Error('execution failed'))
    await expect(flow.continue(owner, created.approvalId, resume)).rejects.toThrow('execution failed')
    const repeated = await flow.continue(owner, created.approvalId, resume)
    expect(repeated).toMatchObject({ ok: false, error: { code: 'APPROVAL_ALREADY_CONTINUED' } })
    expect(resume).toHaveBeenCalledTimes(1)
  })

  it('does not disclose or mutate another owner’s approval', async () => {
    const { flow, client } = service(() => 1_000)
    const created = await flow.create({
      ...owner,
      toolId: 'bash',
      input: { command: 'echo safe' },
      reason: 'command requires approval',
    })

    const result = await flow.resolve({ userId: 'different-user' }, created.approvalId, true)
    expect(result).toMatchObject({ ok: false, state: 'forbidden', error: { code: 'APPROVAL_FORBIDDEN' } })
    expect(client.approvals.records[0]?.status).toBe('pending')

    const continuation = await flow.continue({ userId: 'different-user' }, created.approvalId)
    expect(continuation).toMatchObject({ ok: false, state: 'forbidden' })
  })

  it('rejects an approval resolved from another session', async () => {
    const { flow, client } = service(() => 1_000)
    const created = await flow.create({ ...owner, toolId: 'bash', input: { command: 'echo safe' }, reason: 'command requires approval' })

    const result = await flow.resolve({ userId: owner.userId, sessionId: 'different-session' }, created.approvalId, true)
    expect(result).toMatchObject({ ok: false, state: 'forbidden', error: { code: 'APPROVAL_FORBIDDEN' } })
    expect(client.approvals.records[0]?.status).toBe('pending')
  })

  it('rejects invalid decisions without changing pending state', async () => {
    const { flow, client } = service(() => 1_000)
    const created = await flow.create({ ...owner, toolId: 'bash', input: { command: 'echo ok' }, reason: 'command requires approval' })
    const result = await flow.resolve(owner, created.approvalId, 'yes' as never)
    expect(result).toMatchObject({ ok: false, state: 'invalid', error: { code: 'APPROVAL_INVALID_DECISION' } })
    expect(client.approvals.records[0]?.status).toBe('pending')
  })

  it('uses one durable resolution claim when two processes race', async () => {
    const firstClient = new FakePocketBase()
    const secondClient = new FakePocketBase(firstClient)
    const first = new ApprovalFlowService(firstClient as unknown as PocketBase, { now: () => 1_000 })
    const second = new ApprovalFlowService(secondClient as unknown as PocketBase, { now: () => 1_000 })
    const created = await first.create({ ...owner, toolId: 'bash', input: { command: 'echo ok' }, reason: 'command requires approval' })

    const results = await Promise.all([
      first.resolve(owner, created.approvalId, 'approve'),
      second.resolve(owner, created.approvalId, 'reject'),
    ])

    expect(firstClient.resolutions.records).toHaveLength(1)
    expect(firstClient.approvals.records[0]?.status).toBe(firstClient.resolutions.records[0]?.state)
    expect(results.some((result) => result.ok && (result.state === 'approved' || result.state === 'rejected'))).toBe(true)
  })

  it('expires pending approvals and never resumes them', async () => {
    let currentTime = 1_000
    const { flow, client } = service(() => currentTime, 50)
    const created = await flow.create({
      ...owner,
      toolId: 'edit',
      input: { path: 'file.ts', edits: [] },
      reason: 'edit requires approval',
    })

    currentTime = 1_050
    const pending = await flow.pending(owner)
    expect(pending.approvals).toEqual([])
    expect(client.approvals.records[0]?.status).toBe('expired')

    const resume = vi.fn()
    const continued = await flow.continue(owner, created.approvalId, resume)
    expect(continued).toMatchObject({ ok: true, state: 'expired' })
    expect(resume).not.toHaveBeenCalled()
  })

  it('marks a stale continuation claim interrupted and never replays it', async () => {
    let currentTime = 1_000
    const { flow, client } = service(() => currentTime, 10_000, 50)
    const created = await flow.create({ ...owner, toolId: 'edit', input: { path: 'file.ts', edits: [] }, reason: 'edit requires approval' })
    await flow.resolve(owner, created.approvalId, 'approve')
    await client.continuations.create({ approval_id: created.approvalId, user_id: owner.userId, claimed_at: 900, claim_expires_at: 950, claim_state: 'active' })

    const resume = vi.fn(() => 'must not run')
    const result = await flow.continue(owner, created.approvalId, resume)

    expect(result).toMatchObject({ ok: false, state: 'interrupted', error: { code: 'APPROVAL_INTERRUPTED' } })
    expect(client.continuations.records[0]?.claim_state).toBe('interrupted')
    expect(resume).not.toHaveBeenCalled()
    const restarted = new ApprovalFlowService(new FakePocketBase(client) as unknown as PocketBase, { now: () => currentTime, expirationMs: 10_000, claimLeaseMs: 50 })
    expect(await restarted.continue(owner, created.approvalId, resume)).toMatchObject({ error: { code: 'APPROVAL_INTERRUPTED' } })
  })

  it('marks a stale resolution claim interrupted instead of replaying its decision', async () => {
    let currentTime = 1_000
    const { flow, client } = service(() => currentTime, 10_000, 50)
    const created = await flow.create({ ...owner, toolId: 'write', input: { path: 'file.ts', content: 'x' }, reason: 'write requires approval' })
    await client.resolutions.create({ approval_id: created.approvalId, user_id: owner.userId, state: 'approved', claimed_at: 900, claim_expires_at: 950, claim_state: 'active' })

    const result = await flow.resolve(owner, created.approvalId, 'reject')

    expect(result).toMatchObject({ ok: false, state: 'interrupted', error: { code: 'APPROVAL_INTERRUPTED' } })
    expect(client.resolutions.records[0]?.claim_state).toBe('interrupted')
    expect(client.approvals.records[0]?.status).toBe('expired')
    expect((await flow.pending(owner)).approvals).toEqual([])
  })

  it('returns unknown and fails closed when stale-claim recovery is ambiguous', async () => {
    let currentTime = 1_000
    const { flow, client } = service(() => currentTime, 10_000, 50)
    const created = await flow.create({ ...owner, toolId: 'bash', input: { command: 'echo safe' }, reason: 'command requires approval' })
    await flow.resolve(owner, created.approvalId, 'approve')
    await client.continuations.create({ approval_id: created.approvalId, user_id: owner.userId, claimed_at: 900, claim_expires_at: 950, claim_state: 'active' })
    client.continuations.failUpdates = true

    const resume = vi.fn(() => 'must not run')
    const result = await flow.continue(owner, created.approvalId, resume)

    expect(result).toMatchObject({ ok: false, state: 'interrupted', error: { code: 'APPROVAL_UNKNOWN' } })
    expect(resume).not.toHaveBeenCalled()
  })
})
