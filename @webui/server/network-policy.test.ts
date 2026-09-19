import { createServer } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { fetchWithNetworkPolicy, NetworkPolicyError, networkPolicyFromMetadata, readBoundedResponse, resolveAndValidateHttpUrl, validateHttpUrl } from './network-policy'

describe('network policy', () => {
  it('rejects private hosts unless explicitly allowed', () => {
    expect(() => validateHttpUrl('http://127.0.0.1:8080')).toThrow(NetworkPolicyError)
    expect(() => validateHttpUrl('http://127.0.0.1:8080', { allowLoopback: true })).not.toThrow()
    expect(() => validateHttpUrl('file:///etc/passwd')).toThrow(NetworkPolicyError)
    expect(() => validateHttpUrl('http://127.0.0.1.nip.io')).toThrow(NetworkPolicyError)
    expect(() => validateHttpUrl('http://dev.localhost')).toThrow(NetworkPolicyError)
    expect(() => validateHttpUrl('http://[fe80::1]')).toThrow(NetworkPolicyError)
    expect(() => validateHttpUrl('http://[::ffff:127.0.0.1]')).toThrow(NetworkPolicyError)
    expect(() => validateHttpUrl('http://127.0.0.1', { allowedHosts: ['127.0.0.1'] })).toThrow(NetworkPolicyError)
    expect(() => validateHttpUrl('https://untrusted.example')).toThrow(NetworkPolicyError)
  })

  it('does not accept network exemptions from registration metadata', () => {
    expect(networkPolicyFromMetadata({ allowPrivateHosts: true, allowLoopback: true, allowedHosts: ['127.0.0.1'] })).not.toMatchObject({ allowPrivateHosts: true, allowLoopback: true, allowedHosts: ['127.0.0.1'] })
  })

  it('validates redirects before following them and strips credentials', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } }))
    const publicDns = async () => ['93.184.216.34']
    await expect(fetchWithNetworkPolicy('https://example.com/start', { headers: { authorization: 'Bearer secret', cookie: 'session=secret' } }, { allowedHosts: ['example.com'] }, fetcher, publicDns))
      .rejects.toMatchObject({ code: 'PRIVATE_HOST' })
    expect(fetcher).toHaveBeenCalledTimes(1)

    const redirected = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: '/next' } }))
      .mockResolvedValueOnce(new Response('ok'))
    await fetchWithNetworkPolicy('https://example.com/start', { headers: {
      authorization: 'Bearer secret', cookie: 'session=secret', 'x-auth-token': 'secret', 'x-access-token': 'secret', 'x-api-key': 'secret', 'api-key': 'secret', 'proxy-authorization': 'secret', 'x-secret-value': 'secret', 'x-password': 'secret', 'x-credential': 'secret', 'x-trace': 'safe'
    } }, { allowedHosts: ['example.com'] }, redirected, publicDns)
    const secondHeaders = redirected.mock.calls[1]?.[1]?.headers
    const headers = new Headers(secondHeaders)
    for (const name of ['authorization', 'cookie', 'x-auth-token', 'x-access-token', 'x-api-key', 'api-key', 'proxy-authorization', 'x-secret-value', 'x-password', 'x-credential']) expect(headers.has(name)).toBe(false)
    expect(headers.get('x-trace')).toBe('safe')
  })

  it('enforces response size and timeout limits', async () => {
    const oversized = new Response('12345', { headers: { 'content-length': '5' } })
    await expect(fetchWithNetworkPolicy('https://example.com', {}, { allowedHosts: ['example.com'], maxResponseBytes: 4 }, vi.fn<typeof fetch>().mockResolvedValue(oversized), async () => ['93.184.216.34']))
      .rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE' })

    const fetcher = vi.fn<typeof fetch>().mockImplementation((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    }))
    await expect(fetchWithNetworkPolicy('https://example.com', {}, { allowedHosts: ['example.com'], timeoutMs: 1 }, fetcher, async () => ['93.184.216.34'])).rejects.toMatchObject({ code: 'TIMEOUT' })
    await expect(readBoundedResponse(new Response('12345'), 4)).rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE' })
  })

  it('checks DNS answers even for configured trusted hosts', async () => {
    await expect(resolveAndValidateHttpUrl('https://public.example', {}, async () => ['10.0.0.8']))
      .rejects.toMatchObject({ code: 'UNTRUSTED_HOSTNAME' })
    await expect(resolveAndValidateHttpUrl('https://trusted.example', { allowedHosts: ['trusted.example'] }, async () => ['127.0.0.1']))
      .rejects.toMatchObject({ code: 'PRIVATE_HOST' })
    await expect(resolveAndValidateHttpUrl('https://trusted.example', { allowedHosts: ['trusted.example'], allowPrivateHosts: true }, async () => ['127.0.0.1']))
      .resolves.toBeInstanceOf(URL)
    await expect(resolveAndValidateHttpUrl('https://missing.example', { allowedHosts: ['missing.example'] }, async () => []))
      .rejects.toMatchObject({ code: 'DNS_RESOLUTION_FAILED' })
  })

  it('pins the validated address on the default transport while preserving Host', async () => {
    const server = createServer((request, response) => {
      const address = server.address()
      if (!address || typeof address === 'string' || request.headers.host !== `pin.example:${address.port}`) {
        response.statusCode = 400
        response.end('bad host')
        return
      }
      response.end('pinned')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('test server did not expose a port')
      const response = await fetchWithNetworkPolicy(`http://pin.example:${address.port}/check`, {}, { allowedHosts: ['pin.example'], allowLoopback: true }, undefined, async () => ['127.0.0.1'])
      await expect(response.text()).resolves.toBe('pinned')
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    }
  })
})
