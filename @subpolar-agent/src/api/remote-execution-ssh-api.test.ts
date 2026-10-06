import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { respondSSHHostKey } from './ssh'

const fetcher = vi.fn<typeof fetch>()
beforeEach(() => {
  fetcher.mockReset()
  vi.stubGlobal('fetch', fetcher)
})
afterEach(() => vi.unstubAllGlobals())

describe('remote execution legacy host-key response API', () => {
  it('never sends trust approval without a deployed backend verification flow', async () => {
    await expect(respondSSHHostKey('request-1', true)).rejects.toMatchObject({ code: 'SSH_TRANSPORT_UNAVAILABLE' })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('preserves the existing reject wire contract and returns only an acknowledgement', async () => {
    fetcher.mockResolvedValue(new Response(JSON.stringify({ success: true, privateKey: 'SECRET' })))
    await expect(respondSSHHostKey('request-1', false)).resolves.toEqual({ success: true })
    expect(fetcher).toHaveBeenCalledWith(expect.stringContaining('/api/ssh/host-key/respond'), expect.objectContaining({
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId: 'request-1', response: 'reject' }),
    }))
  })

  it.each([undefined, null, {}, { success: false, error: 'SECRET' }, { success: 'true' }])('does not acknowledge malformed or negative responses: %s', async (response) => {
    fetcher.mockResolvedValue(new Response(JSON.stringify(response)))
    await expect(respondSSHHostKey('request-1', false)).rejects.toMatchObject({ code: 'SSH_RESPONSE_FAILED', message: 'SSH host-key rejection was not acknowledged' })
  })

  it('does not expose credential-bearing backend errors or misreport a missing route as success', async () => {
    fetcher.mockResolvedValue(new Response(JSON.stringify({ error: 'password=SECRET', code: 'SECRET', detail: 'SECRET' }), { status: 404 }))
    const response = respondSSHHostKey('request-1', false)
    await expect(response).rejects.toMatchObject({ statusCode: 404, code: 'SSH_RESPONSE_FAILED', message: 'SSH host-key rejection was not acknowledged' })
    await response.catch((error: unknown) => {
      expect(JSON.stringify(error)).not.toContain('SECRET')
    })
  })

  it('redacts network exception text', async () => {
    fetcher.mockRejectedValue(new Error('privateKey=SECRET'))
    await expect(respondSSHHostKey('request-1', false)).rejects.toMatchObject({ code: 'SSH_RESPONSE_FAILED', message: 'SSH host-key rejection was not acknowledged', data: undefined })
  })

  it.each(['', 'request\n1', 'request 1', 'a'.repeat(257)])('rejects invalid request IDs before network access: %s', async (requestId) => {
    await expect(respondSSHHostKey(requestId, false)).rejects.toMatchObject({ code: 'INVALID_SSH_RESPONSE' })
    expect(fetcher).not.toHaveBeenCalled()
  })
})
