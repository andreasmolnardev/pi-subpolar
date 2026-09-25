/* Domain route extracted from bridge-request-handler.ts. */
// @ts-nocheck
import type { BridgeRequestContext } from '../bridge-route-context.ts'

export async function handleToolsRoute(context: BridgeRequestContext): Promise<Response | undefined> {
  const { request, url, path, correlationId, deps, gatewayCredential, internalRequest } = context
  let authenticatedUser = context.authenticatedUser
  if (path[1] === 'pi' && path[2] === 'tools' && path[3] === 'authorize' && request.method === 'POST') {
    const input = await deps.body(request)
    const sessionId = typeof input.sessionId === 'string' ? input.sessionId.trim() : ''
    if (!sessionId) return deps.json({ ok: false, decision: 'deny', message: 'An authenticated owned session is required' }, 401)
    try {
      const client = await deps.applicationDatabase()
      const session = await deps.createProjectSessionRepository(client).getSessionById(sessionId)
      // Internal Pi calls have no browser cookie, but ownership still comes
      // from the durable PocketBase session record, never from process-local
      // session state or a caller-supplied userId.
      if (!session || (authenticatedUser && session.userId !== authenticatedUser.id)) return deps.json({ ok: false, decision: 'deny', message: 'Session not found' }, 404)
      const userId = session.userId
      const requestedOverride = deps.requestedPermissionOverride(input.permissionOverride)
      if (requestedOverride === null) return deps.json({ ok: false, decision: 'deny', message: 'Invalid permission override' }, 400)
      const context = await deps.resolveToolSessionContext(client, userId, sessionId, typeof input.agentName === 'string' ? input.agentName : undefined)
      if (requestedOverride !== undefined && requestedOverride !== context.permissionOverride) {
        return deps.json({ ok: false, decision: 'deny', message: 'Permission override does not match the persisted session policy' }, 403)
      }
      const result = await deps.authorizePiToolCall(client, {
        userId,
        agentName: context.agentName,
        sessionId,
        toolName: typeof input.toolName === 'string' ? input.toolName : '',
        input: input.input ?? {},
        permissionOverride: context.permissionOverride,
      })
      if (result.decision !== 'approval') return deps.json(result)

      deps.broadcastSse({
        type: 'permission.asked',
        directory: typeof input.cwd === 'string' ? input.cwd : undefined,
          properties: deps.permissionAskedProperties({ id: result.approvalId ?? '', sessionId, toolId: deps.mapToolId(input.toolName), input: input.input ?? {}, reason: result.message ?? 'Tool approval required' }),
      }, userId)
      return deps.json({ ok: false, decision: 'approval', approvalId: result.approvalId, message: result.message }, 202)
    } catch (error) {
      console.warn(`Tool authorization failed: ${deps.redactedDiagnostic(error)}`)
      return deps.json({ ok: false, decision: 'deny', message: 'Tool authorization failed' }, 503)
    }
  }

  if (path[1] === 'subpolar-cli' && path[2] === 'tools' && request.method === 'POST') {
    const input = await deps.body(request)
    const userId = authenticatedUser?.id ?? gatewayCredential?.ownerId
      ?? (internalRequest && typeof input.userId === 'string' ? input.userId : undefined)
      ?? (internalRequest && path[3] === 'register' ? 'system' : undefined)
    if (!userId) return deps.json({ error: 'A user identity is required' }, 401)
    try {
      const client = await deps.applicationDatabase()
      if (userId !== 'system') await deps.ensureUserMetadata(userId)
      const agentName = typeof input.agentName === 'string' ? input.agentName : 'master'

      if (path[3] === 'register') {
        if (gatewayCredential) deps.assertGatewayAccess(gatewayCredential, 'add', { agentName, ...(typeof input.projectId === 'string' ? { projectId: input.projectId } : {}) })
        else if (!internalRequest) return deps.json({ error: { code: 'GATEWAY_PERMISSION_DENIED', message: 'Tool registration requires an authorized gateway credential' } }, 403)
        if (typeof input.toolId !== 'string' || typeof input.namespace !== 'string' || typeof input.description !== 'string') return deps.json({ error: 'toolId, namespace, and description are required' }, 400)
        const adapter = input.adapter === 'http' || input.adapter === 'openapi' || input.adapter === 'mcp' ? input.adapter : 'internal'
        const risk = input.risk === 'write' || input.risk === 'delete' || input.risk === 'external' ? input.risk : 'read'
        const tool = await deps.upsertRegisteredTool(client, {
          tool_id: input.toolId,
          namespace: input.namespace,
          description: input.description,
          adapter,
          target: typeof input.target === 'string' ? input.target : '',
          operation: typeof input.operation === 'string' ? input.operation : '',
          input_schema: deps.object(input.inputSchema),
          output_schema: deps.object(input.outputSchema),
          risk,
          requires_approval: input.requiresApproval === true,
          enabled: input.enabled !== false,
          metadata: deps.object(input.metadata),
        })
        return deps.json({ tool })
      }

      if (path[3] === 'list') {
        if (gatewayCredential) deps.assertGatewayAccess(gatewayCredential, 'list', { agentName })
        return deps.json({ tools: await deps.listToolsForAgent(client, userId, agentName) })
      }
      if (path[3] === 'search') {
        if (gatewayCredential) deps.assertGatewayAccess(gatewayCredential, 'query', { agentName })
        if (typeof input.query !== 'string' || !input.query.trim()) return deps.json({ error: 'A non-empty query is required' }, 400)
        const tools = await deps.searchToolsForAgent(client, userId, agentName, input.query)
        return deps.json({ tools, columns: ['tool', 'description', 'usage'] })
      }
      if (path[3] === 'describe' && typeof input.toolId === 'string') {
        if (gatewayCredential) deps.assertGatewayAccess(gatewayCredential, 'describe', { agentName })
        return deps.json({ tool: await deps.describeToolForAgent(client, userId, agentName, input.toolId) })
      }
      if (path[3] === 'call' && typeof input.toolId === 'string') {
        const sessionId = typeof input.sessionId === 'string' && input.sessionId.trim() ? input.sessionId : undefined
        if (gatewayCredential) deps.assertGatewayAccess(gatewayCredential, 'call', { agentName, ...(sessionId ? { sessionId } : {}) })
        if (!sessionId || userId === 'system') return deps.json({ error: 'A valid sessionId is required for tool execution' }, 400)
        const persistedSession = await deps.createProjectSessionRepository(client).getSessionById(sessionId)
        if (!persistedSession || persistedSession.userId !== userId) return deps.json({ error: 'Session not found' }, 404)
        if (gatewayCredential) deps.assertGatewayAccess(gatewayCredential, 'call', { agentName, sessionId, ...(persistedSession.projectId ? { projectId: persistedSession.projectId } : {}) })
        const executionUserId = persistedSession.userId
        if (authenticatedUser && authenticatedUser.id !== executionUserId) return deps.json({ error: 'Session not found' }, 404)
        if (typeof input.userId === 'string' && input.userId !== executionUserId) return deps.json({ error: 'Identity assertion does not match the session owner' }, 403)
        const requestedOverride = deps.requestedPermissionOverride(input.permissionOverride)
        if (requestedOverride === null) return deps.json({ error: 'Invalid permission override' }, 400)
        const context = await deps.resolveToolSessionContext(client, executionUserId, sessionId, typeof input.agentName === 'string' ? input.agentName : undefined)
        if (requestedOverride !== undefined && requestedOverride !== context.permissionOverride) return deps.json({ error: 'Permission override does not match the persisted session policy' }, 403)
        const gateway = deps.inProcessToolGateway ?? deps.createToolGatewayFromCallTool(client, deps.callTool)
        const result = await gateway.call(
          { toolId: input.toolId, input: input.input ?? {} },
          {
            userId: context.identity.userId,
            agentName: context.agentName,
            sessionId: context.sessionId,
            cwd: context.cwd,
            callId: typeof input.callId === 'string' ? input.callId : crypto.randomUUID(),
            permissionOverride: context.permission.source === 'default' ? undefined : context.permissionOverride,
            waitForApproval: false,
            onApproval: (approval) => {
              deps.broadcastSse({
                type: 'permission.asked',
                directory: context.cwd,
                properties: deps.permissionAskedProperties({ id: approval.id, sessionId: approval.session_id, toolId: approval.tool_id, input: approval.input, reason: approval.reason }),
              }, context.identity.userId)
            },
          },
        )
         return deps.json(deps.redactSensitive(result), result.ok || !('approvalRequired' in result) ? 200 : 202)
      }
      if (path[3] === 'continue' && typeof input.approvalId === 'string') {
        if (gatewayCredential) deps.assertGatewayAccess(gatewayCredential, 'approvals', { ...(typeof input.sessionId === 'string' ? { sessionId: input.sessionId } : {}) })
        if (userId === 'system') return deps.json({ error: 'An authenticated user is required' }, 401)
        const sessionId = typeof input.sessionId === 'string' ? input.sessionId : undefined
        const session = sessionId ? await deps.createProjectSessionRepository(client).getSessionById(sessionId) : null
        if (session && session.userId !== userId) return deps.json({ error: 'Session not found' }, 404)
        if (!sessionId || !session) return deps.json({ error: 'An owned session is required' }, 404)
        const result = await deps.continueApprovedTool(client, session.userId, input.approvalId, { sessionId: session.id, cwd: session.directory, callId: typeof input.callId === 'string' ? input.callId : crypto.randomUUID() })
         return deps.json(deps.redactSensitive(result), 'approvalRequired' in result && result.approvalRequired ? 202 : 200)
      }
      return deps.json({ error: 'Unknown tool gateway operation' }, 404)
    } catch (error) {
      if (error instanceof deps.GatewayAuthError) return deps.json({ error: { code: error.code, message: error.message } }, error.code === 'GATEWAY_PERMISSION_DENIED' || error.code === 'GATEWAY_SCOPE_DENIED' ? 403 : 401)
      console.warn(`Tool gateway request failed: ${deps.redactedDiagnostic(error)}`)
      return deps.json({ error: 'Tool gateway unavailable' }, 503)
    }
  }

  if (path[1] === 'question' && request.method === 'GET') {
    // Questions are delivered through the session SSE stream. Keep the
    // legacy polling endpoint for clients that use it during startup.
    return deps.json([])
  }

  if (path[1] === 'permission' && request.method === 'GET') {
    if (gatewayCredential) {
      const denied = (() => { try { deps.assertGatewayAccess(gatewayCredential!, 'approvals', { ...(url.searchParams.get('sessionId') ? { sessionId: url.searchParams.get('sessionId')! } : {}) }); return null } catch (error) { return deps.gatewayErrorResponse(error) } })()
      if (denied) return denied
    }
    const permissionUserId = authenticatedUser?.id ?? gatewayCredential?.ownerId
    if (!permissionUserId) return deps.json({ message: 'Unauthorized' }, 401)
    try {
      const approvals = await deps.listPendingApprovals(await deps.applicationDatabase(), permissionUserId, url.searchParams.get('sessionId') ?? undefined)
      return deps.json(approvals.map((approval) => deps.permissionAskedProperties({ id: approval.id, sessionId: approval.session_id, toolId: approval.tool_id, input: approval.input, reason: approval.reason })))
    } catch (error) { console.warn(`Approval store request failed: ${deps.redactedDiagnostic(error)}`); return deps.json({ message: 'Approval store unavailable' }, 503) }
  }

  if (path[1] === 'session' && path[3] === 'permissions' && path[4] && request.method === 'POST') {
    if (gatewayCredential) {
      const denied = deps.gatewayErrorResponse((() => { try { deps.assertGatewayAccess(gatewayCredential!, 'approvals', { sessionId: decodeURIComponent(path[2] ?? '') }); return null } catch (error) { return error } })())
      if (denied) return denied
    }
    const permissionUserId = authenticatedUser?.id ?? gatewayCredential?.ownerId
    if (!permissionUserId) return deps.json({ message: 'Unauthorized' }, 401)
    const input = await deps.body(request)
    const responseValue = input.response
    if (responseValue !== 'approve' && responseValue !== 'approved' && responseValue !== 'once' && responseValue !== 'always' && responseValue !== 'reject' && responseValue !== 'rejected' && responseValue !== true && responseValue !== false) {
      return deps.json({ message: 'Approval response must be approve or reject' }, 400)
    }
    const decision = responseValue === 'once' || responseValue === 'always' ? 'approve' : responseValue
    const approved = decision === true || decision === 'approve' || decision === 'approved'
    const sessionId = decodeURIComponent(path[2] ?? '')
    if (!sessionId) return deps.json({ message: 'Session not found' }, 404)
    const client = await deps.applicationDatabase()
    const approval = await deps.respondToApproval(client, permissionUserId, decodeURIComponent(path[4]), decision, sessionId)
    if (!approval) return deps.json({ message: 'Approval not found' }, 404)
    if (!approved) return deps.json({ ok: true, approval })
    const session = await deps.createProjectSessionRepository(client).getSession(permissionUserId, sessionId)
    if (!session) return deps.json({ ok: true, approval, result: { ok: false, error: { code: 'SESSION_NOT_FOUND', message: 'Session not found' } } }, 404)
    const result = await deps.continueApprovedTool(client, permissionUserId, approval.id, { sessionId: session.id, cwd: session.directory, callId: crypto.randomUUID() })
    return deps.json({ ok: true, approval, result })
  }
  return undefined
}
