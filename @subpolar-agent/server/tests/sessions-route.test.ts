import { describe, expect, it } from 'vitest'
import { handleSessionsRoute } from '../routes/sessions.ts'
import { resolveNewSessionRoute, NewSessionRouteError } from '../application/new-session-route.ts'

function context(validateModelSelection: () => Promise<void>) {
  const url = new URL('http://localhost/api/sessions')
  return {
    request: new Request(url.href, { method: 'POST', body: JSON.stringify({ model: 'provider~account/model', permission: 'ask' }) }),
    url,
    path: ['api', 'sessions'],
    correlationId: 'test-request',
    authenticatedUser: { id: 'owner-a' },
    gatewayCredential: null,
    internalRequest: false,
    deps: {
      body: async () => ({ model: 'provider~account/model', permission: 'ask' }),
      applicationDatabase: async () => ({}),
      createProjectSessionRepository: () => ({ listProjects: async () => [] }),
      listAgents: async () => [{ id: 'master-id', name: 'master', enabled: true }],
      generalChatProject: () => ({ id: 0, name: 'General Chat', path: '/workspace/general-chat' }),
      resolveNewSessionRoute,
      NewSessionRouteError,
      getUserPreferences: async () => null,
      preferenceModel: () => undefined,
      modelSelection: () => ({ providerID: 'provider~account', modelID: 'model' }),
      validateModelSelection,
      json: (body: unknown, status = 200) => Response.json(body, { status }),
    },
  } as never
}

describe('handleSessionsRoute', () => {
  it('keeps automation runs out of the ordinary session list', async () => {
    const url = new URL('http://localhost/api/sessions')
    const sessions = [
      { id: 'chat-1', projectId: 0, project: 'General Chat', directory: '/workspace/general-chat/chat-1', tags: [] },
      { id: 'automation-1', projectId: 0, project: 'General Chat', directory: '/workspace/general-chat/automation-1', tags: ['automation'] },
    ]
    const routeContext = {
      request: new Request(url.href, { method: 'GET' }),
      url,
      path: ['api', 'sessions'],
      correlationId: 'test-request',
      authenticatedUser: { id: 'owner-a' },
      deps: {
        applicationDatabase: async () => ({}),
        ensureUserMetadata: async () => undefined,
        ensureApplicationSessionMetadata: async () => undefined,
        decodeSessionCursor: () => null,
        sessionPageLimit: () => 25,
        createProjectSessionRepository: () => ({ listProjects: async () => [], listSessions: async () => sessions }),
        sessions: [],
        localSessionRecord: (session: unknown) => session,
        storedSessionResponse: (session: { id: string; tags: string[] }) => session,
        generalChatProject: () => ({ name: 'General Chat', path: '/workspace/general-chat' }),
        resolve: (path: string) => path,
        json: (body: unknown, status = 200) => Response.json(body, { status }),
      },
    } as never

    const response = await handleSessionsRoute(routeContext)
    expect(response?.status).toBe(200)
    await expect(response?.json()).resolves.toMatchObject({ sessions: [{ id: 'chat-1', tags: [] }] })
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
})
