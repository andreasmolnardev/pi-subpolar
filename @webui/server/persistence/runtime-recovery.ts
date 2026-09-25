export type RuntimeRunState = 'starting' | 'running' | 'waiting_for_approval' | 'completed' | 'failed' | 'interrupted' | 'unknown'

export type RuntimeRun = {
  ownerId: string
  sessionId: string
  runId: string
  requestId?: string
  state: RuntimeRunState
  createdAt: number
  updatedAt: number
  error?: string
}

type RecoveryDatabase = {
  query: (sql: string) => { run: (...parameters: any[]) => unknown; get: (...parameters: any[]) => unknown }
  transaction?: <T>(callback: () => T) => () => T
}

const nonTerminal = ['starting', 'running', 'waiting_for_approval']

export function ensureRuntimeRecoverySchema(database: { exec: (sql: string) => unknown }): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS runtime_runs (
      owner_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      request_id TEXT,
      state TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      error TEXT,
      PRIMARY KEY (owner_id, session_id, run_id)
    );
    CREATE INDEX IF NOT EXISTS idx_runtime_runs_state
      ON runtime_runs (owner_id, session_id, state, updated_at);
  `)
}

export function runtimeRunState(value: unknown): RuntimeRunState {
  return value === 'starting' || value === 'running' || value === 'waiting_for_approval' || value === 'completed'
    || value === 'failed' || value === 'interrupted' || value === 'unknown' ? value : 'unknown'
}

function runtimeRunFromRow(row: Record<string, unknown>): RuntimeRun {
  return {
    ownerId: String(row.owner_id), sessionId: String(row.session_id), runId: String(row.run_id),
    ...(typeof row.request_id === 'string' ? { requestId: row.request_id } : {}),
    state: runtimeRunState(row.state), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
    ...(typeof row.error === 'string' ? { error: row.error } : {}),
  }
}

function safeError(error: unknown): string {
  return error instanceof Error ? redactSensitiveText(error.message).slice(0, 1000) : 'Runtime run failed'
}

export function reserveRuntimeRun(database: RecoveryDatabase, ownerId: string, sessionId: string, runId: string, requestId?: string, now = Date.now()): { run: RuntimeRun; created: boolean } {
  const work = () => {
    const result = database.query(
      'INSERT OR IGNORE INTO runtime_runs (owner_id, session_id, run_id, request_id, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(ownerId, sessionId, runId, requestId ?? null, 'starting', now, now) as { changes?: number }
    const row = database.query('SELECT owner_id, session_id, run_id, request_id, state, created_at, updated_at, error FROM runtime_runs WHERE owner_id = ? AND session_id = ? AND run_id = ?').get(ownerId, sessionId, runId) as Record<string, unknown> | null
    if (!row) throw new Error('Runtime run could not be stored')
    return { run: runtimeRunFromRow(row), created: result.changes === 1 }
  }
  return database.transaction ? database.transaction(work)() : work()
}

export function getRuntimeRun(database: RecoveryDatabase, ownerId: string, sessionId: string, runId: string): RuntimeRun | null {
  const row = database.query('SELECT owner_id, session_id, run_id, request_id, state, created_at, updated_at, error FROM runtime_runs WHERE owner_id = ? AND session_id = ? AND run_id = ?').get(ownerId, sessionId, runId) as Record<string, unknown> | null
  return row ? runtimeRunFromRow(row) : null
}

export function updateRuntimeRun(database: RecoveryDatabase, ownerId: string, sessionId: string, runId: string, state: RuntimeRunState, error?: unknown, now = Date.now()): RuntimeRun | null {
  database.query(
    'UPDATE runtime_runs SET state = ?, error = ?, updated_at = ? WHERE owner_id = ? AND session_id = ? AND run_id = ? AND state IN (?, ?, ?)',
  ).run(state, error === undefined ? null : safeError(error), now, ownerId, sessionId, runId, ...nonTerminal)
  return getRuntimeRun(database, ownerId, sessionId, runId)
}

export function reconcileStartup(database: RecoveryDatabase, now = Date.now()): void {
  const work = () => {
    database.query('UPDATE message_deliveries SET state = ?, updated_at = ? WHERE state = ?').run('interrupted', now, 'running')
    database.query('UPDATE message_queue SET state = ?, error = ?, updated_at = ? WHERE kind = ? AND state = ?').run('failed', 'QUEUE_INTERRUPTED', now, 'steering', 'steering')
    database.query('UPDATE runtime_runs SET state = ?, updated_at = ? WHERE state IN (?, ?, ?)').run('unknown', now, ...nonTerminal)
  }
  database.transaction ? database.transaction(work)() : work()
}
import { redactSensitiveText } from '../core/security-redaction.ts'
