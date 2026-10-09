import { describe, expect, it } from 'vitest'
import { handleSessionsRoute } from '../routes/sessions.ts'
import { resolveNewSessionRoute, NewSessionRouteError } from '../application/new-session-route.ts'

function context(validateModelSelection: (ownerId: string, selection: { value?: string }) => Promise<void>, input: Record<string, unknown> = { model: 'provider~account/model', permission: 'ask' }, agents: Array<{ id: string; name: string; enabled: boolean; model?: string; thinking?: 'off' | 'minimal' | 'low' | 'medium' | 'high' }> = [{ id: 'master-id', name: 'master', enabled: true }]) {
  const url = new URL('http://localhost/api/sessions')
  return {
    request: new Request(url.href, { method: 'POST', body: JSON.stringify(input) }),
    url,
    path: ['api', 'sessions'],
    correlationId: 'test-request',
    authenticatedUser: { id: 'owner-a' },
    gatewayCredential: null,
    internalRequest: false,
    deps: {
      body: async () => input,
      applicationDatabase: async () => ({}),
      createProjectSessionRepository: () => ({ listProjects: async () => [] }),
      listAgents: async () => agents,
      generalChatProject: () => ({ id: 0, name: 'General Chat', path: '/workspace/general-chat' }),
      resolveNewSessionRoute,
      NewSessionRouteError,
      getUserPreferences: async () => null,
      preferenceModel: () => undefined,
      modelSelection: (value: string) => ({ providerID: 'provider~account', modelID: 'model', value }),
      validateModelSelection,
      json: (body: unknown, status = 200) => Response.json(body, { status }),
    },
  } as never
}

describe('handleSessionsRoute', () => {
  it('checks General Chat availability against its managed root, not a stale per-session directory', async () => {
    const record = { id: 'session-general', userId: 'owner-a', project: 'General Chat', directory: '/missing/session-workspace' }
    const url = new URL('http://localhost/api/sessions/session-general')
    const checkedPaths: string[] = []
    const routeContext = {
      request: new Request(url.href),
      url,
      path: ['api', 'sessions', 'session-general'],
      correlationId: 'test-request',
      authenticatedUser: { id: 'owner-a' },
      gatewayCredential: null,
      internalRequest: false,
      deps: {
        applicationDatabase: async () => ({}),
        ownedSessionRecord: async () => record,
        createProjectSessionRepository: () => ({ listProjects: async () => [], getSession: async () => record }),
        ownedSessionProject: async () => ({ name: 'General Chat', path: '/managed/general-chat' }),
        runtimeStore: async () => ({}),
        statSync: (path: string) => {
          checkedPaths.push(path)
          if (path === '/missing/session-workspace') throw new Error('ENOENT')
          return { isDirectory: () => true }
        },
        storedSessionResponse: (value: unknown) => value,
        json: (body: unknown, status = 200) => Response.json(body, { status }),
      },
    } as never

    const response = await handleSessionsRoute(routeContext)

    expect(checkedPaths).toEqual(['/missing/session-workspace', '/managed/general-chat'])
    await expect(response?.json()).resolves.toMatchObject({ workspaceAvailable: true })
  })

  it('correlates tool results with the assistant tool-call arguments', async () => {
    const ownerId = 'owner-a'
    const callID = 'call-1'
    const record = { id: 'session-1', userId: ownerId, directory: '/workspace', project: 'General Chat' }
    const entries = [
      { message: { role: 'assistant', content: [{ type: 'toolCall', id: callID, name: 'web.search', arguments: { query: 'Pi Durable docs' } }] } },
      { message: { role: 'toolResult', toolCallId: callID, toolName: 'web.search', content: [{ type: 'text', text: 'search results' }], isError: false } },
    ]
    const url = new URL(`http://localhost/api/sessions/session-1/tool-calls/${encodeURIComponent(callID)}`)
    const routeContext = {
      request: new Request(url.href),
      url,
      path: ['api', 'sessions', 'session-1', 'tool-calls', callID],
      correlationId: 'test-request',
      authenticatedUser: { id: ownerId },
      gatewayCredential: null,
      internalRequest: false,
      deps: {
        applicationDatabase: async () => ({}),
        ownedSessionRecord: async () => record,
        runtimeStore: async () => ({}),
        sendRpc: async () => ({ entries }),
        entriesPayload: (value: unknown) => value,
        object: (value: unknown) => value && typeof value === 'object' ? value : {},
        sessionMessageText: (message: { content?: Array<{ text?: string }> }) => message.content?.map((part) => part.text ?? '').join('') ?? '',
        redactSensitive: (value: unknown) => value,
        redactSensitiveText: (value: string) => value,
        json: (body: unknown, status = 200) => Response.json(body, { status }),
      },
    } as never

    const response = await handleSessionsRoute(routeContext)

    expect(response?.status).toBe(200)
    await expect(response?.json()).resolves.toMatchObject({
      callID,
      tool: 'web.search',
      input: { query: 'Pi Durable docs' },
      output: 'search results',
      error: null,
    })
  })

  it('inspects Durable tool calls from the persisted owner-scoped transcript', async () => {
    const ownerId = 'owner-a'
    const callID = 'pi-durable:conversation:request:model-call'
    const record = { id: 'session-1', userId: ownerId, directory: '/workspace', project: 'General Chat' }
    const entries = [
      { id: 'pi-durable:session-1:call:0', parentId: null, message: { role: 'assistant', content: [{ type: 'toolCall', id: callID, name: 'web_search', arguments: { query: 'Pi Durable npm version' } }] } },
      { id: 'pi-durable:session-1:result:0', parentId: 'pi-durable:session-1:call:0', message: { role: 'toolResult', toolCallId: callID, toolName: 'web_search', content: [{ type: 'text', text: 'official results' }], isError: false } },
    ]
    const url = new URL(`http://localhost/api/sessions/session-1/tool-calls/${encodeURIComponent(callID)}`)
    const routeContext = {
      request: new Request(url.href),
      url,
      path: ['api', 'sessions', 'session-1', 'tool-calls', callID],
      correlationId: 'test-request',
      authenticatedUser: { id: ownerId },
      gatewayCredential: null,
      internalRequest: false,
      deps: {
        applicationDatabase: async () => ({}),
        ownedSessionRecord: async () => record,
        runtimeStore: async () => ({}),
        transcriptHistory: async (sessionId: string, selection: unknown) => {
          expect(sessionId).toBe('session-1')
          expect(selection).toBe(record)
          return { entries, leafId: entries[1]!.id, messages: [] }
        },
        sendRpc: async () => { throw new Error('Durable history must not use the legacy Pi session') },
        entriesPayload: (value: unknown) => value,
        object: (value: unknown) => value && typeof value === 'object' ? value : {},
        sessionMessageText: (message: { content?: Array<{ text?: string }> }) => message.content?.map((part) => part.text ?? '').join('') ?? '',
        redactSensitive: (value: unknown) => value,
        redactSensitiveText: (value: string) => value,
        json: (body: unknown, status = 200) => Response.json(body, { status }),
      },
    } as never

    const response = await handleSessionsRoute(routeContext)

    expect(response?.status).toBe(200)
    await expect(response?.json()).resolves.toMatchObject({
      callID,
      tool: 'web_search',
      input: { query: 'Pi Durable npm version' },
      output: 'official results',
      error: null,
    })
  })

  it('reserves a user-owned prompt delivery without an ownerId temporal-dead-zone failure', async () => {
    const ownerId = 'owner-a'
    const record = { id: 'session-1', userId: ownerId, directory: '/workspace', project: 'General Chat' }
    const delivery = { messageId: 'message-1', state: 'pending' }
    const url = new URL('http://localhost/api/sessions/session-1/messages')
    const context = {
      request: new Request(url.href, { method: 'POST', body: JSON.stringify({ content: 'hello', messageID: 'message-1' }) }),
      url,
      path: ['api', 'sessions', 'session-1', 'messages'],
      correlationId: 'test-request',
      authenticatedUser: { id: ownerId },
      gatewayCredential: null,
      internalRequest: false,
      deps: {
        applicationDatabase: async () => ({}),
        ownedSessionRecord: async () => record,
        runtimeStore: async () => ({ reserveMessageDelivery: async () => ({ created: true, delivery }) }),
        ownedSessionProject: async (_client: unknown, requestedOwner: string, requestedRecord: unknown) => {
          expect(requestedOwner).toBe(ownerId)
          expect(requestedRecord).toBe(record)
          return { path: '/workspace' }
        },
        statSync: () => ({ isDirectory: () => true }),
        body: async () => ({ content: 'hello', messageID: 'message-1' }),
        object: (value: unknown) => value ?? {},
        requestedMetadataPermission: () => undefined,
        resolveToolSessionContext: async () => ({ agentName: 'research', permissionOverride: 'ask' }),
        messageDeliveryId: (value: string) => value,
        createProjectSessionRepository: () => ({ updateSession: async () => ({ ...record, profile: 'research' }) }),
        saveState: async () => undefined,
        messageDeliveryResponse: (value: unknown) => value,
        json: (body: unknown, status = 200) => Response.json(body, { status }),
      },
    } as never

    const response = await handleSessionsRoute(context)

    expect(response?.status).toBe(201)
    await expect(response?.json()).resolves.toEqual(delivery)
  })

  it('returns DURABLE_RUN_REQUIRED from the unsupported steer route without calling legacy RPC', async () => {
    const record = { id: 'session-1', userId: 'owner-a', directory: '/workspace', project: 'General Chat' }
    const url = new URL('http://localhost/api/sessions/session-1/steer')
    let sent = false
    const routeContext = {
      request: new Request(url.href, { method: 'POST', body: JSON.stringify({ content: 'follow this up' }) }),
      url,
      path: ['api', 'sessions', 'session-1', 'steer'],
      correlationId: 'test-request',
      authenticatedUser: { id: 'owner-a' },
      gatewayCredential: null,
      internalRequest: false,
      deps: {
        applicationDatabase: async () => ({}),
        ownedSessionRecord: async () => record,
        runtimeStore: async () => ({}),
        sendRpc: async () => { sent = true },
        json: (body: unknown, status = 200) => Response.json(body, { status }),
        redactedDiagnostic: () => 'redacted',
      },
    } as never

    const response = await handleSessionsRoute(routeContext)

    expect(response?.status).toBe(410)
    await expect(response?.json()).resolves.toMatchObject({ code: 'DURABLE_RUN_REQUIRED' })
    expect(sent).toBe(false)
  })

  it('rejects legacy prompt RPC commands with DURABLE_RUN_REQUIRED before sending RPC', async () => {
    for (const command of ['prompt', 'steer', 'follow_up', 'compact']) {
      const record = { id: 'session-1', userId: 'owner-a', directory: '/workspace', project: 'General Chat' }
      const url = new URL('http://localhost/api/sessions/session-1/rpc')
      let sent = false
      const routeContext = {
        request: new Request(url.href, { method: 'POST', body: JSON.stringify({ type: command }) }),
        url,
        path: ['api', 'sessions', 'session-1', 'rpc'],
        correlationId: 'test-request',
        authenticatedUser: { id: 'owner-a' },
        gatewayCredential: null,
        internalRequest: false,
        deps: {
          applicationDatabase: async () => ({}),
          ownedSessionRecord: async () => record,
          runtimeStore: async () => ({}),
          body: async () => ({ type: command }),
          sendRpc: async () => { sent = true },
          json: (body: unknown, status = 200) => Response.json(body, { status }),
          redactedDiagnostic: () => 'redacted',
        },
      } as never

      const response = await handleSessionsRoute(routeContext)

      expect(response?.status).toBe(410)
      await expect(response?.json()).resolves.toMatchObject({ code: 'DURABLE_RUN_REQUIRED' })
      expect(sent).toBe(false)
    }
  })

  it('returns DURABLE_RUN_REQUIRED from the compatibility prompt route', async () => {
    const record = { id: 'session-1', userId: 'owner-a', directory: '/workspace', project: 'General Chat' }
    const url = new URL('http://localhost/api/sessions/session-1/prompt')
    let sent = false
    const routeContext = {
      request: new Request(url.href, { method: 'POST', body: JSON.stringify({ message: 'hello' }) }),
      url,
      path: ['api', 'sessions', 'session-1', 'prompt'],
      correlationId: 'test-request',
      authenticatedUser: { id: 'owner-a' },
      gatewayCredential: null,
      internalRequest: false,
      deps: {
        applicationDatabase: async () => ({}),
        ownedSessionRecord: async () => record,
        runtimeStore: async () => ({}),
        body: async () => ({ message: 'hello' }),
        sendRpc: async () => { sent = true },
        json: (body: unknown, status = 200) => Response.json(body, { status }),
        redactedDiagnostic: () => 'redacted',
      },
    } as never

    const response = await handleSessionsRoute(routeContext)

    expect(response?.status).toBe(410)
    await expect(response?.json()).resolves.toMatchObject({ code: 'DURABLE_RUN_REQUIRED' })
    expect(sent).toBe(false)
  })

  it('aborts the authenticated owner session after ownership is established and preserves RPC response', async () => {
    const record = { id: 'session-1', userId: 'owner-a', directory: '/workspace', project: 'General Chat' }
    const aborts: unknown[][] = []
    const url = new URL('http://localhost/api/sessions/session-1/abort')
    const routeContext = {
      request: new Request(url.href, { method: 'POST' }),
      url,
      path: ['api', 'sessions', 'session-1', 'abort'],
      correlationId: 'test-request',
      authenticatedUser: { id: 'owner-a' },
      gatewayCredential: null,
      internalRequest: false,
      deps: {
        applicationDatabase: async () => ({}),
        ownedSessionRecord: async (_client: unknown, ownerId: string, sessionId: string) => {
          expect(ownerId).toBe('owner-a')
          expect(sessionId).toBe('session-1')
          return record
        },
        runtimeStore: async () => ({}),
        abortActiveDurableSession: (...args: unknown[]) => aborts.push(args),
        sendRpc: async () => ({ aborted: true }),
        json: (body: unknown, status = 200) => Response.json(body, { status }),
        redactedDiagnostic: () => 'redacted',
      },
    } as never

    const response = await handleSessionsRoute(routeContext)

    expect(aborts).toEqual([['owner-a', 'session-1']])
    expect(response?.status).toBe(200)
    await expect(response?.json()).resolves.toEqual({ aborted: true })
  })

  it('returns MODEL_UNAVAILABLE instead of masking it with a ReferenceError', async () => {
    const error = Object.assign(new Error('Unknown or unavailable model: provider~account/model'), { code: 'MODEL_UNAVAILABLE' })
    const response = await handleSessionsRoute(context(async () => { throw error }))

    expect(response?.status).toBe(409)
    await expect(response?.json()).resolves.toEqual({
      error: 'Unknown or unavailable model: provider~account/model',
      code: 'MODEL_UNAVAILABLE',
    })
  })

  it('uses the selected agent model when session and user preference models are absent', async () => {
    let selected: string | undefined
    const response = await handleSessionsRoute(context(async (_ownerId, model) => {
      selected = model.value
      throw Object.assign(new Error('model selected for assertion'), { code: 'MODEL_UNAVAILABLE' })
    }, { agent: 'research' }, [{ id: 'research-id', name: 'research', enabled: true, model: 'provider~account/research-model', thinking: 'low' }]))

    expect(selected).toBe('provider~account/research-model:low')
    expect(response?.status).toBe(409)
  })

  it('lets a configured model thinking suffix override the agent thinking default', async () => {
    let selected: string | undefined
    const response = await handleSessionsRoute(context(async (_ownerId, model) => {
      selected = model.value
      throw Object.assign(new Error('model selected for assertion'), { code: 'MODEL_UNAVAILABLE' })
    }, { model: 'provider~account/research-model:minimal', agent: 'research' }, [{ id: 'research-id', name: 'research', enabled: true, model: 'provider~account/research-model', thinking: 'high' }]))

    expect(selected).toBe('provider~account/research-model:minimal')
    expect(response?.status).toBe(409)
  })
})
