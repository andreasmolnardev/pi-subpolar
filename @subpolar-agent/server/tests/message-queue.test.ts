import { Database } from 'bun:sqlite'
import { describe, expect, it } from 'bun:test'
import { claimQueueEntry, clearQueue, listQueueEntries, QueueEntryConflictError, QueueEntryTransitionError, reconcileInterruptedSteering, reorderQueueEntry, reserveQueueEntry, updateQueueEntry } from '../persistence/message-queue.ts'

function database() {
  const db = new Database(':memory:')
  db.exec(`CREATE TABLE message_queue (
    owner_id TEXT NOT NULL, session_id TEXT NOT NULL, client_id TEXT NOT NULL,
    content TEXT NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL, position INTEGER NOT NULL,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, error TEXT,
    PRIMARY KEY (owner_id, session_id, client_id)
  )`)
  return db
}

describe('durable message queue', () => {
  it('is idempotent for the same owner, session, and client ID', () => {
    const db = database()
    const first = reserveQueueEntry(db, 'owner-a', 'session-a', 'client-a', 'one', 'follow_up')
    const second = reserveQueueEntry(db, 'owner-a', 'session-a', 'client-a', 'one', 'follow_up')
    expect(first.created).toBe(true)
    expect(second.created).toBe(false)
    expect(listQueueEntries(db, 'owner-a', 'session-a')).toHaveLength(1)
    expect(() => reserveQueueEntry(db, 'owner-a', 'session-a', 'client-a', 'changed', 'follow_up')).toThrow(QueueEntryConflictError)
  })

  it('scopes entries by owner and supports retry, reorder, and clear', () => {
    const db = database()
    reserveQueueEntry(db, 'owner-a', 'session-a', 'client-a', 'one', 'follow_up')
    reserveQueueEntry(db, 'owner-a', 'session-a', 'client-b', 'two', 'follow_up')
    reserveQueueEntry(db, 'owner-b', 'session-a', 'client-a', 'private', 'follow_up')
    claimQueueEntry(db, 'owner-a', 'session-a', 'client-a')
    updateQueueEntry(db, 'owner-a', 'session-a', 'client-a', 'failed', 'temporary')
    expect(listQueueEntries(db, 'owner-b', 'session-a')).toHaveLength(1)
    expect(updateQueueEntry(db, 'owner-a', 'session-a', 'client-a', 'enqueued')?.state).toBe('enqueued')
    expect(reorderQueueEntry(db, 'owner-a', 'session-a', 'client-b', 0)?.position).toBe(0)
    clearQueue(db, 'owner-a', 'session-a')
    expect(listQueueEntries(db, 'owner-a', 'session-a')).toHaveLength(0)
  })

  it('claims a follow-up exactly once when callbacks race', () => {
    const db = database()
    reserveQueueEntry(db, 'owner-a', 'session-a', 'client-a', 'one', 'follow_up')
    const first = claimQueueEntry(db, 'owner-a', 'session-a', 'client-a')
    const second = claimQueueEntry(db, 'owner-a', 'session-a', 'client-a')
    expect(first?.state).toBe('steering')
    expect(second).toBeNull()
  })

  it('rejects transitions that are not legal for the entry kind', () => {
    const db = database()
    reserveQueueEntry(db, 'owner-a', 'session-a', 'steering-a', 'steer', 'steering')
    expect(() => updateQueueEntry(db, 'owner-a', 'session-a', 'steering-a', 'enqueued')).toThrow(QueueEntryTransitionError)
    reserveQueueEntry(db, 'owner-a', 'session-a', 'follow-a', 'follow', 'follow_up')
    expect(() => updateQueueEntry(db, 'owner-a', 'session-a', 'follow-a', 'delivered')).toThrow(QueueEntryTransitionError)
  })

  it('allows steering failure to be retried only through enqueued', () => {
    const db = database()
    reserveQueueEntry(db, 'owner-a', 'session-a', 'steering-a', 'steer', 'steering')
    updateQueueEntry(db, 'owner-a', 'session-a', 'steering-a', 'failed', 'temporary')
    expect(updateQueueEntry(db, 'owner-a', 'session-a', 'steering-a', 'enqueued')?.state).toBe('enqueued')
  })

  it('fails stale steering claims without draining enqueued entries', () => {
    const db = database()
    reserveQueueEntry(db, 'owner-a', 'session-a', 'steering-a', 'steer', 'steering')
    reserveQueueEntry(db, 'owner-a', 'session-a', 'follow-a', 'follow', 'follow_up')
    reconcileInterruptedSteering(db, 123)
    expect(listQueueEntries(db, 'owner-a', 'session-a')).toMatchObject([
      { clientId: 'steering-a', state: 'failed', error: 'QUEUE_INTERRUPTED' },
      { clientId: 'follow-a', state: 'enqueued' },
    ])
    reconcileInterruptedSteering(db, 124)
    expect(listQueueEntries(db, 'owner-a', 'session-a')[0]?.updatedAt).toBe(123)
  })
})
