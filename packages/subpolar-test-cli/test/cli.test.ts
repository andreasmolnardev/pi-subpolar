import { describe, expect, it } from 'bun:test'
import { parseArgs, planRequest, runCli } from '../src/cli.ts'

describe('subpolar-test-cli argument parsing', () => {
  it('reads API URL and token from environment without exposing either', () => {
    expect(parseArgs(['automations', 'list'], {
      SUBPOLAR_API_URL: 'http://localhost:4173/',
      SUBPOLAR_API_TOKEN: 'normal-user-token',
    })).toEqual({
      baseUrl: 'http://localhost:4173',
      token: 'normal-user-token',
      json: false,
      help: false,
      command: ['automations', 'list'],
    })
  })

  it('parses API flags and safely encodes resource identifiers', () => {
    expect(parseArgs(['--base-url', 'https://example.test', '--token', 'secret', '--json', 'automations', 'get', 'auto/a'])).toMatchObject({
      baseUrl: 'https://example.test',
      token: 'secret',
      json: true,
      command: ['automations', 'get', 'auto/a'],
    })
    expect(planRequest(['automations', 'get', 'auto/a'])).toEqual({ method: 'GET', path: '/api/v1/automations/auto%2Fa' })
  })

  it('maps each supported command to the public API path', () => {
    expect(planRequest(['automations', 'list'])).toEqual({ method: 'GET', path: '/api/v1/automations' })
    expect(planRequest(['automations', 'create', '{"agentId":"research"}'])).toEqual({ method: 'POST', path: '/api/v1/automations', body: { agentId: 'research' } })
    expect(planRequest(['automations', 'enable', 'a1'])).toEqual({ method: 'POST', path: '/api/v1/automations/a1/enable' })
    expect(planRequest(['automations', 'disable', 'a1'])).toEqual({ method: 'POST', path: '/api/v1/automations/a1/disable' })
    expect(planRequest(['automations', 'run', 'a1', '{"hello":"world"}'])).toEqual({ method: 'POST', path: '/api/v1/automations/a1/run', body: { payload: { hello: 'world' } } })
    expect(planRequest(['automations', 'executions', 'a1'])).toEqual({ method: 'GET', path: '/api/v1/automations/a1/executions' })
    expect(planRequest(['automations', 'execution', 'a1', 'e1'])).toEqual({ method: 'GET', path: '/api/v1/automations/a1/executions/e1' })
    expect(planRequest(['automations', 'cancel', 'a1', 'e1'])).toEqual({ method: 'POST', path: '/api/v1/automations/a1/executions/e1/cancel' })
  })

  it('sends bearer auth and never prints the token in success or error output', async () => {
    const token = 'private-normal-user-token'
    const output: string[] = []
    const errors: string[] = []
    const calls: Array<{ url: string; authorization: string | null; body: string | null }> = []
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      calls.push({ url: String(input), authorization: headers.get('authorization'), body: typeof init?.body === 'string' ? init.body : null })
      return new Response(JSON.stringify({ error: `Bad token: ${token}` }), { status: 401 })
    }) as typeof fetch
    const code = await runCli(['automations', 'run', 'a1'], {
      env: { SUBPOLAR_API_URL: 'http://localhost:4173', SUBPOLAR_API_TOKEN: token },
      fetch: fetcher,
    }, { stdout: (text) => output.push(text), stderr: (text) => errors.push(text) })
    expect(code).toBe(1)
    expect(calls).toEqual([{
      url: 'http://localhost:4173/api/v1/automations/a1/run',
      authorization: `Bearer ${token}`,
      body: '{}',
    }])
    expect(output.join('')).not.toContain(token)
    expect(errors.join('')).not.toContain(token)
    expect(errors.join('')).toContain('[redacted]')
  })

  it('redacts a credential if an API response unexpectedly echoes it', async () => {
    const token = 'token-that-must-not-print'
    const output: string[] = []
    const code = await runCli(['automations', 'list'], {
      env: { SUBPOLAR_API_TOKEN: token },
      fetch: (async () => new Response(JSON.stringify({ automations: [], debug: token }), { status: 200 })) as typeof fetch,
    }, { stdout: (text) => output.push(text), stderr: () => {} })
    expect(code).toBe(0)
    expect(output.join('')).not.toContain(token)
    expect(output.join('')).toContain('[redacted]')
  })
})
