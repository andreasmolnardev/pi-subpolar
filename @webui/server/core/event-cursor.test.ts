import { Database } from 'bun:sqlite'
import { describe, expect, it } from 'vitest'
import { createEventCursor, type EventCursorOptions } from './event-cursor.ts'

function log(limits?: EventCursorOptions) {
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

  it('prunes events older than the age cutoff but keeps the exact cutoff', () => {
    let currentTime = 899
    const { cursor } = log({ maxAgeMs: 100, now: () => currentTime })
    cursor.append('alice', null, { type: 'older' })
    currentTime = 900
    const cutoff = cursor.append('alice', null, { type: 'cutoff' })
    currentTime = 1000
    cursor.append('alice', null, { type: 'newest' })

    const replay = cursor.replay('alice', '0')
    expect(replay.reset).toBe(true)
    expect(replay.resetCursor).toBe(cutoff.id - 1)
    expect(replay.events.map((event) => event.payload)).toEqual([{ type: 'cutoff' }, { type: 'newest' }])
  })

  it('keeps age pruning owner-independent while replaying only the requested owner', () => {
    let currentTime = 899
    const { cursor } = log({ maxAgeMs: 100, now: () => currentTime })
    const alice = cursor.append('alice', null, { type: 'old-alice' })
    currentTime = 950
    const bob = cursor.append('bob', null, { type: 'bob' })
    currentTime = 1000
    cursor.append('alice', null, { type: 'new-alice' })

    const aliceReplay = cursor.replay('alice', String(alice.id))
    expect(aliceReplay.reset).toBe(true)
    expect(aliceReplay.events.map((event) => event.ownerId)).toEqual(['alice'])
    expect(cursor.replay('bob', '0').events.map((event) => event.id)).toEqual([bob.id])
  })

  it.each([
    ['absent', undefined],
    ['negative', -1],
    ['NaN', Number.NaN],
    ['infinite', Number.POSITIVE_INFINITY],
  ])('disables age pruning for %s maxAgeMs', (_label, maxAgeMs) => {
    const { cursor } = log({ maxAgeMs, now: () => 1000 })
    const event = cursor.append('alice', null, { type: 'old' })

    expect(cursor.replay('alice', '0').events.map((item) => item.id)).toEqual([event.id])
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
