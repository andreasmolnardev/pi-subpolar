import { describe, expect, it } from 'vitest'
import { configuredWorkspaceRoot } from './project-filesystem.ts'
import {
  createProjectSessionRepository,
  normalizeSessionTags,
  PROJECT_SESSION_SCHEMA,
} from './project-store.ts'

type Row = Record<string, unknown> & { id: string }

function pocketBaseMock(initial: Row[] = []) {
  const rows = new Map(initial.map((row) => [row.id, row]))
  let nextId = initial.length
  const matches = (row: Row, filter: string) => [...filter.matchAll(/(\w+) = "((?:\\.|[^"])*)"/g)].every((match) => row[match[1]] === match[2].replaceAll('\\"', '"').replaceAll('\\\\', '\\'))
  const collection = (name: string) => ({
    getFirstListItem: async (filter: string) => {
      const row = [...rows.values()].find((candidate) => candidate.collection === name && matches(candidate, filter))
      if (!row) throw { status: 404 }
      return row
    },
    getFullList: async (options?: { filter?: string }) => [...rows.values()].filter((row) => row.collection === name && (!options?.filter || matches(row, options.filter))),
    create: async (data: Record<string, unknown>) => {
      const row = { id: `record-${++nextId}`, collection: name, ...data }
      rows.set(row.id, row)
      return row
    },
    update: async (id: string, data: Record<string, unknown>) => {
      const row = rows.get(id)
      if (!row) throw { status: 404 }
      Object.assign(row, data)
      return row
    },
    delete: async (id: string) => rows.delete(id),
  })
  return { collection }
}

describe('session tags', () => {
  it('normalizes display spelling and rejects invalid bounds', () => {
    expect(normalizeSessionTags([' Work ', 'work', 'Build_1', 'build_1'])).toEqual(['Work', 'Build_1'])
    expect(() => normalizeSessionTags(Array.from({ length: 13 }, (_, index) => `tag-${index}`))).toThrow()
    expect(() => normalizeSessionTags(['bad/character'])).toThrow()
    expect(() => normalizeSessionTags(['x'.repeat(33)])).toThrow()
  })

  it('persists tags, scopes updates by owner, and leaves projects independent', async () => {
    const client = pocketBaseMock()
    const repository = createProjectSessionRepository(client as never)
    const project = await repository.createProject('owner-a', { name: 'Build', path: `${configuredWorkspaceRoot()}/build` })
    const created = await repository.createSession('owner-a', {
      id: 'session-a', projectId: project.id, title: 'Session', tags: ['Work', 'work', 'Review'],
    })
    expect(created.tags).toEqual(['Work', 'Review'])
    expect((await repository.getSession('owner-a', 'session-a'))?.tags).toEqual(['Work', 'Review'])
    expect(await repository.getSession('owner-b', 'session-a')).toBeNull()
    expect(await repository.updateSession('owner-b', 'session-a', { tags: ['Other'] })).toBeNull()
    expect((await repository.getSession('owner-a', 'session-a'))?.tags).toEqual(['Work', 'Review'])
    expect((await repository.getProject('owner-a', project.id))?.name).toBe('Build')
  })

  it('reads legacy session records without tags as empty', async () => {
    const client = pocketBaseMock([{
      id: 'legacy-record', collection: 'sessions', user_id: 'owner-a', session_id: 'legacy',
      project_name: 'General Chat', title: 'Legacy', created_at: 1, updated_at: 2,
    }])
    expect((await createProjectSessionRepository(client as never).getSession('owner-a', 'legacy'))?.tags).toEqual([])
  })

  it('declares the durable tags field in the session schema', () => {
    expect(PROJECT_SESSION_SCHEMA.sessions.fields).toContainEqual({ name: 'tags', type: 'json' })
  })
})
