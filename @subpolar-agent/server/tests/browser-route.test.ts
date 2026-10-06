import { describe, expect, it } from 'vitest'
import { handleBrowserRoute } from '../routes/browser.ts'

describe('browser audit route', () => {
  it('returns only audit rows owned by the user for the requested session when the database ignores filters', async () => {
    const ownedRow = { id: 'owned', owner_id: 'alice', browser_session_id: 'session-a' }
    const rows = [
      ownedRow,
      { id: 'wrong-session', owner_id: 'alice', browser_session_id: 'session-b' },
      { id: 'foreign-owner', owner_id: 'bob', browser_session_id: 'session-a' },
    ]
    const context = {
      request: new Request('http://localhost/api/browser/sessions/session-a/audit'),
      url: new URL('http://localhost/api/browser/sessions/session-a/audit'),
      path: ['api', 'browser', 'sessions', 'session-a', 'audit'],
      correlationId: 'browser-route-test',
      authenticatedUser: { id: 'alice' },
      gatewayCredential: null,
      internalRequest: false,
      deps: {
        BrowserSessionService: class { async get() { return { id: 'session-a' } } },
        applicationDatabase: async () => ({
          collection: () => ({ getFullList: async () => rows }),
        }),
        escapeFilter: (value: string) => value,
        json: (body: unknown, status = 200) => Response.json(body, { status }),
      },
    } as never

    const response = await handleBrowserRoute(context)

    expect(response?.status).toBe(200)
    await expect(response?.json()).resolves.toEqual({ audit: [ownedRow] })
  })
})
