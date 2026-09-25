/* Domain route extracted from bridge-request-handler.ts. */
// @ts-nocheck
import type { BridgeRequestContext } from '../bridge-route-context.ts'

export async function handleSessionsRoute(context: BridgeRequestContext): Promise<Response | undefined> {
  const { request, url, path, correlationId, deps, gatewayCredential, internalRequest } = context
  let authenticatedUser = context.authenticatedUser
  if (path[1] === 'sessions' && path.length === 2 && request.method === 'GET') {
    const client = await deps.applicationDatabase()
    await deps.ensureUserMetadata(authenticatedUser!.id)
    await deps.ensureNativeSessionMetadata(client, authenticatedUser!.id)
    const requestedCursor = url.searchParams.get('cursor')
    const cursor = requestedCursor ? deps.decodeSessionCursor(requestedCursor) : null
    if (requestedCursor && !cursor) return deps.json({ error: 'Invalid session cursor' }, 400)
    const project = cursor?.project ?? url.searchParams.get('project') ?? undefined
    const requestedDirectory = cursor?.directory ?? url.searchParams.get('directory') ?? undefined
    const search = (cursor?.search ?? url.searchParams.get('search')?.trim().toLocaleLowerCase() ?? '').slice(0, deps.SESSION_SEARCH_MAX_LENGTH)
    const order = cursor?.order ?? (url.searchParams.get('order') === 'asc' ? 'asc' : 'desc')
    const limit = cursor ? deps.sessionPageLimit(String(cursor.limit)) : deps.sessionPageLimit(url.searchParams.get('limit'))
    const repository = deps.createProjectSessionRepository(client)
    const userProjects = await repository.listProjects(authenticatedUser!.id)
    const owned = await repository.listSessions(authenticatedUser!.id, { project, includeArchived: true })
    const records = owned.map((session) => {
      const local = deps.sessions.find((item) => item.id === session.id && item.userId === authenticatedUser!.id)
      const record = deps.localSessionRecord(session)
      if (local) Object.assign(local, record)
      return record
    }).filter((session) => {
      if (!requestedDirectory) return true
      const project = session.project === 'General Chat' ? deps.generalChatProject() : userProjects.find((candidate) => candidate.name === session.project)
      return (session.directory ?? project?.path) === deps.resolve(requestedDirectory)
    }).map((record) => deps.storedSessionResponse(record, userProjects)).filter((session) => {
      if (!search) return true
      return [session.id, session.title, session.project, session.directory].some((value) => String(value ?? '').toLocaleLowerCase().includes(search))
    }).sort((a, b) => {
      const updated = a.updatedAt - b.updatedAt
      if (updated !== 0) return order === 'asc' ? updated : -updated
      const id = a.id.localeCompare(b.id)
      return order === 'asc' ? id : -id
    })
    const start = cursor
      ? records.findIndex((session) => order === 'asc'
        ? session.updatedAt > cursor.updatedAt || (session.updatedAt === cursor.updatedAt && session.id > cursor.id)
        : session.updatedAt < cursor.updatedAt || (session.updatedAt === cursor.updatedAt && session.id < cursor.id))
      : 0
    const pageItems = records.slice(start < 0 ? records.length : start, (start < 0 ? records.length : start) + limit)
    const last = pageItems[pageItems.length - 1]
    const nextCursor = last && (start < 0 ? 0 : start) + pageItems.length < records.length
      ? deps.encodeSessionCursor({ updatedAt: last.updatedAt, id: last.id, order, limit, search, ...(project ? { project } : {}), ...(requestedDirectory ? { directory: requestedDirectory } : {}) })
      : undefined
    return deps.json({
      sessions: pageItems,
      ...(nextCursor ? { nextCursor } : {}),
      page: { limit, order, hasNext: Boolean(nextCursor), ...(nextCursor ? { nextCursor } : {}) },
    })
  }

  if (path[1] === 'sessions' && path.length === 2 && request.method === 'POST') {
    const input = await deps.body(request)
    const client = await deps.applicationDatabase()
    const repository = deps.createProjectSessionRepository(client)
    const ownedProjects = await repository.listProjects(authenticatedUser!.id)
    const agentCandidates = await deps.listAgents(client, authenticatedUser!.id)
    const requestedProjectId = typeof input.project === 'number'
      ? input.project
      : typeof input.project === 'string' && /^\d+$/.test(input.project) ? Number(input.project) : undefined
    const requestedProjectName = typeof input.project === 'string' && !/^\d+$/.test(input.project) ? input.project : undefined
    const selectedProject = requestedProjectId !== undefined
      ? requestedProjectId === 0 ? deps.generalChatProject() : ownedProjects[requestedProjectId - 1]
      : requestedProjectName
        ? requestedProjectName === 'General Chat' ? deps.generalChatProject() : ownedProjects.find((item) => item.name === requestedProjectName)
        : typeof input.directory === 'string'
          ? ownedProjects.find((item) => deps.resolve(item.path) === deps.resolve(input.directory as string)) ?? deps.generalChatProject()
          : deps.generalChatProject()
    if (!selectedProject) return deps.json({ error: 'Project not found', code: 'NEW_SESSION_PROJECT_NOT_FOUND' }, 404)
    const projectCandidates = [
      { id: 0, ...deps.generalChatProject() },
      ...ownedProjects.map((item, index) => ({
        id: index + 1,
        name: item.name,
        path: item.path,
        agentNames: item.agentNames,
        hasAgentOverride: item.hasAgentOverride,
      })),
    ]
    const resolved = (() => {
      try {
        return deps.resolveNewSessionRoute({
          projectName: selectedProject.name,
          agentName: typeof input.agent === 'string' ? input.agent : undefined,
          projects: projectCandidates,
          agents: agentCandidates,
        })
      } catch (error) {
        if (error instanceof deps.NewSessionRouteError) return error
        throw error
      }
    })()
    if (resolved instanceof deps.NewSessionRouteError) {
      const status = resolved.code === 'NEW_SESSION_PROJECT_NOT_FOUND' || resolved.code === 'NEW_SESSION_AGENT_NOT_FOUND' ? 404 : 409
      return deps.json({ error: resolved.message, code: resolved.code }, status)
    }
    const project: Project = resolved.project
    const thinking = input.thinking === undefined ? undefined
      : input.thinking === 'off' || input.thinking === 'minimal' || input.thinking === 'low' || input.thinking === 'medium' || input.thinking === 'high' || input.thinking === 'xhigh'
        ? input.thinking
        : null
    if (thinking === null) return deps.json({ error: 'Invalid thinking level', code: 'NEW_SESSION_INVALID_THINKING' }, 400)
    const requestedPermission = input.permission === undefined ? 'ask'
      : input.permission === 'ask' || input.permission === 'none' || input.permission === 'allow_all' ? input.permission : null
    if (requestedPermission === null) return deps.json({ error: 'Invalid permission override', code: 'NEW_SESSION_INVALID_PERMISSION' }, 400)
    const preferences = await deps.getUserPreferences(client, authenticatedUser!.id)
    const requestedModel = typeof input.model === 'string' && input.model.trim()
      ? input.model.trim()
      : deps.preferenceModel(preferences?.preferences, 'conversation')
    const model = requestedModel && thinking && !requestedModel.endsWith(`:${thinking}`) ? `${requestedModel}:${thinking}` : requestedModel
    const selectedModel = deps.modelSelection(model)
    try {
      await deps.validateModelSelection(authenticatedUser!.id, selectedModel)
    } catch (error) {
      if (error instanceof ModelUnavailableError) return deps.json({ error: error.message, code: error.code }, 409)
      throw error
    }
    let tags: string[] = []
    if (input.tags !== undefined) {
      try { tags = deps.normalizeSessionTags(input.tags) }
      catch (error) {
        if (error instanceof deps.InvalidSessionTagsError) return deps.json({ error: error.message, code: error.code }, 400)
        throw error
      }
    }
    const now = Date.now()
    const id = crypto.randomUUID()
    const directory = project.name === 'General Chat' ? deps.sessionWorkspace(id) : project.path
    deps.mkdirSync(directory, { recursive: true })
    await deps.ensureUserMetadata(authenticatedUser!.id)
    const stored = await deps.createProjectSessionRepository(client).createSession(authenticatedUser!.id, {
      id,
      project: project.name,
      ...(typeof project.id === 'string' ? { projectId: project.id } : {}),
      title: typeof input.title === 'string' && input.title.trim() ? input.title.trim() : 'Untitled session',
      tags,
      createdAt: now,
      updatedAt: now,
      directory,
      profile: resolved.agent.name,
      ...(selectedModel ? { model: selectedModel.value } : {}),
      permissionOverride: requestedPermission,
    })
    const record: SessionRecord = {
      id: stored.id,
      project: stored.project,
      directory: stored.directory ?? directory,
      title: stored.title,
      createdAt: stored.createdAt,
      updatedAt: stored.updatedAt,
      profile: stored.profile,
      model: stored.model,
      userId: stored.userId,
      permissionOverride: stored.permissionOverride,
      tags: stored.tags,
    }
    deps.sessions.push(record)
    await deps.saveState(record)
    deps.rpcSession(record.id, record.userId!, record, project, record.profile ?? 'master', record.permissionOverride ?? 'ask')
    return deps.json({ session: deps.storedSessionResponse(record, ownedProjects) }, 201)
  }

  if (path[1] === 'sessions' && path.length >= 3) {
    const id = decodeURIComponent(path[2] ?? '')
    try {
      const store = await deps.runtimeStore()
      const ownershipClient = await deps.applicationDatabase()
      const ownedRecord = internalRequest
        ? await deps.ownedSessionRecord(ownershipClient, (await deps.createProjectSessionRepository(ownershipClient).getSessionById(id))?.userId ?? '', id)
        : await deps.ownedSessionRecord(ownershipClient, authenticatedUser!.id, id)
      if (!ownedRecord) return deps.json({ error: 'Session not found' }, 404)
      const ownerId = ownedRecord.userId
      if (!ownerId) return deps.json({ error: 'Session not found' }, 404)
      if (path.length === 3 && request.method === 'GET') return deps.json(deps.storedSessionResponse(ownedRecord, await deps.createProjectSessionRepository(ownershipClient).listProjects(ownerId)))
      if (path.length === 3 && request.method === 'PATCH') {
        const input = await deps.body(request)
        let tags: string[] | undefined
        if (input.tags !== undefined) {
          try { tags = deps.normalizeSessionTags(input.tags) }
          catch (error) {
            if (error instanceof deps.InvalidSessionTagsError) return deps.json({ error: error.message, code: error.code }, 400)
            throw error
          }
        }
        const title = typeof input.title === 'string' ? input.title.trim() : ''
        const client = ownershipClient
        const record = ownedRecord
        const updated = await deps.createProjectSessionRepository(client).updateSession(ownerId, id, {
          ...(title ? { title } : {}),
          ...(typeof input.archived === 'boolean' ? { archived: input.archived } : {}),
          ...(tags !== undefined ? { tags } : {}),
        })
        if (updated) {
          record.updatedAt = updated.updatedAt
          record.title = updated.title
          record.archived = updated.archived
          record.tags = updated.tags
        }
        if (title) await deps.sendRpc(id, { type: 'set_session_name', name: title }, ownedRecord)
        await deps.saveState(record)
        return deps.json({ session: deps.storedSessionResponse(record, await deps.createProjectSessionRepository(client).listProjects(ownerId)) })
      }
      if (path.length === 3 && request.method === 'DELETE') {
        const client = ownershipClient
        await deps.createProjectSessionRepository(client).deleteSession(ownerId, id)
        deps.active.get(deps.activeKey(ownerId, id))?.close()
        deps.active.delete(deps.activeKey(ownerId, id))
        deps.sessions = deps.sessions.filter((session) => session.id !== id || session.userId !== ownerId)
        await deps.saveState()
        return deps.json({ ok: true })
      }
      if (path.length === 4 && path[3] === 'messages' && request.method === 'GET') {
        const record = ownedRecord
        const history = await deps.transcriptHistory(id, record)
        return deps.json({ messages: history.messages })
      }
      if (path.length === 5 && path[3] === 'tool-calls' && request.method === 'GET') {
        const callID = decodeURIComponent(path[4] ?? '')
        const payload = deps.entriesPayload(await deps.sendRpc(id, { type: 'get_entries' }, ownedRecord))
        for (const entry of payload.entries) {
          const message = deps.object(deps.object(entry).message)
          if (message.role === 'toolResult' && message.toolCallId === callID) {
            return deps.json({ callID, tool: message.toolName ?? null, input: deps.redactSensitive(deps.object(message.input)), output: deps.redactSensitiveText(deps.sessionMessageText(message)), details: deps.redactSensitive(deps.object(message.details)), error: message.isError ? deps.redactSensitiveText(deps.sessionMessageText(message)) : null })
          }
        }
        return deps.json({ callID, output: '', details: {}, error: null }, 404)
      }
      if (path.length === 4 && path[3] === 'messages' && request.method === 'POST') {
        const input = await deps.body(request)
        const metadata = deps.object(input.metadata)
        const record = ownedRecord
        const content = typeof input.content === 'string' ? input.content : ''
        const ownerId = record.userId
        if (!ownerId) return deps.json({ error: 'Session owner is unavailable' }, 400)
        const requestedAgent = typeof metadata.agent === 'string' && metadata.agent.trim() ? metadata.agent.trim() : undefined
        const requestedPermission = deps.requestedMetadataPermission(metadata)
        if (requestedPermission === null) return deps.json({ error: 'Invalid permission override' }, 400)
        let context
        try {
          context = await deps.resolveToolSessionContext(ownershipClient, ownerId, id, requestedAgent, requestedPermission)
        } catch (error) {
          const failure = deps.sessionContextFailure(error)
          if (failure) return failure
          throw error
        }
        const requestedMessageID = deps.messageDeliveryId(input.messageID)
        const messageID = requestedMessageID ?? crypto.randomUUID()
        let reservation
        try {
          reservation = await store.reserveMessageDelivery(ownerId, id, messageID, content, metadata)
        } catch (error) {
          if (error instanceof deps.MessageDeliveryConflictError) return deps.json({ error: error.message, code: error.code }, 409)
          throw error
        }
        if (!reservation.created) return deps.json(deps.replayMessageDeliveryResponse(reservation.delivery), 200)
        const updated = await deps.createProjectSessionRepository(ownershipClient).updateSession(ownerId, id, {
          profile: context.agentName,
          ...(requestedPermission === undefined ? {} : { permissionOverride: context.permissionOverride }),
        })
        if (!updated) throw new Error('Session was not found')
        record.profile = context.agentName
        record.permissionOverride = updated.permissionOverride
        await deps.saveState(record)
        return deps.json(deps.messageDeliveryResponse(reservation.delivery), 201)
      }
      if (path.length === 4 && path[3] === 'steer' && request.method === 'POST') {
        const input = await deps.body(request)
        const content = typeof input.content === 'string' ? input.content.trim() : typeof input.message === 'string' ? input.message.trim() : ''
        if (!content) return deps.json({ error: 'Steering content is required' }, 400)
        const clientId = deps.queueClientId(input.clientId ?? input.messageID)
        let reservation
        try { reservation = await store.reserveQueueEntry(ownerId, id, clientId, content, 'steering') }
        catch (error) {
          if (error instanceof deps.QueueEntryConflictError) return deps.json({ error: error.message, code: error.code }, 409)
          throw error
        }
        if (!reservation.created) return deps.json({ entry: reservation.entry }, 200)
        try {
          await deps.sendRpc(id, { type: 'steer', message: content, id: clientId }, ownedRecord)
          return deps.json({ entry: reservation.entry }, 201)
        } catch (error) {
          const entry = await store.updateQueueEntry(ownerId, id, clientId, 'failed', error instanceof Error ? error.message : 'Steering failed')
          deps.broadcastSse({ type: 'message.queue.updated', properties: { sessionID: id } }, ownerId)
          return deps.json({ entry }, 200)
        }
      }
      if (path.length === 4 && path[3] === 'queue' && request.method === 'GET') {
        return deps.json({ entries: await store.listQueueEntries(ownerId, id) })
      }
      if (path.length === 4 && path[3] === 'queue' && request.method === 'POST') {
        const input = await deps.body(request)
        const content = typeof input.content === 'string' ? input.content.trim() : typeof input.message === 'string' ? input.message.trim() : ''
        if (!content) return deps.json({ error: 'Queue content is required' }, 400)
        const clientId = deps.queueClientId(input.clientId ?? input.messageID)
        let reservation
        try { reservation = await store.reserveQueueEntry(ownerId, id, clientId, content, 'follow_up') }
        catch (error) {
          if (error instanceof deps.QueueEntryConflictError) return deps.json({ error: error.message, code: error.code }, 409)
          throw error
        }
        deps.broadcastSse({ type: 'message.queue.updated', properties: { sessionID: id } }, ownerId)
        return deps.json({ entry: reservation.entry }, reservation.created ? 201 : 200)
      }
      if (path.length === 5 && path[3] === 'queue') {
        const clientId = decodeURIComponent(path[4] ?? '')
        if (clientId === 'clear' && request.method === 'POST') {
          await store.clearQueue(ownerId, id)
          deps.broadcastSse({ type: 'message.queue.updated', properties: { sessionID: id } }, ownerId)
          return deps.json({ entries: await store.listQueueEntries(ownerId, id) })
        }
        if (request.method === 'DELETE') {
          let entry
          try { entry = await store.updateQueueEntry(ownerId, id, clientId, 'cancelled') }
          catch (error) {
            if (error instanceof deps.QueueEntryTransitionError) return deps.json({ error: error.message, code: error.code }, 409)
            throw error
          }
          deps.broadcastSse({ type: 'message.queue.updated', properties: { sessionID: id } }, ownerId)
          return entry ? deps.json({ entry }) : deps.json({ error: 'Queue entry not found' }, 404)
        }
        if (request.method === 'POST') {
          let entry
          try { entry = await store.updateQueueEntry(ownerId, id, clientId, 'enqueued') }
          catch (error) {
            if (error instanceof deps.QueueEntryTransitionError) return deps.json({ error: error.message, code: error.code }, 409)
            throw error
          }
          if (entry?.kind === 'steering') {
            try {
              entry = await store.updateQueueEntry(ownerId, id, clientId, 'steering')
              if (!entry) return deps.json({ error: 'Queue entry not found' }, 404)
              await deps.sendRpc(id, { type: 'steer', message: entry.content, id: entry.clientId }, ownedRecord)
            } catch (error) {
              entry = await store.updateQueueEntry(ownerId, id, clientId, 'failed', error instanceof Error ? error.message : 'Steering failed')
            }
          }
          deps.broadcastSse({ type: 'message.queue.updated', properties: { sessionID: id } }, ownerId)
          return entry ? deps.json({ entry }) : deps.json({ error: 'Queue entry not found' }, 404)
        }
        if (request.method === 'PATCH') {
          const input = await deps.body(request)
          if (typeof input.position !== 'number' || !Number.isFinite(input.position)) return deps.json({ error: 'Queue position is required' }, 400)
          const entry = await store.reorderQueueEntry(ownerId, id, clientId, input.position)
          deps.broadcastSse({ type: 'message.queue.updated', properties: { sessionID: id } }, ownerId)
          return entry ? deps.json({ entry }) : deps.json({ error: 'Queue entry not found' }, 404)
        }
      }
      if (path.length === 4 && path[3] === 'runs' && request.method === 'POST') {
        const input = await deps.body(request)
        const ownerId = ownedRecord.userId ?? authenticatedUser!.id
        const requestedMessageID = deps.messageDeliveryId(input.messageID)
        const delivery = requestedMessageID
          ? await store.getMessageDelivery(ownerId, id, requestedMessageID)
          : await store.getLatestPendingMessageDelivery(ownerId, id)
        if (!delivery) return deps.json({ error: 'Message delivery not found', code: 'MESSAGE_DELIVERY_NOT_FOUND' }, 409)
        if (!delivery.content.trim()) return deps.json({ error: 'Prompt content is required' }, 400)
        if (delivery.state !== 'pending') return deps.json(deps.replayMessageDeliveryResponse(delivery), 200)
        const claimedDelivery = await store.claimMessageDelivery(delivery)
        if (!claimedDelivery) {
          const current = await store.getMessageDelivery(ownerId, id, delivery.messageId)
          return current ? deps.json(deps.messageDeliveryResponse(current), 200) : deps.json({ error: 'Message delivery not found', code: 'MESSAGE_DELIVERY_NOT_FOUND' }, 409)
        }
        try {
          const metadata = JSON.parse(claimedDelivery.metadata) as Record<string, unknown>
          const runtimeRun = await store.reserveRuntimeRun(ownerId, id, claimedDelivery.messageId, typeof metadata.requestId === 'string' ? metadata.requestId : undefined)
          if (runtimeRun.created) await store.updateRuntimeRun(ownerId, id, claimedDelivery.messageId, 'running')

          // New deps.sessions opt into routing explicitly. Routing happens before the Pi
          // session is initialized so a routed project can safely change its cwd.
          if (metadata.routing === true) {
            const target = await deps.routeFirstSessionRequest(ownershipClient, ownerId, ownedRecord.project, claimedDelivery.content)
            if (target) {
              const repository = deps.createProjectSessionRepository(ownershipClient)
              const routedProject = target.projectName
                ? target.projectName === 'General Chat'
                  ? deps.generalChatProject()
                  : await repository.findProjectByName(ownerId, target.projectName)
                : undefined
              if (target.projectName && !routedProject) throw new Error('Routed project is unavailable')
              const routedDirectory = routedProject
                ? routedProject.name === 'General Chat' ? deps.sessionWorkspace(id) : routedProject.path
                : undefined
              const updated = await repository.updateSession(ownerId, id, {
                profile: target.agentName,
                ...(target.projectName ? { project: target.projectName } : {}),
                ...(routedDirectory ? { directory: routedDirectory } : {}),
              })
              if (!updated) throw new Error('Session was not found after routing')
              Object.assign(ownedRecord, deps.localSessionRecord(updated))
              const local = deps.sessions.find((session) => session.id === id && session.userId === ownerId)
              if (local && local !== ownedRecord) Object.assign(local, deps.localSessionRecord(updated))
              await deps.saveState(ownedRecord)
            }
          }

          const selectedModel = deps.modelSelection(metadata.model)
          if (selectedModel) {
            await deps.sendRpc(id, { type: 'set_model', provider: selectedModel.providerID, modelId: selectedModel.modelID }, ownedRecord)
            await deps.persistSessionModel(ownershipClient, ownerId, id, ownedRecord, selectedModel)
          }
          // The session runtime was selected from PocketBase when the Pi session
          // was created; filesystem `/profile` commands are intentionally gone.
          const response = await deps.sendRpc(id, { type: 'prompt', message: claimedDelivery.content }, ownedRecord)
          await store.completeMessageDelivery(claimedDelivery, response)
          await store.updateRuntimeRun(ownerId, id, claimedDelivery.messageId, 'completed')
          return deps.json(deps.withDeliveryMetadata(response, deps.messageDeliveryResponse({ ...claimedDelivery, state: 'completed' })))
        } catch (error) {
          await store.interruptMessageDelivery(claimedDelivery)
          await store.updateRuntimeRun(ownerId, id, claimedDelivery.messageId, 'interrupted', error)
          console.warn(`Message delivery interrupted: ${deps.redactedDiagnostic(error)}`)
          return deps.json(deps.messageDeliveryResponse({ ...claimedDelivery, state: 'interrupted' }), 200)
        }
      }
      if (path.length === 4 && path[3] === 'state' && request.method === 'GET') return deps.json(deps.rpcData(await deps.sendRpc(id, { type: 'get_state' }, ownedRecord)))
      if (path.length === 4 && path[3] === 'stats' && request.method === 'GET') return deps.json(deps.rpcData(await deps.sendRpc(id, { type: 'get_session_stats' }, ownedRecord)))
      if (path.length === 4 && path[3] === 'rpc' && request.method === 'POST') {
        const input = await deps.body(request)
        if (typeof input.type !== 'string') return deps.json({ error: 'RPC type is required' }, 400)
        return deps.json(await deps.sendRpc(id, input as any, ownedRecord))
      }
      if (path.length === 4 && path[3] === 'prompt' && request.method === 'POST') {
        const input = await deps.body(request)
        if (typeof input.message !== 'string' || !input.message.trim()) return deps.json({ error: 'Prompt message is required' }, 400)
        return deps.json(await deps.sendRpc(id, { type: 'prompt', message: input.message, ...(typeof input.streamingBehavior === 'string' ? { streamingBehavior: input.streamingBehavior } : {}) }, ownedRecord))
      }
      if (path.length === 4 && path[3] === 'abort' && request.method === 'POST') return deps.json(await deps.sendRpc(id, { type: 'abort' }, ownedRecord))
      return deps.json({ error: 'Not found' }, 404)
    } catch (error) {
      console.warn(`Session request failed: ${deps.redactedDiagnostic(error)}`)
      return deps.json({ error: 'Session request failed' }, 400)
    }
  }
  return undefined
}
