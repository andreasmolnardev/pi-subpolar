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
