import { describe, expect, it } from 'vitest'
import { handleProvidersRoute } from '../routes/providers.ts'

function context(method: 'GET' | 'POST', body: unknown, preferences: Record<string, unknown>, save: (value: Record<string, unknown>) => void) {
  const url = new URL('http://localhost/api/providers/model-state')
  return {
    request: new Request(url.href, { method, body: method === 'POST' ? JSON.stringify(body) : undefined }),
    url,
    path: ['api', 'providers', 'model-state'],
    correlationId: 'test-request',
    authenticatedUser: { id: 'owner-a' },
    gatewayCredential: null,
    internalRequest: false,
    deps: {
      applicationDatabase: async () => ({}),
      getUserPreferences: async () => ({ preferences, updated_at: 1 }),
      saveUserPreferences: async (_client: unknown, _userId: string, next: Record<string, unknown>) => {
        save(next)
        return { preferences: next, updated_at: 2 }
      },
      body: async () => body,
      json: (value: unknown, status = 200) => Response.json(value, { status }),
    },
  } as never
}

describe('provider model state route', () => {
  it('reads the owner-scoped model state and persists recent/favorite changes', async () => {
    let preferences: Record<string, unknown> = {
      modelState: {
        recent: [{ providerID: 'openai', modelID: 'gpt-4o' }],
        favorite: [],
        variant: { 'openai/gpt-4o': 'default' },
      },
    }
    const read = await handleProvidersRoute(context('GET', undefined, preferences, () => undefined))
    await expect(read?.json()).resolves.toEqual({
      recent: [{ providerID: 'openai', modelID: 'gpt-4o' }],
      favorite: [],
      variant: { 'openai/gpt-4o': 'default' },
    })

    const body = { recent: { providerID: 'anthropic', modelID: 'claude-sonnet' }, favorite: { providerID: 'openai', modelID: 'gpt-4o' } }
    const write = await handleProvidersRoute(context('POST', body, preferences, (next) => { preferences = next }))
    expect(write?.status).toBe(200)
    await expect(write?.json()).resolves.toMatchObject({
      recent: [body.recent, { providerID: 'openai', modelID: 'gpt-4o' }],
      favorite: [body.favorite],
    })
    expect(preferences).toHaveProperty('modelState')
  })

  it('rejects malformed model selections', async () => {
    const response = await handleProvidersRoute(context('POST', { recent: { providerID: 'openai' } }, {}, () => undefined))
    expect(response?.status).toBe(400)
  })
})
