import PocketBase, { type RecordModel } from 'pocketbase'
import {
  createPocketBaseAdapter,
  type PocketBaseCollectionPort,
  type PocketBaseStoredRecord,
} from '../../packages/subpolar-adapter-pocketbase/src/index.ts'
import type {
  CreateSkillInput,
  GetSkillInput,
  SkillRepository,
  UpdateSkillInput,
} from '../../packages/subpolar-contracts/src/index.ts'
import { SkillNotFoundError } from '../../packages/subpolar-contracts/src/index.ts'

function collection(client: PocketBase, name: string): PocketBaseCollectionPort {
  const records = client.collection(name)
  return {
    list: () => records.getFullList() as Promise<readonly PocketBaseStoredRecord[]>,
    get: async (id) => {
      try { return await records.getOne(id) as unknown as PocketBaseStoredRecord } catch { return undefined }
    },
    create: (data) => records.create(data) as unknown as Promise<PocketBaseStoredRecord>,
    update: async (id, data) => {
      try { return await records.update(id, data) as unknown as PocketBaseStoredRecord } catch { return undefined }
    },
  }
}

export interface OwnerBoundSkillStore extends SkillRepository {
  delete(id: string, input?: GetSkillInput): Promise<void>
}

/** Durable skill access with the authenticated owner selected at composition time. */
export function createOwnerBoundSkillStore(client: PocketBase, ownerId: string): OwnerBoundSkillStore {
  const adapter = createPocketBaseAdapter({
    client: { collection: (name) => collection(client, name) },
    collections: { skills: 'skills', skillVersions: 'skill_versions' },
  })
  const heads = client.collection('skills')
  const versions = client.collection('skill_versions')
  const repository = adapter.skills
  const scoped = (owner: string): string => {
    if (owner !== ownerId) throw new Error('skill owner scope cannot be changed')
    return ownerId
  }

  return {
    list: async (owner, input) => repository.list(scoped(owner), input),
    get: async (owner, id, input) => repository.get(scoped(owner), id, input),
    create: async (owner, input: CreateSkillInput) => repository.create(scoped(owner), input),
    update: async (owner, input: UpdateSkillInput) => repository.update(scoped(owner), input),
    resolve: async (owner, input) => repository.resolve(scoped(owner), input),
    async delete(id, input = {}) {
      const records = await heads.getFullList() as unknown as Array<RecordModel & Record<string, unknown>>
      const head = records.find((record) => record.ownerId === ownerId && record.skillId === id &&
        (input.scope === undefined || record.scope === input.scope) &&
        (input.agentId === undefined || record.agentId === input.agentId) &&
        (input.projectId === undefined || record.projectId === input.projectId))
      if (!head) throw new SkillNotFoundError(`skill ${id} was not found for owner ${ownerId}`)
      const historical = await versions.getFullList({ filter: `ownerId = "${ownerId}" && skillHeadId = "${head.id}"` })
      for (const version of historical) await versions.delete(version.id)
      await heads.delete(head.id)
    },
  }
}
