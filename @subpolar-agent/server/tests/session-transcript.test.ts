import { describe, expect, it } from 'vitest'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { hydrateSessionManager } from '../application/runtime/pi-sdk-session.ts'
import { SessionTranscriptRepository } from '../persistence/session-transcript.ts'

type Stored = Record<string, unknown> & { id: string }

class FakeCollection {
  records: Stored[] = []
  async getFirstListItem(filter: string): Promise<Stored> {
    const ownerId = /owner_id = "([^"]*)"/.exec(filter)?.[1]
    const sessionId = /session_id = "([^"]*)"/.exec(filter)?.[1]
    const found = this.records.find((record) => record.owner_id === ownerId && record.session_id === sessionId)
    if (!found) throw Object.assign(new Error('not found'), { status: 404 })
    return { ...found }
  }
  async getFullList(): Promise<Stored[]> { return this.records.map((record) => ({ ...record })) }
  async create(data: Record<string, unknown>): Promise<Stored> {
    const record = { ...data, id: `transcript-${this.records.length + 1}` } as Stored
    this.records.push(record)
    return { ...record }
  }
  async update(id: string, data: Record<string, unknown>): Promise<Stored> {
    const record = this.records.find((candidate) => candidate.id === id)
    if (!record) throw new Error('not found')
    Object.assign(record, data)
    return { ...record }
  }
}

function client(collection: FakeCollection) {
  return { collection: () => collection } as never
}

describe('PocketBase-backed transient transcripts', () => {
  it('round-trips transcript data and hydrates SDK context without persistence', async () => {
    const collection = new FakeCollection()
    const repository = new SessionTranscriptRepository(client(collection))
    const entries = [
      {
        type: 'message', id: 'user-entry', parentId: null, timestamp: new Date(1).toISOString(),
        message: { role: 'user', content: [{ type: 'text', text: 'Continue the migration' }], timestamp: 1 },
      },
      {
        type: 'message', id: 'assistant-entry', parentId: 'user-entry', timestamp: new Date(2).toISOString(),
        message: { role: 'assistant', content: [{ type: 'text', text: 'I loaded the application transcript.' }], timestamp: 2 },
      },
    ]
    await repository.save('owner-1', 'session-1', entries, 'assistant-entry')

    const stored = await repository.get('owner-1', 'session-1')
    expect(stored?.entries).toHaveLength(2)
    expect(stored?.leafId).toBe('assistant-entry')

    const manager = SessionManager.inMemory('/workspace/project', { id: 'session-1' })
    hydrateSessionManager(manager, { entries: stored?.entries ?? [], leafId: stored?.leafId ?? null })
    expect(manager.isPersisted()).toBe(false)
    expect(manager.buildSessionContext().messages.map((message) => message.role)).toEqual(['user', 'assistant'])
    expect(manager.buildSessionContext().messages[0]).toMatchObject({ role: 'user', content: [{ text: 'Continue the migration' }] })
  })

  it('does not create or inspect a native session directory', () => {
    const manager = SessionManager.inMemory('/workspace/project', { id: 'run-1' })
    expect(manager.isPersisted()).toBe(false)
    expect(manager.getSessionFile()).toBeUndefined()
  })
})
