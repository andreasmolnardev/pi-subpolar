import { describe, expect, test } from 'bun:test'
import {
  createStatelessWebUiRuntime,
  type PocketBaseSdkClient,
} from '../application/runtime/stateless-webui-runtime.ts'
import type { RuntimeExecution } from '../../../packages/subpolar-contracts/src/index.ts'
import type { ToolGateway } from '../../../packages/subpolar-core/src/index.ts'

type Stored = { id: string; [key: string]: unknown }

function fakeClient(): PocketBaseSdkClient {
  const collections = new Map<string, Stored[]>()
  let nextId = 0
  const collection = (name: string) => {
    const records = () => {
      const existing = collections.get(name)
      if (existing) return existing
      const created: Stored[] = []
      collections.set(name, created)
      return created
    }
    return {
      async getFullList() { return records().map((record) => structuredClone(record)) },
      async getOne(id: string) {
        const record = records().find((item) => item.id === id)
        if (!record) throw Object.assign(new Error('not found'), { status: 404 })
        return structuredClone(record)
      },
      async create(data: Record<string, unknown>) {
        const record = { id: `record-${++nextId}`, ...structuredClone(data) }
        records().push(record)
        return structuredClone(record)
      },
      async update(id: string, data: Record<string, unknown>) {
        const record = records().find((item) => item.id === id)
        if (!record) throw Object.assign(new Error('not found'), { status: 404 })
        Object.assign(record, structuredClone(data))
        return structuredClone(record)
      },
    }
  }
  return { collection }
}

const gateway: ToolGateway = {
  tools: [],
  capabilities: { idempotency: 'in-memory-per-gateway', multiProcessGuarantee: false },
  lookup: () => undefined,
  call: async (call) => ({ ok: true, status: 'executed', callId: call.callId, toolId: call.toolId, value: null }),
}

describe('stateless WebUI runtime composition', () => {
  test('persists run events and replays a terminal result without executing Pi twice', async () => {
    const client = fakeClient()
    const events: unknown[] = []
    let executions = 0
    const runtime = createStatelessWebUiRuntime({
      client,
      ownerId: 'user-1',
      gateway: gateway as never,
      resolveContext: async (request) => ({
        requestId: request.requestId,
        runId: request.runId,
        principal: { id: 'user-1', kind: 'user' },
        sessionId: request.sessionId,
        agentId: 'agent-1',
        metadata: { agentName: 'master' },
      }),
      execute: async (execution: RuntimeExecution) => {
        executions += 1
        await execution.emit({ source: 'pi', phase: 'completed' })
        return { text: `response:${execution.request.prompt}` }
      },
      onEvent: (event) => { events.push(event) },
    })

    const first = await runtime.runPrompt({
      ownerId: 'user-1',
      sessionId: 'session-1',
      runId: 'run-1',
      requestId: 'request-1',
      prompt: 'hello',
    })
    const second = await runtime.runPrompt({
      ownerId: 'user-1',
      sessionId: 'session-1',
      runId: 'run-1',
      requestId: 'request-1',
      prompt: 'hello',
    })

    expect(first.state).toBe('completed')
    expect(second.state).toBe('completed')
    expect(second.resumed).toBe(true)
    expect(executions).toBe(1)
    expect(events.map((event) => (event as { type: string }).type)).toEqual([
      'run.started',
      'run.progress',
      'run.completed',
    ])
  })
})
