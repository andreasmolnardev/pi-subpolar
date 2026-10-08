import { Database } from 'bun:sqlite'
import { describe, expect, it } from 'bun:test'
import { ensureRuntimeRecoverySchema, getRuntimeRun, reconcileStartup, reserveRuntimeRun, updateRuntimeRun, type RuntimeRunState } from '../persistence/runtime-recovery.ts'

describe('chat recovery run restart seam (SQLite)', () => {
  it('keeps uncertain work unknown without re-reserving it or overwriting it with a late success', () => {
    const db = new Database(':memory:')
    try {
      db.exec('CREATE TABLE message_deliveries (state TEXT, updated_at INTEGER); CREATE TABLE message_queue (kind TEXT, state TEXT, error TEXT, updated_at INTEGER);')
      ensureRuntimeRecoverySchema(db)
      const states: RuntimeRunState[] = ['starting', 'running', 'waiting_for_approval', 'completed', 'failed', 'interrupted', 'unknown']
      for (const state of states) {
        reserveRuntimeRun(db, 'owner', 'session', state, `request-${state}`, 1)
        if (state !== 'starting') updateRuntimeRun(db, 'owner', 'session', state, state, undefined, 2)
      }
      reconcileStartup(db, 10)
      reconcileStartup(db, 11)
      for (const state of states) {
        const uncertain = ['starting', 'running', 'waiting_for_approval'].includes(state)
        const run = getRuntimeRun(db, 'owner', 'session', state)!
        expect(run.state).toBe(uncertain ? 'unknown' : state)
        expect(run.updatedAt).toBe(uncertain ? 10 : 2)
        expect(reserveRuntimeRun(db, 'owner', 'session', state, 'replacement', 12).created).toBe(false)
        expect(updateRuntimeRun(db, 'owner', 'session', state, 'completed', undefined, 13)?.state).toBe(run.state)
        expect(getRuntimeRun(db, 'other-owner', 'session', state)).toBeNull()
      }
    } finally {
      db.close()
    }
  })
})
