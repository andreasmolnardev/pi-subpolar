import { Database } from 'bun:sqlite'
import { describe, expect, it } from 'bun:test'
import { ensureRuntimeRecoverySchema, getRuntimeRun, reconcileStartup, reserveRuntimeRun, updateRuntimeRun } from '../persistence/runtime-recovery.ts'

function database() {
  const db = new Database(':memory:')
  db.exec(`CREATE TABLE message_deliveries (state TEXT NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE message_queue (kind TEXT NOT NULL, state TEXT NOT NULL, error TEXT, updated_at INTEGER NOT NULL);`)
  ensureRuntimeRecoverySchema(db)
  return db
}

describe('durable runtime recovery', () => {
  it('persists idempotent owner-scoped runs and only allows one terminal transition', () => {
    const db = database()
    expect(reserveRuntimeRun(db, 'owner-a', 'session-a', 'run-a', 'request-a', 1).created).toBe(true)
    expect(reserveRuntimeRun(db, 'owner-a', 'session-a', 'run-a', 'request-b', 2).created).toBe(false)
    expect(reserveRuntimeRun(db, 'owner-b', 'session-a', 'run-a', undefined, 3).created).toBe(true)
    expect(updateRuntimeRun(db, 'owner-a', 'session-a', 'run-a', 'completed', undefined, 4)?.state).toBe('completed')
    expect(updateRuntimeRun(db, 'owner-a', 'session-a', 'run-a', 'failed', undefined, 5)?.state).toBe('completed')
    expect(getRuntimeRun(db, 'owner-a', 'session-a', 'run-a')?.requestId).toBe('request-a')
  })

  it('marks only nonterminal work unknown on restart and is idempotent', () => {
    const db = database()
    db.query('INSERT INTO message_deliveries VALUES (?, ?)').run('running', 1)
    db.query('INSERT INTO message_deliveries VALUES (?, ?)').run('completed', 1)
    db.query('INSERT INTO message_queue VALUES (?, ?, ?, ?)').run('steering', 'steering', null, 1)
    db.query('INSERT INTO message_queue VALUES (?, ?, ?, ?)').run('follow_up', 'enqueued', null, 1)
    reserveRuntimeRun(db, 'owner-a', 'session-a', 'run-a', undefined, 1)
    updateRuntimeRun(db, 'owner-a', 'session-a', 'run-a', 'running', undefined, 2)
    reserveRuntimeRun(db, 'owner-a', 'session-a', 'run-done', undefined, 1)
    updateRuntimeRun(db, 'owner-a', 'session-a', 'run-done', 'completed', undefined, 2)
    reconcileStartup(db, 10)
    reconcileStartup(db, 11)
    expect(db.query('SELECT state, updated_at FROM message_deliveries ORDER BY rowid').all()).toEqual([{ state: 'interrupted', updated_at: 10 }, { state: 'completed', updated_at: 1 }])
    expect(db.query('SELECT state, error, updated_at FROM message_queue ORDER BY rowid').all()).toEqual([{ state: 'failed', error: 'QUEUE_INTERRUPTED', updated_at: 10 }, { state: 'enqueued', error: null, updated_at: 1 }])
    expect(getRuntimeRun(db, 'owner-a', 'session-a', 'run-a')?.state).toBe('unknown')
    expect(getRuntimeRun(db, 'owner-a', 'session-a', 'run-done')?.state).toBe('completed')
  })
})
