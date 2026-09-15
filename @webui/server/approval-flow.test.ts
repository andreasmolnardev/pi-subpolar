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

class FakePocketBase {
  readonly approvals = new FakeCollection()

  collection(name: string): FakeCollection {
    if (name !== 'tool_approvals') throw new Error(`Unexpected collection: ${name}`)
    return this.approvals
  }
}

const owner = { userId: 'user-1', agentId: 'agent-1', sessionId: 'session-1' } as const

function service(now: () => number, expirationMs = 100): { flow: ApprovalFlowService; client: FakePocketBase } {
  const client = new FakePocketBase()
  return {
    client,
    flow: new ApprovalFlowService(client as unknown as PocketBase, { now, expirationMs }),
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
})
