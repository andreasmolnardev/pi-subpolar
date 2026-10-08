
import { describe, expect, it, vi } from 'vitest'
import type PocketBase from 'pocketbase'
import { listToolsForAgent, searchToolsForAgent, describeToolForAgent, type AgentDefinition, type ToolDefinition } from '../application/tools/tools.ts'
import type { ApprovalRecord } from '../../../packages/subpolar-contracts/src/index.ts'
import { handleToolsRoute } from '../routes/tools.ts'
import { handleGatewayRoute } from '../routes/gateway.ts'
import { ApprovalFlowService } from '../application/tools/approval-flow.ts'
import { assertGatewayAccess, GatewayAuthError } from '../persistence/gateway-credentials.ts'
import { redactSensitive } from '../core/security-redaction.ts'
import { createPolicyGateway } from '../../../packages/subpolar-core/src/index.ts'
import { runCli, EXIT_REMOTE } from '../../../packages/subpolar-tools/src/cli.ts'

const session = { id: 'session', userId: 'owner', profile: 'builder', projectId: 'project', directory: '/persisted' }
const credential = { id: 'credential', tokenId: 'credential', ownerId: 'owner', principal: 'cli', prefix: 'test', createdAt: 1, permissions: ['list', 'query', 'describe', 'call', 'approvals', 'add'], scope: { sessionIds: ['session'], projectIds: ['project'], agentNames: ['builder'] } }

function fixture(path: string, input: unknown = {}, method = 'POST', options: { owner?: string; scoped?: boolean; client?: PocketBase; realDiscovery?: boolean } = {}) {
  const deps = {
    body: async (request: Request) => request.json(),
    json: (body: unknown, status = 200) => Response.json(body, { status }),
    applicationDatabase: vi.fn(async () => options.client ?? {}),
    ensureUserMetadata: vi.fn(async () => undefined),
    createProjectSessionRepository: () => ({ getSessionById: vi.fn(async () => ({ ...session, userId: options.owner ?? 'owner' })) }),
    assertGatewayAccess,
    GatewayAuthError,
    gatewayErrorResponse: (error: GatewayAuthError) => Response.json({ error: { code: error.code, message: error.message } }, { status: 403 }),
    redactSensitive,
    redactedDiagnostic: () => 'redacted',
    listToolsForAgent: vi.fn(options.realDiscovery ? listToolsForAgent : async (..._args: Parameters<typeof listToolsForAgent>) => [{ id: 'safe.echo' }] as Awaited<ReturnType<typeof listToolsForAgent>>),
    searchToolsForAgent: vi.fn(options.realDiscovery ? searchToolsForAgent : async (..._args: Parameters<typeof searchToolsForAgent>) => [{ tool: 'safe.echo' }] as Awaited<ReturnType<typeof searchToolsForAgent>>),
    describeToolForAgent: vi.fn(options.realDiscovery ? describeToolForAgent : async (..._args: Parameters<typeof describeToolForAgent>) => ({ id: 'safe.echo' }) as Awaited<ReturnType<typeof describeToolForAgent>>),
    upsertRegisteredTool: vi.fn(async () => ({})),
    requestedPermissionOverride: (value: unknown) => value,
    resolveToolSessionContext: vi.fn(async (): Promise<{ sessionId: string; agentName: string; cwd: string; project?: { id: string }; permissionOverride: 'none' | 'ask' | 'allow_all'; permission: { source: string } }> => ({ sessionId: 'session', agentName: 'builder', cwd: '/persisted', permissionOverride: 'none', permission: { source: 'session' } })),
    createCoreToolGateway: vi.fn(async () => ({ call: vi.fn(async () => ({ ok: true, value: { token: 'execution-secret' } })) })),
    continueCoreApprovedTool: vi.fn(async () => ({ ok: true, value: { apiKey: 'continuation-secret' } })),
    listPendingCoreApprovals: vi.fn(async () => [{ id: 'approval', session_id: 'session', tool_id: 'safe.echo', input: { password: 'approval-secret' } }]),
    permissionAskedProperties: (value: unknown) => value,
    hasPendingApprovalWaiter: () => false,
    respondToCoreApproval: vi.fn(async () => ({ id: 'approval', status: 'approved', input: { token: 'approval-secret' } })),
    notifyApprovalResolution: vi.fn(),
    publicGatewayCredential: (value: unknown) => value,
    createGatewayCredential: vi.fn(async () => ({ credential: {}, secret: 'new-secret' })),
  }
  const url = new URL(`http://localhost${path}`)
  const request = new Request(url.toString(), { method, ...(method === 'GET' ? {} : { body: JSON.stringify(input) }) })
  const context = { request, url, path: url.pathname.split('/').filter(Boolean), correlationId: 'test', deps, gatewayCredential: options.scoped === false ? null : credential, authenticatedUser: options.scoped === false ? { id: 'owner' } : null, internalRequest: false }
  return { context: context as never, deps }
}

async function tools(path: string, input: unknown, options?: { owner?: string; scoped?: boolean }) {
  const f = fixture(path, input, 'POST', options)
  const response = (await handleToolsRoute(f.context))!
  return { ...f, response, body: await response.json() as { tools?: unknown[]; error?: { code: string } } }
}

describe('gateway parity progress: route boundary', () => {
  it.each(['list', 'search', 'describe'])('authorizes scoped %s against the owned persisted session, not caller claims', async (operation) => {
    const result = await tools(`/api/subpolar-cli/tools/${operation}`, { sessionId: 'session', agentName: 'master', projectId: 'fake', toolId: 'safe.echo', query: 'safe' })
    expect(result.response.status).toBe(200)
    if (operation === 'search') expect(result.body.tools).toEqual([{ tool: 'safe.echo' }])
    if (operation === 'describe') expect(result.deps.describeToolForAgent).toHaveBeenCalledWith({}, 'owner', 'builder', 'safe.echo', 'project', 'none')
    if (operation === 'list') expect(result.deps.listToolsForAgent).toHaveBeenCalledWith({}, 'owner', 'builder', 'project', true, 'none')
    if (operation === 'search') {
      expect(result.deps.searchToolsForAgent).toHaveBeenCalledWith({}, 'owner', 'builder', 'safe', 'project', 'none')
      expect(result.deps.listToolsForAgent).not.toHaveBeenCalled()
    }
    expect(result.deps.resolveToolSessionContext).toHaveBeenCalledWith({}, 'owner', 'session')
  })

  it.each(['list', 'search', 'describe', 'call', 'continue'])('does not expose another user session through %s', async (operation) => {
    const result = await tools(`/api/subpolar-cli/tools/${operation}`, { sessionId: 'session', toolId: 'safe.echo', approvalId: 'approval', query: 'safe' }, { owner: 'other-user' })
    expect(result.response.status).toBe(404)
    expect(result.deps.createCoreToolGateway).not.toHaveBeenCalled()
    expect(result.deps.continueCoreApprovedTool).not.toHaveBeenCalled()
    expect(result.deps.listToolsForAgent).not.toHaveBeenCalled()
  })

  it('fails closed when discovery omits scoped session context', async () => {
    const result = await tools('/api/subpolar-cli/tools/list', {})
    expect(result.response.status).toBe(403)
    expect(result.body.error?.code).toBe('GATEWAY_SCOPE_DENIED')
  })

  it('rejects project/session/agent scoped registration because the registry is global', async () => {
    const result = await tools('/api/subpolar-cli/tools/register', { agentName: 'builder', projectId: 'project', sessionId: 'session' })
    expect(result.response.status).toBe(403)
    expect(result.deps.upsertRegisteredTool).not.toHaveBeenCalled()
  })

  it('calls only the existing core gateway after validating actual resolved agent scope', async () => {
    const f = fixture('/api/subpolar-cli/tools/call', { sessionId: 'session', toolId: 'safe.echo', callId: 'original' })
    f.deps.resolveToolSessionContext.mockResolvedValueOnce({ sessionId: 'session', agentName: 'master', cwd: '/persisted', permissionOverride: 'none', permission: { source: 'session' } })
    expect((await handleToolsRoute(f.context))!.status).toBe(403)
    expect(f.deps.createCoreToolGateway).not.toHaveBeenCalled()
    const allowed = await tools('/api/subpolar-cli/tools/call', { sessionId: 'session', toolId: 'safe.echo', callId: 'original' })
    expect(allowed.response.status).toBe(200)
    expect(JSON.stringify(allowed.body)).not.toContain('execution-secret')
  })

  it('uses the same persisted policy and original call identity for CLI and legacy approval continuation', async () => {
    const cli = await tools('/api/subpolar-cli/tools/continue', { sessionId: 'session', approvalId: 'approval', callId: 'replacement', projectId: 'fake', agentName: 'master' })
    const legacy = await tools('/api/session/session/permissions/approval', { response: 'always' })
    const expected = { sessionId: 'session', agentName: 'builder', projectId: 'project', cwd: '/persisted', permissionOverride: 'none' }
    expect(cli.deps.continueCoreApprovedTool).toHaveBeenCalledWith({}, 'owner', 'approval', expected)
    expect(legacy.deps.continueCoreApprovedTool).toHaveBeenCalledWith({}, 'owner', 'approval', expected)
    expect(JSON.stringify(cli.body)).not.toContain('continuation-secret')
    expect(JSON.stringify(legacy.body)).not.toContain('approval-secret')
    expect(JSON.stringify(legacy.body)).not.toContain('continuation-secret')
  })

  it('does not resolve a legacy approval belonging to another session owner', async () => {
    const result = await tools('/api/session/session/permissions/approval', { response: 'approve' }, { owner: 'other-user' })
    expect(result.response.status).toBe(404)
    expect(result.deps.respondToCoreApproval).not.toHaveBeenCalled()
    expect(result.deps.notifyApprovalResolution).not.toHaveBeenCalled()
  })

  it('does not turn an already rejected approval into an approved waiter notification on retry', async () => {
    const f = fixture('/api/session/session/permissions/approval', { response: 'approve' })
    f.deps.respondToCoreApproval.mockResolvedValueOnce({ id: 'approval', status: 'rejected', input: { token: 'approval-secret' } })
    expect((await handleToolsRoute(f.context))!.status).toBe(200)
    expect(f.deps.notifyApprovalResolution).toHaveBeenCalledWith('approval', 'rejected')
    expect(f.deps.continueCoreApprovedTool).not.toHaveBeenCalled()
  })

  it('the existing approval authority rejects another user approval ID even with an owned session', async () => {
    const update = vi.fn()
    const client = { collection: () => ({ getOne: async () => ({ id: 'foreign-approval', user_id: 'other-user', session_id: 'session', status: 'pending', created_at: Date.now() }), update }) }
    const flow = new ApprovalFlowService(client as never)
    expect(await flow.resolve({ userId: 'owner', sessionId: 'session' }, 'foreign-approval', 'approve')).toMatchObject({ ok: false, error: { code: 'APPROVAL_FORBIDDEN' } })
    expect(update).not.toHaveBeenCalled()
  })

  it('lists scoped legacy approvals with full persisted scope and redacted inputs', async () => {
    const f = fixture('/api/permission?sessionId=session', {}, 'GET')
    const response = (await handleToolsRoute(f.context))!
    expect(response.status).toBe(200)
    expect(JSON.stringify(await response.json())).not.toContain('approval-secret')
    expect(f.deps.listPendingCoreApprovals).toHaveBeenCalledWith({}, 'owner', 'session')
  })

  it.each([{ scope: { sessionIds: [12] } }, { scope: { sessionIds: 'session' } }, { scope: [] }, { scope: { typo: ['session'] } }, { expiresAt: 'tomorrow' }])('rejects malformed credential scope/expiry rather than silently widening it: %j', async (input) => {
    const f = fixture('/api/gateway/credentials', { principal: 'cli', permissions: ['call'], ...input }, 'POST', { scoped: false })
    expect((await handleGatewayRoute(f.context))!.status).toBe(400)
    expect(f.deps.createGatewayCredential).not.toHaveBeenCalled()
  })
})

function discoveryDatabase(definitions: ToolDefinition[], configure?: (profile: AgentDefinition) => void) {
  const profile: AgentDefinition = {
    id: 'builder-id', user_id: 'owner', name: 'builder', description: '', mode: 'primary', prompt: '', system_prompt: '', enabled: true,
    model: '', thinking: 'off', approval_mode: 'auto', policies: { builtin: {}, registered: {}, browser: true, memory: true, subagent: false },
    project_overrides: {}, tool_context_modes: {}, skill_context_modes: {},
    effective_source: { model: 'agent', thinking: 'agent', approval: 'agent', tools: 'agent', skills: 'agent' },
  }
  configure?.(profile)
  return { collection(name: string) { return {
    async getFirstListItem(filter: string) {
      if (name === 'agents') return profile
      if (name === 'tool_registry') return definitions.find((tool) => tool.tool_id === /^tool_id = "([^"]+)"/.exec(filter)?.[1])
      throw new Error(name)
    },
    async getFullList() {
      if (name === 'agent_tool_policies') return []
      if (name === 'tool_registry') return definitions
      throw new Error(name)
    },
  } } } as unknown as PocketBase
}

function discoveryTool(id: string, description = 'Lookup'): ToolDefinition {
  return { tool_id: id, namespace: 'acme', description, adapter: 'openapi', target: 'https://example.test', operation: 'lookup', input_schema: { type: 'object' }, output_schema: {}, risk: 'read', requires_approval: false, enabled: true, metadata: {} }
}

describe('gateway parity progress: resolved discovery policy', () => {
  it.each(['list', 'search', 'describe'])('exposes no tools under durable none through real %s policy', async (operation) => {
    const client = discoveryDatabase([discoveryTool('acme/lookup')], (profile) => { profile.policies.registered['acme/lookup'] = true })
    const f = fixture(`/api/subpolar-cli/tools/${operation}`, { sessionId: 'session', toolId: 'acme/lookup', query: 'lookup', permissionOverride: 'allow_all', projectId: 'fake', agentName: 'master' }, 'POST', { client, realDiscovery: true })
    const response = (await handleToolsRoute(f.context))!
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject(operation === 'describe' ? { tool: null } : { tools: [] })
  })

  it.each(['list', 'search', 'describe'])('does not replace agent defaults with the resolver default for %s', async (operation) => {
    const client = discoveryDatabase([discoveryTool('acme/lookup')], (profile) => { profile.policies.registered['acme/lookup'] = true })
    const f = fixture(`/api/subpolar-cli/tools/${operation}`, { sessionId: 'session', toolId: 'acme/lookup', query: 'lookup', permissionOverride: 'none' }, 'POST', { client, realDiscovery: true })
    f.deps.resolveToolSessionContext.mockResolvedValueOnce({ sessionId: 'session', agentName: 'builder', cwd: '/persisted', permissionOverride: 'none', permission: { source: 'default' } })
    const response = (await handleToolsRoute(f.context))!
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject(operation === 'describe' ? { tool: { id: 'acme/lookup' } } : { tools: [operation === 'search' ? { tool: 'acme/lookup' } : { id: 'acme/lookup' }] })
  })

  it.each(['list', 'search', 'describe'])('checks the actual resolved agent rather than the stored profile or client hint for %s', async (operation) => {
    const f = fixture(`/api/subpolar-cli/tools/${operation}`, { sessionId: 'session', toolId: 'safe.echo', query: 'safe', agentName: 'builder' })
    f.deps.resolveToolSessionContext.mockResolvedValueOnce({ sessionId: 'session', agentName: 'master', cwd: '/persisted', permissionOverride: 'allow_all', permission: { source: 'session' } })
    expect((await handleToolsRoute(f.context))!.status).toBe(403)
    expect(f.deps.listToolsForAgent).not.toHaveBeenCalled()
    expect(f.deps.searchToolsForAgent).not.toHaveBeenCalled()
    expect(f.deps.describeToolForAgent).not.toHaveBeenCalled()
  })

  it.each(['list', 'search', 'describe'])('authorizes the resolved project rather than a stale persisted fallback for %s', async (operation) => {
    const f = fixture(`/api/subpolar-cli/tools/${operation}`, { sessionId: 'session', toolId: 'safe.echo', query: 'safe' })
    f.deps.resolveToolSessionContext.mockResolvedValueOnce({ sessionId: 'session', agentName: 'builder', project: { id: 'different-project' }, cwd: '/persisted', permissionOverride: 'allow_all', permission: { source: 'session' } })
    expect((await handleToolsRoute(f.context))!.status).toBe(403)
    expect(f.deps.listToolsForAgent).not.toHaveBeenCalled()
    expect(f.deps.searchToolsForAgent).not.toHaveBeenCalled()
    expect(f.deps.describeToolForAgent).not.toHaveBeenCalled()
  })

  it('ranks the effective permitted candidates before the full cap, including candidates absent from baseline search', async () => {
    const hidden = Array.from({ length: 14 }, (_, i) => discoveryTool(`acme/lookup-hidden-${i}`))
    const allowed = Array.from({ length: 14 }, (_, i) => discoveryTool(`acme/allowed-${String(i).padStart(2, '0')}`, 'Lookup'))
    const best = discoveryTool('acme/lookup-best')
    const client = discoveryDatabase([...hidden, ...allowed, best], (profile) => {
      for (const tool of [...hidden, ...allowed, best]) profile.tool_context_modes[tool.tool_id] = 'always'
      profile.project_overrides.project = { tools: Object.fromEntries(hidden.map((tool) => [tool.tool_id, 'disabled' as const])) }
    })
    expect(await searchToolsForAgent(client, 'owner', 'builder', 'lookup')).toEqual([])
    const f = fixture('/api/subpolar-cli/tools/search', { sessionId: 'session', query: 'lookup', projectId: 'fake', permissionOverride: 'none' }, 'POST', { client, realDiscovery: true })
    f.deps.resolveToolSessionContext.mockResolvedValueOnce({ sessionId: 'session', agentName: 'builder', project: { id: 'project' }, cwd: '/persisted', permissionOverride: 'allow_all', permission: { source: 'session' } })
    const response = (await handleToolsRoute(f.context))!
    expect(response.status).toBe(200)
    const body = await response.json() as { tools: Array<{ tool: string }> }
    expect(body.tools.map((tool) => tool.tool)).toEqual([best.tool_id, ...allowed.slice(0, 11).map((tool) => tool.tool_id)])
    expect(f.deps.listToolsForAgent).not.toHaveBeenCalled()
  })

  it('keeps project capability ceilings authoritative even with allow_all', async () => {
    const definitions = [discoveryTool('acme/allowed'), discoveryTool('acme/denied'), discoveryTool('acme/disabled')]
    const client = discoveryDatabase(definitions, (profile) => {
      profile.tool_context_modes = { 'acme/allowed': 'always', 'acme/denied': 'always', 'acme/disabled': 'disabled' }
      profile.policies.registered['acme/denied'] = false
      profile.project_overrides.project = { tools: { 'acme/disabled': 'always' }, policies: { registered: { 'acme/denied': true } } }
    })
    expect((await searchToolsForAgent(client, 'owner', 'builder', 'lookup', 'project', 'allow_all')).map((tool) => tool.tool)).toEqual(['acme/allowed'])
  })

  it('preserves standard on-demand exclusion and explicit list/describe discovery', async () => {
    const client = discoveryDatabase([discoveryTool('acme/lookup')], (profile) => {
      profile.tool_context_modes['acme/lookup'] = 'on-demand'
      profile.policies.registered['acme/lookup'] = true
    })
    expect(await searchToolsForAgent(client, 'owner', 'builder', 'lookup')).toEqual([])
    expect(await searchToolsForAgent(client, 'owner', 'builder', 'lookup', 'project', undefined, true)).toMatchObject([{ tool: 'acme/lookup' }])
    for (const operation of ['list', 'search', 'describe']) {
      const f = fixture(`/api/subpolar-cli/tools/${operation}`, { sessionId: 'session', query: 'lookup', toolId: 'acme/lookup' }, 'POST', { client, realDiscovery: true })
      f.deps.resolveToolSessionContext.mockResolvedValueOnce({ sessionId: 'session', agentName: 'builder', cwd: '/persisted', permissionOverride: 'ask', permission: { source: 'default' } })
      const response = (await handleToolsRoute(f.context))!
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject(operation === 'search' ? { tools: [] } : operation === 'list' ? { tools: [{ id: 'acme/lookup', requiresApproval: false }] } : { tool: { id: 'acme/lookup', requiresApproval: false } })
    }
  })

  it.each(['/api/permission?sessionId=session', '/api/session/session/permissions/approval'])('retains legacy scoped credential permission checks at %s', async (path) => {
    const method = path.startsWith('/api/permission?') ? 'GET' : 'POST'
    const f = fixture(path, { response: 'approve' }, method)
    const context = { ...(f.context as unknown as Record<string, unknown>), gatewayCredential: { ...credential, permissions: ['list'] } }
    expect((await handleToolsRoute(context as never))!.status).toBe(403)
    expect(f.deps.listPendingCoreApprovals).not.toHaveBeenCalled()
    expect(f.deps.respondToCoreApproval).not.toHaveBeenCalled()
  })
})

describe('gateway parity progress: existing core authority', () => {
  const definition = { id: 'safe.echo', namespace: 'safe', description: 'Echo', inputSchema: {}, enabled: true, risk: 'low' as const }
  const context = { requestId: 'request', principal: { id: 'owner', kind: 'user' as const }, sessionId: 'session' }

  it('deny wins over approval and allow without executing or creating an approval', async () => {
    const execute = vi.fn(async () => ({ ok: true as const, value: 'unsafe' }))
    const create = vi.fn()
    const gateway = createPolicyGateway({ tools: [definition], resolvePolicy: () => ({ deny: true, allow: true, requiresApproval: true }), execute, approvalStore: { create, load: async () => undefined, decide: vi.fn() } })
    expect(await gateway.call({ callId: 'deny', toolId: definition.id, input: {} }, context)).toMatchObject({ ok: false, status: 'denied' })
    expect(execute).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
  })

  it('pending then approved retries execute once and redact input/output audit, including encoded credentials', async () => {
    let approval: ApprovalRecord | undefined
    const events: unknown[] = []
    const execute = vi.fn(async () => ({ ok: true as const, value: { token: 'output-secret', safe: 'visible' } }))
    const gateway = createPolicyGateway({
      tools: [definition], resolvePolicy: () => ({ allow: true, requiresApproval: true }), execute,
      approvalStore: {
        load: async () => approval,
        create: async (request) => (approval = { approvalId: request.approvalId, callId: request.call.callId, toolId: request.call.toolId, status: 'pending' as const, createdAt: new Date().toISOString(), request: {} }),
        decide: async () => approval!,
      },
      emitEvent: (event) => { events.push(event) },
    })
    const call = { callId: 'original', toolId: definition.id, input: { password: 'input-secret', payload: '{"apiKey":"encoded-secret"}' }, idempotencyKey: 'tool-call:original' }
    expect(await gateway.call(call, context)).toMatchObject({ status: 'approval_required' })
    expect(execute).not.toHaveBeenCalled()
    approval!.status = 'approved'
    const results = await Promise.all([gateway.call(call, context), gateway.call(call, context)])
    expect(results[0]).toMatchObject({ ok: true, status: 'executed' })
    expect(results[1]).toEqual(results[0])
    expect(await gateway.call(call, context)).toEqual(results[0])
    expect(execute).toHaveBeenCalledTimes(1)
    const audit = JSON.stringify(events)
    for (const secret of ['input-secret', 'output-secret', 'encoded-secret']) expect(audit).not.toContain(secret)
    expect(audit).toContain('visible')
    expect(audit).toContain('[REDACTED]')
  })
})

describe('gateway parity progress: scoped CLI', () => {
  it.each(['list', 'query', 'describe'])('forwards discovery session scope for %s', async (command) => {
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ tools: [] }))
    const args = command === 'list' ? [] : [command === 'query' ? 'safe' : 'safe.echo']
    expect(await runCli([command, ...args, '--session-id', 'session', '--token', 'test-token', '--json'], { fetch: fetcher }, { stdout: () => undefined })).toBe(0)
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]?.body))).toMatchObject({ sessionId: 'session' })
  })

  it.each([['GATEWAY_TOKEN_INVALID', 401], ['GATEWAY_TOKEN_EXPIRED', 403], ['GATEWAY_TOKEN_REVOKED', 403], ['GATEWAY_PERMISSION_DENIED', 403], ['GATEWAY_SCOPE_DENIED', 403]] as const)('preserves structured %s without leaking response credentials', async (code, status) => {
    const lines: string[] = []
    const exit = await runCli(['list', '--token', 'offline-scoped-secret', '--json'], { fetch: async () => Response.json({ error: { code, message: 'Bearer offline-scoped-secret', details: { authorization: 'other-secret' } } }, { status }) }, { stdout: (line) => lines.push(line) })
    expect(exit).toBe(EXIT_REMOTE)
    expect(JSON.parse(lines.join('')).error).toMatchObject({ code, status })
    expect(lines.join('')).not.toContain('offline-scoped-secret')
    expect(lines.join('')).not.toContain('other-secret')
  })

  it('preserves core approval_required 202 as pending rather than a generic remote error', async () => {
    const lines: string[] = []
    const exit = await runCli(['call', 'safe.echo', '--session-id', 'session', '--token', 'offline-scoped-secret', '--json', '--input', '{}'], { fetch: async () => Response.json({ ok: false, status: 'approval_required', approvalId: 'approval', error: { code: 'APPROVAL_REQUIRED' } }, { status: 202 }) }, { stdout: (line) => lines.push(line) })
    expect(exit).toBe(EXIT_REMOTE)
    expect(JSON.parse(lines.join(''))).toMatchObject({ ok: true, result: { status: 'approval_required', approvalId: 'approval' } })
  })
})
