import PocketBase, { type RecordModel } from 'pocketbase'
import {
  createPocketBaseAdapter,
  type PocketBaseCollectionPort,
  type PocketBaseStoredRecord,
} from '../../../packages/subpolar-persistance-pocketbase/src/index.ts'
import type {
  CreateSkillInput,
  GetSkillInput,
  SkillRepository,
  UpdateSkillInput,
} from '../../../packages/subpolar-contracts/src/index.ts'
import { SkillConflictError, SkillNotFoundError } from '../../../packages/subpolar-contracts/src/index.ts'

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
      const skill = await repository.get(ownerId, id, { ...input, version: undefined })
      const matches = records.filter((record) => record.ownerId === ownerId && record.skillId === skill.id &&
        record.scope === skill.scope && (record.agentId ?? undefined) === skill.agentId && (record.projectId ?? undefined) === skill.projectId)
      if (matches.length > 1) throw new SkillConflictError('skill selector is ambiguous')
      const head = matches[0]
      if (!head) throw new SkillNotFoundError(`skill ${id} was not found for owner ${ownerId}`)
      const historical = await versions.getFullList()
      for (const version of historical) {
        if (version.ownerId === ownerId && version.skillHeadId === head.id && version.skillId === skill.id &&
          version.scope === skill.scope && (version.agentId ?? undefined) === skill.agentId && (version.projectId ?? undefined) === skill.projectId) await versions.delete(version.id)
      }
      await heads.delete(head.id)
    },
  }
}
