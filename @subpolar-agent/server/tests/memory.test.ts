import { describe, expect, test } from 'bun:test'
import { PocketBaseMemoryService } from '../persistence/memory.ts'
import { agentTemplateDefaults, memoryPolicyAllows } from '../application/tools/tools.ts'

class Collection {
  records: Record<string, any>[] = []
  async getFullList() { return this.records }
  async getFirstListItem(filter: string) { return this.records.find((item) => filter.includes(`idempotency_key = "${item.idempotency_key}"`)) ?? null }
  async getOne(id: string) { return this.records.find((item) => item.id === id) ?? null }
  async create(data: Record<string, unknown>) {
    if (data.idempotency_key && this.records.some((item) => item.owner_id === data.owner_id && item.idempotency_key === data.idempotency_key)) throw new Error('unique constraint')
    const item = { id: `m-${this.records.length + 1}`, ...data }; this.records.push(item); return item
  }
  async update(id: string, data: Record<string, unknown>) { const item = this.records.find((candidate) => candidate.id === id)!; Object.assign(item, data); return item }
}

function makeService() {
  const collection = new Collection()
  return { service: new PocketBaseMemoryService({ collection: () => collection, collections: { getOne: async () => ({ indexes: ['CREATE UNIQUE INDEX idx_memory_owner_idempotency ON memory_records (owner_id, idempotency_key)'] }) } } as never), collection }
}
const user = { ownerId: 'user-a', agentId: 'agent-a', projectId: 'project-a' }

describe('bounded memory capability', () => {
  test('is disabled by default and query-only profiles cannot mutate', () => {
    expect(memoryPolicyAllows({ policies: { memory: false }, template: 'general' }, 'memory/query')).toBe(false)
    expect(memoryPolicyAllows({ policies: { memory: true }, template: 'plan' }, 'memory/write')).toBe(false)
    expect(memoryPolicyAllows({ policies: { memory: true }, template: 'plan' }, 'memory/query')).toBe(true)
    for (const template of ['plan', 'reviewer'] as const) {
      const defaults = agentTemplateDefaults(template)
      expect(defaults.policies.memory).toBe(false)
      expect(defaults.tool_context_modes['memory/query']).toBe('discoverable')
      expect(defaults.tool_context_modes['memory/write']).toBeUndefined()
    }
  })

  test('isolates user, agent, and project scopes and bounds queries', async () => {
    const { service } = makeService()
    await service.write(user, { scope: 'user', content: 'shared' })
    await service.write(user, { scope: 'agent', content: 'agent-only' })
    await service.write(user, { scope: 'project', content: 'project-only' })
    expect((await service.query(user, { limit: 2 }))).toHaveLength(2)
    expect((await service.query(user, { scope: 'agent' }))[0]?.content).toBe('agent-only')
    expect((await service.query({ ...user, agentId: 'agent-b' }, {})).map((item) => item.content)).toEqual(['shared', 'project-only'])
    await expect(service.query({ ...user, ownerId: 'user-b' }, {})).resolves.toEqual([])
  })

  test('supports idempotency, versioning, and tombstones', async () => {
    const { service } = makeService()
    const first = await service.write(user, { scope: 'user', content: 'secret token', idempotencyKey: 'same' })
    expect(await service.write(user, { scope: 'user', content: 'different', idempotencyKey: 'same' })).toEqual(first)
    const updated = await service.update(user, first.id, { version: 1, content: 'new' })
    expect(updated.version).toBe(2)
    await expect(service.update(user, first.id, { version: 1, content: 'stale' })).rejects.toThrow('version conflict')
    await service.tombstone(user, first.id, 2)
    expect(await service.query(user, {})).toEqual([])
  })

  test('concurrent idempotent writes return one record', async () => {
    const { service, collection } = makeService()
    const results = await Promise.all([
      service.write(user, { scope: 'user', content: 'first', idempotencyKey: 'concurrent' }),
      service.write(user, { scope: 'user', content: 'second', idempotencyKey: 'concurrent' }),
    ])
    expect(collection.records).toHaveLength(1)
    expect(results[0]).toEqual(results[1])
  })

  test('ignores caller ownership and scope fields', async () => {
    const { service, collection } = makeService()
    const forged = { owner_id: 'attacker', agent_id: 'attacker-agent', version: 99 } as Record<string, unknown>
    await service.write(user, {
      scope: 'user',
      content: 'trusted',
      idempotencyKey: 'forgery',
      ...forged,
    } as never)
    expect(collection.records[0]).toMatchObject({ owner_id: user.ownerId, scope: 'user', version: 1 })
    expect(collection.records[0]?.owner_id).not.toBe('attacker')
  })
})
