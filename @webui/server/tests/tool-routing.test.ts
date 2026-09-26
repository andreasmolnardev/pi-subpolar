import { describe, expect, it, vi } from 'vitest'
import { createToolRoutingExtension } from '../../subpolar/extensions/tool-routing.ts'

describe('WebUI tool routing boundary', () => {
  it('routes SDK tool calls through the central gateway with approval context', async () => {
    const calls: unknown[] = []
    const registered = new Map<string, { execute: (id: string, input: unknown) => Promise<unknown> }>()
    const gateway = {
      call: vi.fn(async (request: unknown, context: unknown) => {
        calls.push({ request, context })
        return { ok: true, result: { content: [{ type: 'text', text: 'approved result' }] } }
      }),
    }
    const factory = createToolRoutingExtension({
      gateway: gateway as never,
      userId: 'owner-1',
      agentName: 'builder',
      sessionId: 'session-1',
      cwd: '/workspace/project',
      permissionOverride: 'ask',
      onApproval: vi.fn(),
    })
    factory({
      registerTool: (definition: { name: string; execute: (id: string, input: unknown) => Promise<unknown> }) => registered.set(definition.name, definition),
      hook: vi.fn(),
    } as never)

    const result = await registered.get('subpolar-tools')?.execute('call-1', { action: 'call', toolId: 'http/search', input: { query: 'status' } })
    expect(result).toMatchObject({ content: [{ text: 'approved result' }] })
    expect(calls).toEqual([{
      request: { callId: 'call-1', toolId: 'http/search', input: { query: 'status' }, idempotencyKey: 'tool-call:call-1' },
      context: {
        requestId: 'call-1',
        principal: { id: 'owner-1', kind: 'user' },
        agentId: 'builder',
        sessionId: 'session-1',
        cwd: '/workspace/project',
        metadata: { agentName: 'builder', permissionOverride: 'ask' },
      },
    }])
  })
})
