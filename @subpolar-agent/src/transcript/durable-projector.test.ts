import { describe, expect, it } from 'vitest'
import { SessionTranscriptRepository } from '../../server/persistence/session-transcript'
import { projectEntries } from '../../transcript/projector'
import { mergeDurableTranscript } from '../../transcript/durable-projector'
import type { PiDurableTranscriptEntry } from '../../../packages/subpolar-adapter-pi-durable/src/index'

type Message = Record<string, unknown>
const durable = (...entries: { id: string | number; kind?: string; messages: Message[] }[]) =>
  entries as unknown as PiDurableTranscriptEntry[]

class FakeCollection {
  records: (Record<string, unknown> & { id: string })[] = []
  async getFirstListItem(filter: string) {
    const ownerId = /owner_id = "([^"]*)"/.exec(filter)?.[1]
    const sessionId = /session_id = "([^"]*)"/.exec(filter)?.[1]
    const record = this.records.find((item) => item.owner_id === ownerId && item.session_id === sessionId)
    if (!record) throw new Error('not found')
    return { ...record }
  }
  async create(data: Record<string, unknown>) {
    const record = { ...data, id: `transcript-${this.records.length + 1}` }
    this.records.push(record)
    return { ...record }
  }
  async update(id: string, data: Record<string, unknown>) {
    const record = this.records.find((item) => item.id === id)
    if (!record) throw new Error('not found')
    Object.assign(record, data)
    return { ...record }
  }
}

describe('Durable transcript projection', () => {
  it('projects plain Durable user and assistant messages to the UI shape', () => {
    const merged = mergeDurableTranscript([], null, durable(
      { id: 1, messages: [{ role: 'user', content: 'hello', timestamp: 10 }] },
      { id: 2, messages: [{ role: 'assistant', content: [{ type: 'text', text: 'hi' }], timestamp: 11 }] },
    ), 'session-a')

    expect(merged.leafId).toBe('pi-durable:session-a:2:0')
    expect(merged.entries.map((entry) => (entry.message as Message).role)).toEqual(['user', 'assistant'])
    expect(projectEntries(merged.entries, merged.leafId, 'session-a').map((message) => message.info.role)).toEqual(['user', 'assistant'])
  })

  it('projects assistant tool calls with their Durable tool results for inspection', () => {
    const merged = mergeDurableTranscript([], null, durable(
      { id: 'user', messages: [{ role: 'user', content: 'read file' }] },
      { id: 'call', messages: [{ role: 'assistant', content: [{ type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: 'README.md' } }] }] },
      { id: 'result', messages: [{ role: 'toolResult', toolCallId: 'call-1', content: [{ type: 'text', text: 'contents' }], isError: false }] },
    ), 'session-a')
    const messages = projectEntries(merged.entries, merged.leafId, 'session-a')

    expect(messages[1]?.parts[0]).toMatchObject({ type: 'tool', callID: 'call-1', tool: 'read', state: { status: 'completed', output: 'contents' } })
  })

  it('keeps legacy entries, chains new entries chronologically, and is idempotent', () => {
    const legacy = { id: 'legacy', parentId: null, type: 'message', message: { role: 'user', content: 'old' } }
    const source = durable(
      { id: 'u', messages: [{ role: 'user', content: 'new' }] },
      { id: 'a', messages: [{ role: 'assistant', content: 'answer' }] },
    )
    const once = mergeDurableTranscript([legacy], 'legacy', source, 's')
    const twice = mergeDurableTranscript(once.entries, once.leafId, source, 's')

    expect(twice.entries).toHaveLength(3)
    expect(twice.entries[0]).toEqual(legacy)
    expect(twice.entries[1]).toMatchObject({ id: 'pi-durable:s:u:0', parentId: 'legacy' })
    expect(twice.entries[2]).toMatchObject({ id: 'pi-durable:s:a:0', parentId: 'pi-durable:s:u:0' })
    expect(twice.leafId).toBe(once.leafId)
  })

  it('filters system instructions and relies on repository redaction before persistence', async () => {
    const collection = new FakeCollection()
    const repository = new SessionTranscriptRepository({ collection: () => collection } as never)
    const merged = mergeDurableTranscript([], null, durable(
      { id: 'system', kind: 'pi.system', messages: [{ role: 'system', content: 'private instructions' }] },
      { id: 'u', messages: [{ role: 'user', content: 'apiKey=user-secret' }] },
      { id: 'a', messages: [{ role: 'assistant', content: [{ type: 'text', text: 'token=assistant-secret' }] }] },
    ), 's')
    await repository.save('owner', 's', merged.entries, merged.leafId)
    const stored = await repository.get('owner', 's')
    const serialized = JSON.stringify(stored?.entries)

    expect(stored?.entries).toHaveLength(2)
    expect(serialized).not.toContain('private instructions')
    expect(serialized).not.toContain('user-secret')
    expect(serialized).not.toContain('assistant-secret')
    expect(serialized).toContain('[REDACTED]')
  })
})
