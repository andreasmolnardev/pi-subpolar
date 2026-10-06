import { describe, expect, it, vi } from 'vitest'
import { createBridgeRequestHandler } from '../bridge-request-handler.ts'
import { handleLegacyRoute } from '../routes/legacy.ts'
import { assertGatewayAccess, GatewayAuthError, type GatewayCredentialAuth } from '../persistence/gateway-credentials.ts'

function credential(scope: GatewayCredentialAuth['scope'] = {}): GatewayCredentialAuth {
  return { id: 'credential', tokenId: 'token', ownerId: 'owner', principal: 'cli', prefix: 'stub', permissions: ['list', 'events', 'approvals', 'call'], scope, createdAt: 0 }
}

function fixture(auth = credential()) {
  const session = { id: 'session', userId: 'owner', projectId: 'project', profile: 'agent-id' }
  const deps = {
    requestId: () => 'request', internalToken: 'test-internal',
    json: (body: unknown, status = 200) => Response.json(body, { status }),
    GatewayAuthError, assertGatewayAccess: vi.fn(assertGatewayAccess),
    gatewayErrorResponse: (error: GatewayAuthError) => Response.json({ error: { code: error.code } }, { status: 403 }),
    applicationDatabase: vi.fn(async () => ({})),
    authenticateGatewayCredential: vi.fn(async () => auth as GatewayCredentialAuth | null),
    authenticateRequest: vi.fn(async () => ({ id: 'cookie-owner' })),
    createProjectSessionRepository: () => ({ getSessionById: vi.fn(async () => session) }),
    listAgents: vi.fn(async () => [{ id: 'agent-id', name: 'worker', enabled: true }]),
        resolveToolSessionContext: vi.fn(async () => ({ sessionId: session.id, agentName: 'worker', project: { id: session.projectId }, permissionOverride: 'ask', permission: { source: 'default' } })),
        redactedDiagnostic: () => 'redacted',
    runtimeStore: vi.fn(async () => ({ replayEvents: vi.fn(async (_owner: string, _after: string | null) => ({ reset: false, events: [] as Array<{ id: number; ownerId: string; sessionId: string | null; payload: unknown }> })) })),
    sseClients: new Set<{ userId: string; enqueue: (chunk: Uint8Array) => void; close: () => void }>(),
    encoder: new TextEncoder(), active: new Map(),
    body: async (request: Request) => request.json(), ensureUserMetadata: vi.fn(),
    listToolsForAgent: vi.fn(async (_database: unknown, _ownerId: string) => []),
        listPendingCoreApprovals: vi.fn(async () => []), redactSensitive: (value: unknown) => value,
    voiceAuthorization: vi.fn(async (_request: Request, _user: unknown, auth: GatewayCredentialAuth | null) => {
      if (auth) assertGatewayAccess(auth, 'call', { sessionId: session.id, projectId: session.projectId, agentName: 'worker' })
      return { sessionId: session.id }
    }),
    handleVoiceRoute: vi.fn(async () => Response.json({ ok: true })), voiceBackends: {},
  }
  const handle = createBridgeRequestHandler(deps)
  const request = (path: string, method = 'GET', body?: unknown, authorization = 'Bearer subpolar_gw_stub') => new Request(`http://local${path}`, {
    method, headers: { authorization, cookie: 'test-cookie', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { deps, handle, request, session }
}

describe('gateway principal dispatch boundary', () => {
  it.each([
    ['GET', '/api/providers'], ['POST', '/api/projects'], ['GET', '/api/settings'],
    ['GET', '/api/sessions/session'], ['GET', '/api/session/session'], ['GET', '/api/agents'],
    ['GET', '/api/gateway/credentials'], ['POST', '/api/gateway/credentials/id/rotate'],
    ['GET', '/api/auth/session'], ['POST', '/api/auth/login'], ['GET', '/api/runtime'],
    ['GET', '/api/extensions/projects'], ['POST', '/api/sse/subscribe'],
    ['GET', '/api/question'], ['GET', '/api/subpolar-cli/tools/list'],
    ['POST', '/api/subpolar-cli/tools/list/extra'], ['GET', '/api/permission/extra'],
    ['POST', '/api/session/session/permissions/approval/extra'], ['GET', '/api/tts/unknown'],
    ['POST', '/not-api'],
  ])('denies %s %s without cookie fallback or dispatch', async (method, path) => {
    const { handle, request, deps } = fixture()
    const response = await handle(request(path, method))
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ error: { code: 'GATEWAY_ROUTE_DENIED' } })
    expect(deps.authenticateRequest).not.toHaveBeenCalled()
    expect(deps.runtimeStore).not.toHaveBeenCalled()
    expect(deps.body).toBeDefined()
  })

  it('does not fall back to cookie identity for invalid or unavailable credentials', async () => {
    for (const failure of [new GatewayAuthError('GATEWAY_TOKEN_INVALID'), new Error('database offline'), null]) {
      const { handle, request, deps } = fixture()
      deps.authenticateGatewayCredential.mockImplementation(async () => { if (failure) throw failure; return null })
      const response = await handle(request('/api/permission'))
      expect(response.status).toBe(failure instanceof Error && !(failure instanceof GatewayAuthError) ? 503 : 401)
      expect(deps.authenticateRequest).not.toHaveBeenCalled()
    }
  })

  it('keeps user and internal tool authentication unchanged', async () => {
    for (const bearer of ['Bearer user-token', 'Bearer test-internal']) {
      const { handle, request, deps } = fixture()
      const response = await handle(request('/api/subpolar-cli/tools/list', 'POST', { userId: 'internal-owner' }, bearer))
      expect(response.status).toBe(200)
      expect(deps.listToolsForAgent.mock.calls[0]?.[1]).toBe(bearer === 'Bearer user-token' ? 'cookie-owner' : 'internal-owner')
      expect(deps.authenticateGatewayCredential).not.toHaveBeenCalled()
      expect(deps.authenticateRequest).toHaveBeenCalledTimes(bearer === 'Bearer user-token' ? 1 : 0)
    }
  })

  it('dispatches supported tools with exact persisted scope and no cookie identity', async () => {
    const { handle, request, deps } = fixture(credential({ sessionIds: ['session'], projectIds: ['project'], agentNames: ['worker'] }))
    const response = await handle(request('/api/subpolar-cli/tools/list', 'POST', { sessionId: 'session' }))
    expect(response.status).toBe(200)
    expect(deps.assertGatewayAccess).toHaveBeenCalledWith(expect.objectContaining({ ownerId: 'owner' }), 'list', { sessionId: 'session', projectId: 'project', agentName: 'worker' })
    expect(deps.authenticateRequest).not.toHaveBeenCalled()
  })

  it('dispatches scoped approval listing and legacy responses without allowing general session access', async () => {
    const { handle, request, deps } = fixture(credential({ sessionIds: ['session'], projectIds: ['project'], agentNames: ['agent-id'] }))
    expect((await handle(request('/api/permission?sessionId=session'))).status).toBe(200)
    expect(deps.listPendingCoreApprovals).toHaveBeenCalledWith(expect.anything(), 'owner', 'session')
    // Invalid decision is rejected by the supported approval handler, not the
    // principal allowlist; no continuation or mutation is performed.
    const decision = await handle(request('/api/session/session/permissions/approval', 'POST', { response: 'invalid' }))
    expect(decision.status).toBe(400)
    expect(deps.authenticateRequest).not.toHaveBeenCalled()
  })

  it.each(['/api/stt/status', '/api/stt/models', '/api/tts/status', '/api/tts/models', '/api/tts/voices', '/api/stt/transcribe', '/api/tts/synthesize'])('dispatches only scoped-authorized voice %s', async (path) => {
    const method = path.endsWith('transcribe') || path.endsWith('synthesize') ? 'POST' : 'GET'
    const { handle, request, deps } = fixture(credential({ sessionIds: ['session'], projectIds: ['project'], agentNames: ['worker'] }))
    expect((await handle(request(`${path}?sessionId=session`, method))).status).toBe(200)
    expect(deps.voiceAuthorization).toHaveBeenCalledWith(expect.any(Request), null, expect.objectContaining({ ownerId: 'owner' }), false)
    expect(deps.authenticateRequest).not.toHaveBeenCalled()
    const denied = fixture(credential({ sessionIds: ['other'] }))
    expect((await denied.handle(denied.request(`${path}?sessionId=session`, method))).status).toBe(403)
    expect(denied.deps.handleVoiceRoute).not.toHaveBeenCalled()
  })
})

describe('gateway events persisted scope and delivery', () => {
  it.each([{ sessionIds: ['session'] }, { projectIds: ['project'] }, { agentNames: ['worker'] }])('fails closed without session context for %j', async (scope) => {
    const { handle, request, deps } = fixture(credential(scope))
    const response = await handle(request('/api/sse/stream?projectId=project&agentName=worker'))
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ error: { code: 'GATEWAY_SCOPE_DENIED' } })
    expect(deps.runtimeStore).not.toHaveBeenCalled()
  })

  it('denies cross-user sessions before scope check or replay', async () => {
    const { handle, request, deps, session } = fixture()
    session.userId = 'other-owner'
    expect((await handle(request('/api/sse/stream?sessionId=session'))).status).toBe(404)
    expect(deps.assertGatewayAccess).not.toHaveBeenCalled()
    expect(deps.runtimeStore).not.toHaveBeenCalled()
  })

  it.each([{ sessionIds: ['wrong'] }, { projectIds: ['wrong'] }, { agentNames: ['wrong'] }])('rejects mismatched persisted scope %j', async (scope) => {
    const { handle, request, deps } = fixture(credential(scope))
    expect((await handle(request('/api/sse/stream?sessionId=session&projectId=wrong&agentName=wrong'))).status).toBe(403)
    expect(deps.runtimeStore).not.toHaveBeenCalled()
  })

  it('checks events permission and denies unavailable agent/context', async () => {
    const auth = credential(); auth.permissions = ['call']
    const denied = fixture(auth)
    expect((await denied.handle(denied.request('/api/sse/stream'))).status).toBe(403)
    const disabled = fixture()
    disabled.deps.listAgents.mockResolvedValue([{ id: 'agent-id', name: 'worker', enabled: false }])
    expect((await disabled.handle(disabled.request('/api/sse/stream?sessionId=session'))).status).toBe(403)
    const offline = fixture()
    offline.deps.listAgents.mockRejectedValue(new Error('offline'))
    expect((await offline.handle(offline.request('/api/sse/stream?sessionId=session'))).status).toBe(503)
  })

  it('uses credential owner and exact persisted scope; filters replay and live frames', async () => {
    const auth = credential({ projectIds: ['project'], agentNames: ['worker'], sessionIds: ['session'] })
    const { deps, request } = fixture(auth)
    const replayEvents = vi.fn(async () => ({ reset: false, events: [
      { id: 1, ownerId: 'owner', sessionId: 'session', payload: { marker: 'allowed-replay' } },
      { id: 2, ownerId: 'other-owner', sessionId: 'session', payload: { marker: 'cross-owner' } },
      { id: 3, ownerId: 'owner', sessionId: 'other-session', payload: { marker: 'cross-session' } },
      { id: 4, ownerId: 'owner', sessionId: null, payload: { marker: 'unscoped' } },
    ] }))
    deps.runtimeStore.mockResolvedValue({ replayEvents })
    const req = request('/api/sse/stream?sessionId=session&after=12')
    const response = await handleLegacyRoute({ request: req, url: new URL(req.url), path: ['api', 'sse', 'stream'], correlationId: 'request', deps, authenticatedUser: { id: 'cookie-owner' }, gatewayCredential: auth, internalRequest: false })
    expect(response?.status).toBe(200)
    expect(replayEvents).toHaveBeenCalledWith('owner', '12')
    expect(deps.assertGatewayAccess).toHaveBeenCalledWith(auth, 'events', { sessionId: 'session', projectId: 'project', agentName: 'worker' })
    const reader = response!.body!.getReader()
    let text = new TextDecoder().decode((await reader.read()).value)
    text += new TextDecoder().decode((await reader.read()).value)
    const client = [...deps.sseClients][0]!
    expect(client.userId).toBe('owner')
    const frame = (sessionID?: string, marker = 'rejected-live') => deps.encoder.encode(`id: 20\ndata: ${JSON.stringify({ properties: { sessionID }, marker })}\n\n`)
    client.enqueue(frame('other-session'))
    client.enqueue(frame())
    client.enqueue(deps.encoder.encode('data: invalid\n\n'))
    client.enqueue(deps.encoder.encode('event: connected\ndata: {}\n\n'))
    client.enqueue(frame('session', 'allowed-live'))
    text += new TextDecoder().decode((await reader.read()).value)
    expect(text).toContain('allowed-replay')
    expect(text).toContain('allowed-live')
    for (const marker of ['cross-owner', 'cross-session', 'unscoped', 'rejected-live', 'invalid']) expect(text).not.toContain(marker)
    await reader.cancel()
    expect(deps.sseClients.size).toBe(0)
  })

  it('preserves owner-wide unscoped subscriptions', async () => {
    const { handle, request, deps } = fixture()
    const response = await handle(request('/api/sse/stream'))
    expect(response.status).toBe(200)
    const reader = response.body!.getReader()
    await reader.read()
    const client = [...deps.sseClients][0]!
    client.enqueue(deps.encoder.encode('data: {"marker":"owner-wide"}\n\n'))
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('owner-wide')
    await reader.cancel()
  })
})
