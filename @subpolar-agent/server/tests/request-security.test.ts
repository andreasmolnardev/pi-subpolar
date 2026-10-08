import { describe, expect, it } from 'vitest'
import {
  assertSafeBrowserMutation,
  InProcessRateLimiter,
  readBoundedBody,
  readJsonBody,
  RequestSecurityError,
  rateLimitKey,
} from '../core/request-security.ts'

describe('request security helpers', () => {
  it('bounds streamed request bodies and JSON parsing', async () => {
    await expect(readBoundedBody(new Request('http://localhost/api', { method: 'POST', body: '12345' }), 4))
      .rejects.toMatchObject({ code: 'BODY_TOO_LARGE' })
    await expect(readJsonBody(new Request('http://localhost/api', { method: 'POST', body: '{"ok":true}' })))
      .resolves.toEqual({ ok: true })
  })

  it('rejects unsafe cross-origin browser mutations while allowing local dev origins', () => {
    expect(() => assertSafeBrowserMutation(new Request('http://127.0.0.1/api/change', { method: 'POST', headers: { origin: 'https://evil.example' } })))
      .toThrow(RequestSecurityError)
    expect(() => assertSafeBrowserMutation(new Request('http://127.0.0.1/api/change', { method: 'POST', headers: { origin: 'http://localhost:5173' } }), { allowLoopbackDev: true })).not.toThrow()
  })

  it('applies explicit per-key limits and resets expired buckets', () => {
    let now = 0
    const limiter = new InProcessRateLimiter(() => now)
    expect(limiter.consume('user:1', 2, 100).allowed).toBe(true)
    expect(limiter.consume('user:1', 2, 100).allowed).toBe(true)
    expect(limiter.consume('user:1', 2, 100).allowed).toBe(false)
    now = 100
    expect(limiter.consume('user:1', 2, 100).allowed).toBe(true)
  })

  it('uses authenticated identity or a route fallback without using cookie contents', () => {
    expect(rateLimitKey('auth', '/api/auth/sign-in', 'user-1')).toBe('auth:user:user-1')
    expect(rateLimitKey('auth', '/api/auth/sign-in')).toBe('auth:route:/api/auth/sign-in')
  })
})
