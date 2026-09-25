import { describe, expect, it } from 'vitest'
import { ensureApplicationCollections } from './pocketbase.ts'

function schemaClient(existingInboxIndexes: string[]) {
  const records = new Map<string, Record<string, unknown>>()
  let sequence = 0
  records.set('inbox_items', { id: 'inbox-items', fields: [], indexes: existingInboxIndexes })
  records.set('notification_deliveries', { id: 'notification-deliveries', fields: [], indexes: [] })
  return {
    collections: {
      getOne: async (name: string) => {
        const record = records.get(name)
        if (!record) throw new Error('not found')
        return record
      },
      create: async (input: Record<string, unknown>) => {
        const record = { id: `${input.name}-${++sequence}`, ...input }
        records.set(String(input.name), record)
        return record
      },
      update: async (id: string, input: Record<string, unknown>) => {
        const record = [...records.values()].find((value) => value.id === id)
        if (!record) throw new Error('not found')
        Object.assign(record, input)
        return record
      },
     },
     inbox: () => records.get('inbox_items')!,
     deliveries: () => records.get('notification_deliveries')!,
     skills: () => records.get('skills')!,
     skillVersions: () => records.get('skill_versions')!,
   }
}

describe('PocketBase application schema', () => {
  it('reconciles the inbox dedupe index and adds underlying state', async () => {
    const client = schemaClient(['CREATE UNIQUE INDEX idx_inbox_dedupe ON inbox_items (owner_id, kind, reference_id)'])
    await ensureApplicationCollections(client as never)
    const inbox = client.inbox()
     expect(inbox.indexes).toEqual(expect.arrayContaining([
       "CREATE UNIQUE INDEX idx_inbox_dedupe ON inbox_items (owner_id, COALESCE(project_id, ''), kind, reference_id)",
     ]))
     expect(inbox.indexes).not.toContain('CREATE UNIQUE INDEX idx_inbox_dedupe ON inbox_items (owner_id, kind, reference_id)')
     expect(inbox.fields).toEqual(expect.arrayContaining([
       expect.objectContaining({ name: 'identity_key', type: 'text' }),
       expect.objectContaining({ name: 'underlying_state', type: 'text' }),
     ]))
  })

  it('adds updated_at when reconciling existing notification deliveries', async () => {
    const client = schemaClient([])
    await ensureApplicationCollections(client as never)
    expect(client.deliveries().fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'updated_at', type: 'number', required: true }),
    ]))
  })

  it('creates versioned skill collections with owner and identity indexes', async () => {
    const client = schemaClient([])
    await ensureApplicationCollections(client as never)
    expect(client.skills().fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'ownerId', type: 'text', required: true }),
      expect.objectContaining({ name: 'identityKey', type: 'text', required: true }),
      expect.objectContaining({ name: 'version', type: 'number', required: true }),
    ]))
    expect(client.skills().indexes).toContain('CREATE UNIQUE INDEX idx_skills_owner_identity ON skills (ownerId, identityKey)')
    expect(client.skillVersions().indexes).toContain('CREATE UNIQUE INDEX idx_skill_versions_owner_identity_version ON skill_versions (ownerId, skillHeadId, version)')
  })
})
