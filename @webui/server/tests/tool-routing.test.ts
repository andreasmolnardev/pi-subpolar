import { describe, expect, it, vi } from 'vitest'
import { createToolRoutingExtension } from '../../subpolar/extensions/tool-routing.ts'
import { hasPendingApprovalWaiter, notifyApprovalResolution } from '../application/tools/approval-execution.ts'

describe('WebUI tool routing boundary', () => {
  it('exposes web search directly and routes its call under canonical web.search ID', async () => {
    const registered = new Map<string, { execute: (id: string, input: unknown) => Promise<unknown> }>()
    const gateway = { call: vi.fn(async () => ({ ok: true, value: { results: [] } })) }
    const factory = createToolRoutingExtension({
      gateway: gateway as never,
      userId: 'owner-1',
      agentName: 'researcher',
      sessionId: 'session-1',
      cwd: '/workspace/project',
    })
    factory({
      registerTool: (definition: { name: string; execute: (id: string, input: unknown) => Promise<unknown> }) => registered.set(definition.name, definition),
      hook: vi.fn(),
    } as never)

    const result = await registered.get('web_search')?.execute('call-search', { query: 'Dashwise features' })

    expect(result).toMatchObject({ content: [{ text: expect.stringContaining('"ok": true') }] })
    expect(gateway.call).toHaveBeenCalledWith(
      expect.objectContaining({ callId: 'call-search', toolId: 'web.search', input: { query: 'Dashwise features' } }),
      expect.objectContaining({ sessionId: 'session-1', metadata: expect.objectContaining({ agentName: 'researcher' }) }),
    )
  })

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

  it('keeps the model tool call pending until approval and returns executed output', async () => {
    const registered = new Map<string, { execute: (id: string, input: unknown) => Promise<unknown> }>()
    const gateway = { call: vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 'approval_required', approvalId: 'approval-call-1' })
      .mockResolvedValueOnce({ ok: true, value: { content: [{ type: 'text', text: 'done' }], details: {} } }) }
    createToolRoutingExtension({ gateway: gateway as never, userId: 'owner', agentName: 'builder', sessionId: 'session', cwd: '/project' })({
      registerTool: (definition: { name: string; execute: (id: string, input: unknown) => Promise<unknown> }) => registered.set(definition.name, definition),
      hook: vi.fn(),
    } as never)
    const result = registered.get('ls')!.execute('call-1', {})
    await vi.waitFor(() => expect(hasPendingApprovalWaiter('approval-call-1')).toBe(true))
    expect(gateway.call).toHaveBeenCalledTimes(1)
    notifyApprovalResolution('approval-call-1', 'approved')
    expect(await result).toMatchObject({ content: [{ text: 'done' }] })
    expect(gateway.call).toHaveBeenCalledTimes(2)
  })
})
