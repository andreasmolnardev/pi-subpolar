import type PocketBase from 'pocketbase'
import { describe, expect, it } from 'vitest'
import {
  PocketBaseProviderLoginFlowStorage,
  PROVIDER_LOGIN_FLOWS_COLLECTION,
} from './provider-login-flow-store'
import { ProviderLoginFlowController, type StoredProviderLoginFlow } from '../application/provider-login-flow'

type FakeRecord = Record<string, unknown> & { id: string }

function notFound(): Error & { status: number } {
  return Object.assign(new Error('not found'), { status: 404 })
}

class FakeCollection {
  readonly records: FakeRecord[] = []
  private nextId = 1

  async getFirstListItem(filter: string): Promise<FakeRecord> {
    const ownerId = /user_id = "((?:\\.|[^"])*)"/.exec(filter)?.[1]
    const flowId = /flow_id = "((?:\\.|[^"])*)"/.exec(filter)?.[1]
    const record = this.records.find((candidate) =>
      (ownerId === undefined || candidate.user_id === ownerId) &&
      (flowId === undefined || candidate.flow_id === flowId))
    if (!record) throw notFound()
    return { ...record }
  }

  async create(data: Record<string, unknown>): Promise<FakeRecord> {
    const record = { ...data, id: `${PROVIDER_LOGIN_FLOWS_COLLECTION}-${this.nextId++}` }
    this.records.push(record)
    return { ...record }
  }

  async update(id: string, data: Record<string, unknown>): Promise<FakeRecord> {
    const record = this.records.find((candidate) => candidate.id === id)
    if (!record) throw notFound()
    Object.assign(record, data)
    return { ...record }
  }

  async delete(id: string): Promise<boolean> {
    const index = this.records.findIndex((candidate) => candidate.id === id)
    if (index < 0) throw notFound()
    this.records.splice(index, 1)
    return true
  }
}

class FakePocketBase {
  readonly flows = new FakeCollection()

  collection(name: string): FakeCollection {
    if (name !== PROVIDER_LOGIN_FLOWS_COLLECTION) throw new Error(`Unexpected collection: ${name}`)
    return this.flows
  }
}

function pendingFlow(overrides: Partial<StoredProviderLoginFlow> = {}): StoredProviderLoginFlow {
  return {
    ownerId: 'user-1',
    flowId: 'flow-1',
    providerInstanceId: 'account-1',
    runtimeProviderId: 'anthropic',
    type: 'oauth',
    phase: 'pending',
    createdAt: 1_000,
    updatedAt: 1_000,
    expiresAt: 2_000,
    nextSequence: 1,
    events: [{
      sequence: 1,
      timestamp: 1_000,
      type: 'prompt',
      promptId: 'flow-1:1',
      prompt: { type: 'secret', message: 'Paste the code' },
    }],
    currentPrompt: {
      promptId: 'flow-1:1',
      prompt: { type: 'secret', message: 'Paste the code' },
    },
    ...overrides,
  }
}

describe('PocketBaseProviderLoginFlowStorage', () => {
  it('persists a projection without answers, credentials, or unknown fields', async () => {
    const client = new FakePocketBase()
    const storage = new PocketBaseProviderLoginFlowStorage(client as unknown as PocketBase, { now: () => 1_000 })
    const unsafe = {
      ...pendingFlow(),
      answer: 'prompt-answer-must-not-persist',
      credential: { access: 'oauth-secret' },
      events: [{
        sequence: 1,
        timestamp: 1_000,
        type: 'info',
        message: 'Continue in your browser',
        answer: 'event-answer-must-not-persist',
        token: 'event-token-must-not-persist',
      }],
      currentPrompt: {
        promptId: 'flow-1:1',
        prompt: { type: 'secret', message: 'Paste the code', answer: 'prompt-answer-must-not-persist' },
      },
    } as unknown as StoredProviderLoginFlow

    await storage.set(unsafe)

    const stored = client.flows.records[0]
    expect(stored).toBeDefined()
    expect(stored).not.toHaveProperty('answer')
    expect(stored).not.toHaveProperty('credential')
    expect(JSON.stringify(stored)).not.toContain('must-not-persist')
    expect(stored).toMatchObject({ user_id: 'user-1', flow_id: 'flow-1', phase: 'pending' })
    expect(await storage.getOwned('other-user', 'flow-1')).toBeUndefined()
    expect((await storage.getOwned('user-1', 'flow-1'))?.ownerId).toBe('user-1')
  })

  it('expires stale pending records on read and clears the current prompt', async () => {
    const client = new FakePocketBase()
    client.flows.records.push({
      id: 'stored-flow',
      user_id: 'user-1',
      flow_id: 'flow-1',
      provider_instance_id: 'account-1',
      runtime_provider_id: 'anthropic',
      type: 'oauth',
      phase: 'pending',
      created_at: 1_000,
      updated_at: 1_000,
      expires_at: 2_000,
      next_sequence: 1,
      events: [],
      current_prompt: { promptId: 'flow-1:1', prompt: { type: 'secret', message: 'Code' } },
      result: null,
      error: null,
    })
    const storage = new PocketBaseProviderLoginFlowStorage(client as unknown as PocketBase, { now: () => 2_001 })

    const expired = await storage.get('flow-1')

    expect(expired).toMatchObject({ phase: 'expired', updatedAt: 2_001 })
    expect(expired).not.toHaveProperty('currentPrompt')
    expect(client.flows.records[0]?.phase).toBe('expired')
    expect(client.flows.records[0]?.current_prompt).toBeNull()
  })

  it('keeps controller owner failures indistinguishable from missing flows', async () => {
    const client = new FakePocketBase()
    const storage = new PocketBaseProviderLoginFlowStorage(client as unknown as PocketBase)
    await storage.set(pendingFlow())
    const controller = new ProviderLoginFlowController({
      storage,
      runtimeFactory: () => ({ login: async () => ({ type: 'oauth', refresh: 'secret', access: 'secret', expires: 1 }) }),
    })

    await expect(controller.getStatus({ ownerId: 'other-user', flowId: 'flow-1' })).rejects.toMatchObject({ code: 'FLOW_NOT_FOUND' })
  })
})
