import { describe, expect, it } from 'vitest'
import { PocketBaseRuntimeStore } from '../persistence/pocketbase-runtime-store.ts'
import { handleRuntimeRoute } from '../routes/runtime.ts'

const records = [
  { id: 'own-record', owner_id: 'alice', session_id: 'session-a', run_id: 'run-a', request_id: 'request-a', state: 'failed', created_at: 10, updated_at: 20, error: 'authorization: Bearer top-secret-value' },
  { id: 'other-record', owner_id: 'bob', session_id: 'session-b', run_id: 'run-a', state: 'running', created_at: 11, updated_at: 21 },
  { id: 'bob-only-record', owner_id: 'bob', session_id: 'session-b', run_id: 'bob-only', state: 'running', created_at: 12, updated_at: 22 },
]

function database() {
  return {
    collection(name: string) {
      expect(name).toBe('runtime_runs')
      return {
        async getFullList(options: { filter: string }) {
          const ownerId = options.filter.match(/owner_id = "([^"]*)"/)?.[1]
          const runId = options.filter.match(/run_id = "([^"]*)"/)?.[1]
          return records.filter((record) => record.owner_id === ownerId && record.run_id === runId)
        },
      }
    },
  }
}

function context(ownerId: string | null = 'alice', runId = 'run-a') {
  const url = new URL(`http://localhost/api/runs/${runId}`)
  return {
    request: new Request(url.href, { method: 'GET' }),
    url,
    path: ['api', 'runs', runId],
    correlationId: 'test',
    authenticatedUser: ownerId ? { id: ownerId } : null,
    gatewayCredential: null,
    internalRequest: false,
    deps: {
      applicationDatabase: async () => database(),
      PocketBaseRuntimeStore,
      json: (body: unknown, status = 200) => Response.json(body, { status }),
    },
  } as never
}

describe('public user-scoped runtime run inspection', () => {
  it('returns the authenticated user’s run and redacts stored errors', async () => {
    const response = await handleRuntimeRoute(context())
    expect(response?.status).toBe(200)
    const body = await response?.json() as { run: { ownerId: string; sessionId: string; runId: string; state: string; error: string } }
    expect(body.run).toMatchObject({ ownerId: 'alice', sessionId: 'session-a', runId: 'run-a', state: 'failed' })
    expect(body.run.error).toContain('[REDACTED]')
    expect(JSON.stringify(body)).not.toContain('top-secret-value')
  })

  it('returns 404 for a run owned by another user', async () => {
    const response = await handleRuntimeRoute(context('alice', 'bob-only'))
    expect(response?.status).toBe(404)
    expect(await response?.json()).toEqual({ error: 'Run not found' })
  })

  it('returns 404 when one owner has ambiguous duplicate run IDs', async () => {
    records.push({ ...records[0]!, id: 'duplicate-record', session_id: 'session-other' })
    try {
      const store = new PocketBaseRuntimeStore(database() as never)
      await expect(store.getRuntimeRun('alice', 'run-a')).resolves.toBeNull()
    } finally {
      records.pop()
    }
  })
})
