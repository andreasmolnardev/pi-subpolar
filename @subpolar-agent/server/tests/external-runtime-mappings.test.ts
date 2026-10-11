import { describe, expect, it } from 'bun:test'
import { ExternalRuntimeMappingScopeError, PocketBaseExternalRuntimeMappingStore } from '../persistence/external-runtime-mappings.ts'

type Row = Record<string, unknown>

function fixture() {
  const rows: Row[] = []
  let sequence = 0
  const filters: string[] = []
  const store = new PocketBaseExternalRuntimeMappingStore({
    collection: () => ({
      getFullList: async ({ filter } = {}) => {
        if (filter) filters.push(filter)
        return rows
      },
      create: async (data) => {
        if (rows.some((row) => row.owner_id === data.owner_id && row.session_id === data.session_id)) throw new Error('unique index')
        const row = { id: `row-${++sequence}`, ...data }
        rows.push(row)
        return row
      },
      update: async (id, data) => {
        const index = rows.findIndex((row) => row.id === id)
        if (index < 0) throw new Error('missing')
        rows[index] = { ...rows[index], ...data }
        return rows[index]!
      },
    }),
  })
  return { store, rows, filters }
}

const mapping = {
  ownerId: 'alice', sessionId: 'canonical-session', provider: 'opencode-v2' as const,
  installationId: 'docker-opencode-2.0.26', externalSessionId: 'upstream-session-9', workspace: '/workspaces/project-a',
}

describe('PocketBase external ACP session mappings', () => {
  it('persists and resumes only through the owner and canonical Subpolar session key', async () => {
    const f = fixture()
    await f.store.save(mapping)
    await f.store.save({ ...mapping, externalSessionId: 'upstream-session-10' })

    expect(await f.store.get('alice', 'canonical-session')).toEqual({ ...mapping, externalSessionId: 'upstream-session-10' })
    expect(await f.store.get('bob', 'canonical-session')).toBeUndefined()
    expect(f.rows).toHaveLength(1)
    expect(f.rows[0]).toMatchObject({ owner_id: 'alice', session_id: 'canonical-session', external_session_id: 'upstream-session-10' })
  })

  it('escapes filter metacharacters and rejects malformed, foreign, or unsupported mappings', async () => {
    const f = fixture()
    await f.store.get('alice" || owner_id != "', 'canonical-session')
    expect(f.filters[0]).toContain('alice\\" || owner_id != \\\"')
    await expect(f.store.save({ ...mapping, provider: 'other' as never })).rejects.toBeInstanceOf(ExternalRuntimeMappingScopeError)
    await expect(f.store.save({ ...mapping, workspace: 'relative/workspace' })).rejects.toBeInstanceOf(ExternalRuntimeMappingScopeError)
    f.rows.push({ id: 'bob-session', owner_id: 'bob', session_id: 'canonical-session', provider: 'opencode-v2', installation_id: 'i', external_session_id: 'e', workspace: '/workspaces/bob' })
    expect(await f.store.get('alice', 'canonical-session')).toBeUndefined()
    expect(await f.store.get('bob', 'canonical-session')).toMatchObject({ ownerId: 'bob', externalSessionId: 'e' })
  })
})
