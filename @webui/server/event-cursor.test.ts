import { Database } from 'bun:sqlite'
import { describe, expect, it } from 'vitest'
import { createEventCursor } from './event-cursor.ts'

function log(limits?: { maxRows: number; maxBytes: number }) {
  const database = new Database(':memory:')
  return { database, cursor: createEventCursor(database, limits) }
}

describe('durable event cursor', () => {
  it('replays only the owner events in cursor order', () => {
    const { cursor } = log()
    const first = cursor.append('alice', 's1', { type: 'session.status', properties: { sessionID: 's1' } })
    cursor.append('bob', 's2', { type: 'session.status', properties: { sessionID: 's2' } })
    const third = cursor.append('alice', 's1', { type: 'message.queue.updated', properties: { sessionID: 's1' } })

    expect(cursor.replay('alice', String(first.id)).events.map((event) => event.id)).toEqual([third.id])
  })

  it('resets an expired cursor and retains a bounded history', () => {
    const { cursor } = log({ maxRows: 2, maxBytes: 10000 })
    cursor.append('alice', null, { type: 'one' })
    cursor.append('alice', null, { type: 'two' })
    const latest = cursor.append('alice', null, { type: 'three' })

    const replay = cursor.replay('alice', '0')
    expect(replay.reset).toBe(true)
    expect(replay.resetCursor).toBe(latest.id - 2)
    expect(replay.events.map((event) => event.payload)).toEqual([{ type: 'two' }, { type: 'three' }])
  })

  it('redacts secrets before persistence and bounds payload size', () => {
    const { database, cursor } = log()
    const event = cursor.append('alice', null, { type: 'approval', token: 'do-not-store', nested: { password: 'also-secret' } })
    expect(event.payload).toEqual({ type: 'approval', token: '[REDACTED]', nested: { password: '[REDACTED]' } })
    expect(database.query('SELECT payload FROM durable_events').get()).toEqual({ payload: JSON.stringify(event.payload) })

    const oversized = cursor.append('alice', null, { type: 'activity', text: 'x'.repeat(70_000) })
    expect(oversized.payload).toEqual({ type: 'event.redacted', properties: { reason: 'payload_too_large' } })
  })

  it('uses a stable cursor for duplicate replay requests', () => {
    const { cursor } = log()
    const first = cursor.append('alice', 's1', { type: 'session.status', properties: { sessionID: 's1' } })
    const replay = cursor.replay('alice', String(first.id))
    expect(replay.events).toEqual([])
    expect(cursor.replay('alice', String(first.id)).events).toEqual([])
  })
})
