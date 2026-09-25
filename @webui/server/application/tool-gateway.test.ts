import { describe, expect, test } from 'bun:test'
import {
  ToolGatewayAdapterRegistry,
  createToolGateway,
  createToolGatewayExecutor,
  type ExistingCallTool,
  type ToolGatewayContext,
  type ToolGatewayRequest,
  type ToolGatewayResult,
} from './tool-gateway.ts'

const context: ToolGatewayContext = {
  userId: 'user-1',
  agentName: 'master',
  sessionId: 'session-1',
  cwd: '/tmp/project',
  callId: 'call-1',
  permissionOverride: 'allow_all',
  waitForApproval: true,
}

const request: ToolGatewayRequest = {
  toolId: 'read',
  input: { path: 'README.md' },
}

describe('InProcessToolGateway', () => {
  test('delegates a call without making an HTTP request', async () => {
    const calls: Array<{ request: ToolGatewayRequest; context: ToolGatewayContext }> = []
    const gateway = createToolGateway({
      executor: async (nextRequest, nextContext) => {
        calls.push({ request: nextRequest, context: nextContext })
        return { ok: true, toolId: nextRequest.toolId, result: { content: 'ok' } }
      },
    })

    await expect(gateway.call(request, context)).resolves.toEqual({ ok: true, toolId: 'read', result: { content: 'ok' } })
    expect(calls).toEqual([{ request, context }])
  })

  test('lets a trusted adapter wrap the existing executor', async () => {
    const registry = new ToolGatewayAdapterRegistry()
    const delegated: ToolGatewayRequest[] = []
    registry.register('http', async (nextRequest, nextContext, next) => {
      delegated.push(nextRequest)
      const result = await next({ ...nextRequest, input: { ...nextRequest.input as Record<string, unknown>, wrapped: true } }, nextContext)
      if (!result.ok || !('result' in result)) return result
      return { ...result, result: { wrapped: result.result } }
    })
    const gateway = createToolGateway({
      adapters: registry,
      executor: async (nextRequest) => ({ ok: true, toolId: nextRequest.toolId, result: nextRequest.input }),
    })

    await expect(gateway.callWithAdapter('http', request, context)).resolves.toEqual({
      ok: true,
      toolId: 'read',
      result: { wrapped: { path: 'README.md', wrapped: true } },
    })
    expect(delegated).toEqual([request])
  })

  test('does not silently bypass an explicitly requested adapter', async () => {
    const gateway = createToolGateway({ executor: async () => ({ ok: true, toolId: 'read', result: null }) })

    await expect(gateway.callWithAdapter('mcp', request, context)).resolves.toEqual({
      ok: false,
      toolId: 'read',
      error: { code: 'ADAPTER_NOT_REGISTERED', message: 'Tool gateway adapter is not registered: mcp' },
    })
  })
})

describe('createToolGatewayExecutor', () => {
  test('maps gateway request/context to the existing callTool signature', async () => {
    type Client = { name: string }
    const received: unknown[] = []
    const callTool: ExistingCallTool<Client> = async (...args): Promise<ToolGatewayResult> => {
      received.push(args)
      return { ok: true, toolId: args[3], result: args[4] }
    }
    const executor = createToolGatewayExecutor({ name: 'client' }, callTool)

    await expect(executor(request, context)).resolves.toEqual({ ok: true, toolId: 'read', result: request.input })
    expect(received).toEqual([[
      { name: 'client' },
      'user-1',
      'master',
      'read',
      { path: 'README.md' },
      'session-1',
      'allow_all',
      {
        cwd: '/tmp/project',
        callId: 'call-1',
        waitForApproval: true,
        onApproval: undefined,
      },
    ]])
  })
})
