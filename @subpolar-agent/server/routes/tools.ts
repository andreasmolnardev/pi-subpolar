/* Domain route extracted from bridge-request-handler.ts. */
// @ts-nocheck
import type { BridgeRequestContext } from '../bridge-route-context.ts'

async function ownedGatewaySession(deps: any, client: any, userId: string, sessionId?: string) {
  if (!sessionId) return null
  const session = await deps.createProjectSessionRepository(client).getSessionById(sessionId)
  return session?.userId === userId ? session : null
}

function sessionScope(session: any, agentName?: string) {
  return {
    agentName: agentName ?? session?.profile ?? 'master',
    ...(session ? { sessionId: session.id } : {}),
    ...(session?.projectId ? { projectId: String(session.projectId) } : {}),
  }
}

export async function handleToolsRoute(context: BridgeRequestContext): Promise<Response | undefined> {
  const { request, url, path, correlationId, deps, gatewayCredential, internalRequest } = context
  let authenticatedUser = context.authenticatedUser

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
        // Registration mutates a global registry, not a project/session resource.
                if (gatewayCredential) deps.assertGatewayAccess(gatewayCredential, 'add', {})
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

      const sessionId = typeof input.sessionId === 'string' && input.sessionId.trim() ? input.sessionId : undefined
      const session = await ownedGatewaySession(deps, client, userId, sessionId)
      if (sessionId && !session) return deps.json({ error: 'Session not found' }, 404)
      if (['list', 'search', 'describe'].includes(path[3])) {
        const resolved = session ? await deps.resolveToolSessionContext(client, userId, session.id) : undefined
        const discoveryAgent = resolved?.agentName ?? agentName
        const projectId = resolved?.project?.id ?? session?.projectId
        const discoveryProject = projectId ? String(projectId) : undefined
        const permissionOverride = resolved && resolved.permission.source !== 'default' ? resolved.permissionOverride : undefined
        const discoveryPermission = { list: 'list', search: 'query', describe: 'describe' }[path[3]]
        if (gatewayCredential) deps.assertGatewayAccess(gatewayCredential, discoveryPermission, { ...sessionScope(session, discoveryAgent), ...(discoveryProject ? { projectId: discoveryProject } : {}) })
        if (path[3] === 'list') {
          return deps.json({ tools: await deps.listToolsForAgent(client, userId, discoveryAgent, discoveryProject, true, permissionOverride) })
        }
        if (path[3] === 'search') {
          if (typeof input.query !== 'string' || !input.query.trim()) return deps.json({ error: 'A non-empty query is required' }, 400)
          const tools = await deps.searchToolsForAgent(client, userId, discoveryAgent, input.query, discoveryProject, permissionOverride)
          return deps.json({ tools, columns: ['tool', 'description', 'usage'] })
        }
        if (typeof input.toolId === 'string') {
          return deps.json({ tool: await deps.describeToolForAgent(client, userId, discoveryAgent, input.toolId, discoveryProject, permissionOverride) })
        }
      }
      const effectiveAgentName = session?.profile ?? agentName
      const operationPermission = { call: 'call', continue: 'approvals' }[path[3]]
      if (gatewayCredential && operationPermission) deps.assertGatewayAccess(gatewayCredential, operationPermission, sessionScope(session, effectiveAgentName))
      if (path[3] === 'call' && typeof input.toolId === 'string') {
        if (!sessionId || userId === 'system') return deps.json({ error: 'A valid sessionId is required for tool execution' }, 400)
        const persistedSession = session
        const executionUserId = persistedSession.userId
        if (authenticatedUser && authenticatedUser.id !== executionUserId) return deps.json({ error: 'Session not found' }, 404)
        if (typeof input.userId === 'string' && input.userId !== executionUserId) return deps.json({ error: 'Identity assertion does not match the session owner' }, 403)
        const requestedOverride = deps.requestedPermissionOverride(input.permissionOverride)
        if (requestedOverride === null) return deps.json({ error: 'Invalid permission override' }, 400)
        const context = await deps.resolveToolSessionContext(client, executionUserId, sessionId, typeof input.agentName === 'string' ? input.agentName : undefined)
        if (requestedOverride !== undefined && requestedOverride !== context.permissionOverride) return deps.json({ error: 'Permission override does not match the persisted session policy' }, 403)
        if (gatewayCredential) deps.assertGatewayAccess(gatewayCredential, 'call', sessionScope(session, context.agentName))
        const callId = typeof input.callId === 'string' && input.callId.trim() ? input.callId : crypto.randomUUID()
        const gateway = await deps.createCoreToolGateway(client, executionUserId, {
          onApproval: (approval: any) => {
            const request = approval.request && typeof approval.request === 'object' ? approval.request : {}
            deps.broadcastSse({
              type: 'permission.asked',
              directory: context.cwd,
              properties: deps.permissionAskedProperties({ id: approval.approvalId, sessionId: request.sessionId ?? context.sessionId, toolId: approval.toolId, input: request.input, reason: approval.reason ?? 'Tool approval is required' }),
            }, executionUserId)
          },
        })
        const result = await gateway.call(
          { callId, toolId: input.toolId, input: input.input ?? {}, idempotencyKey: `tool-call:${callId}` },
          {
            requestId: callId,
            principal: { id: executionUserId, kind: 'user' },
            sessionId: context.sessionId,
            projectId: persistedSession.projectId ? String(persistedSession.projectId) : undefined,
            agentId: context.agentName,
            cwd: context.cwd,
            metadata: {
              agentName: context.agentName,
              ...(context.permission.source === 'default' ? {} : { permissionOverride: context.permissionOverride }),
              ...(Array.isArray(input.capabilities) ? { capabilities: input.capabilities.filter((value: unknown): value is string => typeof value === 'string').join(',') } : {}),
            },
          },
        )
         return deps.json(deps.redactSensitive(result), result.ok || result.status !== 'approval_required' ? 200 : 202)
      }
      if (path[3] === 'continue' && typeof input.approvalId === 'string') {
        if (userId === 'system') return deps.json({ error: 'An authenticated user is required' }, 401)
        if (!sessionId || !session) return deps.json({ error: 'An owned session is required' }, 404)
        const persistedContext = await deps.resolveToolSessionContext(client, userId, sessionId)
        if (gatewayCredential) deps.assertGatewayAccess(gatewayCredential, 'approvals', sessionScope(session, persistedContext.agentName))
        // Keep the approval's original call identity; a new caller ID must not bypass its claim.
        const result = await deps.continueCoreApprovedTool(client, userId, input.approvalId, { sessionId: session.id, cwd: persistedContext.cwd, agentName: persistedContext.agentName, projectId: session.projectId ? String(session.projectId) : undefined, ...(persistedContext.permission.source === 'default' ? {} : { permissionOverride: persistedContext.permissionOverride }) })
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
    const permissionUserId = authenticatedUser?.id ?? gatewayCredential?.ownerId
    if (!permissionUserId) return deps.json({ message: 'Unauthorized' }, 401)
    try {
      const client = await deps.applicationDatabase()
      const sessionId = url.searchParams.get('sessionId') || undefined
      const session = await ownedGatewaySession(deps, client, permissionUserId, sessionId)
      if (sessionId && !session) return deps.json({ message: 'Session not found' }, 404)
      if (gatewayCredential) deps.assertGatewayAccess(gatewayCredential, 'approvals', sessionScope(session))
      const approvals = await deps.listPendingCoreApprovals(client, permissionUserId, sessionId)
      return deps.json(deps.redactSensitive(approvals.map((approval) => deps.permissionAskedProperties({ id: approval.id, sessionId: approval.session_id, toolId: approval.tool_id, input: approval.input, reason: approval.reason }))))
    } catch (error) {
      if (error instanceof deps.GatewayAuthError) return deps.gatewayErrorResponse(error)
      console.warn(`Approval store request failed: ${deps.redactedDiagnostic(error)}`)
      return deps.json({ message: 'Approval store unavailable' }, 503)
    }
  }

  if (path[1] === 'session' && path[3] === 'permissions' && path[4] && request.method === 'POST') {
    const permissionUserId = authenticatedUser?.id ?? gatewayCredential?.ownerId
    if (!permissionUserId) return deps.json({ message: 'Unauthorized' }, 401)
    const input = await deps.body(request)
    const responseValue = input.response
    if (responseValue !== 'approve' && responseValue !== 'approved' && responseValue !== 'once' && responseValue !== 'always' && responseValue !== 'reject' && responseValue !== 'rejected' && responseValue !== true && responseValue !== false) {
      return deps.json({ message: 'Approval response must be approve or reject' }, 400)
    }
    const decision = responseValue === 'once' || responseValue === 'always' ? 'approve' : responseValue

    const sessionId = decodeURIComponent(path[2] ?? '')
    if (!sessionId) return deps.json({ message: 'Session not found' }, 404)
    const client = await deps.applicationDatabase()
    const session = await ownedGatewaySession(deps, client, permissionUserId, sessionId)
    if (!session) return deps.json({ message: 'Session not found' }, 404)
    if (gatewayCredential) {
      try { deps.assertGatewayAccess(gatewayCredential, 'approvals', sessionScope(session)) }
      catch (error) { return deps.gatewayErrorResponse(error) }
    }
    const approvalId = decodeURIComponent(path[4])
    const waiting = deps.hasPendingApprovalWaiter(approvalId)
    const approval = await deps.respondToCoreApproval(client, permissionUserId, approvalId, decision, sessionId)
    if (!approval) return deps.json({ message: 'Approval not found' }, 404)
    const approved = approval.status === 'approved'
    if (approved || approval.status === 'rejected') deps.notifyApprovalResolution(approval.id, approved ? 'approved' : 'rejected')
    if (!approved || waiting) return deps.json(deps.redactSensitive({ ok: true, approval }))
    const persistedContext = await deps.resolveToolSessionContext(client, permissionUserId, sessionId)
    const result = await deps.continueCoreApprovedTool(client, permissionUserId, approval.id, { sessionId: session.id, cwd: persistedContext.cwd, agentName: persistedContext.agentName, projectId: session.projectId ? String(session.projectId) : undefined, ...(persistedContext.permission.source === 'default' ? {} : { permissionOverride: persistedContext.permissionOverride }) })
    return deps.json(deps.redactSensitive({ ok: true, approval, result }))
  }
  return undefined
}
