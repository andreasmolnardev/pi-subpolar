import { afterEach, describe, expect, it, vi } from 'vitest'
import { createOneShotTokenIssuer, devAdminTokenEnabled } from '../application/auth.ts'
import { handleAuthRoute } from '../routes/auth.ts'

const requestFor = (method: string) => new Request('http://localhost:4173/api/auth/dev-admin-token', { method })

function routeContext(method: string, enabled: boolean, issueToken: () => Promise<string>) {
  const request = requestFor(method)
  return {
    request,
    url: new URL(request.url),
    path: ['api', 'auth', 'dev-admin-token'],
    correlationId: 'test-request',
    authenticatedUser: null,
    gatewayCredential: null,
    internalRequest: false,
    deps: {
      devAdminTokenEnabled: () => enabled,
      issueDevAdminApiToken: issueToken,
      json: (body: unknown, status = 200) => Response.json(body, { status }),
    },
  } as never
}

describe('development application-admin token endpoint', () => {
  afterEach(() => vi.restoreAllMocks())

  it('is opt-in and only enabled in explicit development mode', () => {
    expect(devAdminTokenEnabled({ NODE_ENV: 'development', SUBPOLAR_DEV_ADMIN_TOKEN_ENABLED: 'true' })).toBe(true)
    expect(devAdminTokenEnabled({ NODE_ENV: 'production', SUBPOLAR_DEV_ADMIN_TOKEN_ENABLED: 'true' })).toBe(false)
    expect(devAdminTokenEnabled({ NODE_ENV: 'development', SUBPOLAR_DEV_ADMIN_TOKEN_ENABLED: 'false' })).toBe(false)
    expect(devAdminTokenEnabled({ SUBPOLAR_DEV_ADMIN_TOKEN_ENABLED: 'true' })).toBe(false)
  })

  it('does not issue or log a token when disabled', async () => {
    const issue = vi.fn(async () => 'user-token-secret')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const response = await handleAuthRoute(routeContext('POST', false, issue))

    expect(response?.status).toBe(404)
    expect(issue).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
  })

  it('logs a normal application-admin user token once without returning it to the requester', async () => {
    const token = 'pb_user_token_secret'
    const issue = vi.fn(async () => token)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const response = await handleAuthRoute(routeContext('POST', true, issue))

    expect(response?.status).toBe(200)
    expect(warn).toHaveBeenCalledOnce()
    expect(warn.mock.calls[0]?.[0]).toContain(token)
    const body = await response?.json() as Record<string, unknown>
    expect(body).toEqual({ ok: true, message: 'Development token written to Subpolar Agent logs' })
    expect(JSON.stringify(body)).not.toContain(token)
  })

  it('allows only one concurrent token issuance per process', async () => {
    let release!: (value: string) => void
    const issue = vi.fn(() => new Promise<string>((resolve) => { release = resolve }))
    const issuer = createOneShotTokenIssuer(issue)
    const first = issuer()
    await expect(issuer()).rejects.toThrow('already been issued')
    release('user-token')
    await expect(first).resolves.toBe('user-token')
    expect(issue).toHaveBeenCalledOnce()
  })

  it('requires POST', async () => {
    const issue = vi.fn(async () => 'user-token-secret')
    const response = await handleAuthRoute(routeContext('GET', true, issue))

    expect(response?.status).toBe(405)
    expect(issue).not.toHaveBeenCalled()
  })
})
