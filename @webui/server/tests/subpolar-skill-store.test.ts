import { describe, expect, it } from 'bun:test'
import type PocketBase from 'pocketbase'
import { createOwnerBoundSkillStore } from '../persistence/subpolar-skill-store.ts'

function fakeClient(): PocketBase {
  const records = new Map<string, Array<Record<string, unknown>>>([
    ['skills', []],
    ['skill_versions', []],
  ])
  let sequence = 0
  const client = {
    collection(name: string) {
      const items = records.get(name)!
      return {
        async getFullList() { return items.map((item) => ({ ...item })) },
        async getOne(id: string) { return items.find((item) => item.id === id) },
        async create(data: Record<string, unknown>) {
          const item = { ...data, id: `${name}-${++sequence}` }
          items.push(item)
          return item
        },
        async update(id: string, data: Record<string, unknown>) {
          const index = items.findIndex((item) => item.id === id)
          if (index < 0) throw new Error('not found')
          items[index] = { ...items[index], ...data }
          return items[index]
        },
        async delete(id: string) {
          const index = items.findIndex((item) => item.id === id)
          if (index >= 0) items.splice(index, 1)
        },
      }
    },
  }
  return client as unknown as PocketBase
}

describe('owner-bound durable skill store', () => {
  it('persists versions, isolates owners, and deletes the head and history', async () => {
    const client = fakeClient()
    const owner = createOwnerBoundSkillStore(client, 'owner-a')
    const other = createOwnerBoundSkillStore(client, 'owner-b')
    const created = await owner.create('owner-a', { id: 'docs', name: 'docs', scope: 'global', mode: 'discoverable', body: 'v1' })

    expect(created).toMatchObject({ ownerId: 'owner-a', version: 1 })
    await expect(other.get('owner-b', 'docs')).rejects.toMatchObject({ code: 'SKILL_NOT_FOUND' })
    await expect(owner.update('owner-a', { id: 'docs', version: 2, body: 'stale' })).resolves.toMatchObject({ version: 2 })
    await expect(owner.update('owner-a', { id: 'docs', version: 2, body: 'conflict' })).rejects.toMatchObject({ code: 'SKILL_CONFLICT' })
    await owner.delete('docs')
    await expect(owner.get('owner-a', 'docs')).rejects.toMatchObject({ code: 'SKILL_NOT_FOUND' })
  })

  it('does not permit changing the bound owner', async () => {
    const store = createOwnerBoundSkillStore(fakeClient(), 'owner-a')
    await expect(store.list('owner-b')).rejects.toThrow('owner scope')
  })
})
