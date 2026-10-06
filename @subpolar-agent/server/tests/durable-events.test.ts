import { describe, expect, it } from 'vitest'
import { PocketBaseRuntimeStore } from '../persistence/pocketbase-runtime-store.ts'

describe('durable SSE events', () => {
  it('serializes concurrent events for the same owner without reusing a cursor', async () => {
    const records: Array<Record<string, unknown>> = []
    const client = {
      collection(name: string) {
        expect(name).toBe('durable_events')
        return {
          async getFullList() { return [...records].sort((a, b) => Number(b.cursor) - Number(a.cursor)).slice(0, 1) },
          async create(data: Record<string, unknown>) {
            await Promise.resolve()
            if (records.some((record) => record.owner_id === data.owner_id && record.cursor === data.cursor)) throw new Error('duplicate cursor')
            const record = { ...data, id: String(records.length + 1) }
            records.push(record)
            return record
          },
        }
      },
    }
    const store = new PocketBaseRuntimeStore(client as never)
    const events = await Promise.all(Array.from({ length: 12 }, (_, index) => store.appendEvent('owner', 'session', { type: 'test', index })))
    expect(events.map((event) => event.id)).toEqual(Array.from({ length: 12 }, (_, index) => index + 1))
  })
})
