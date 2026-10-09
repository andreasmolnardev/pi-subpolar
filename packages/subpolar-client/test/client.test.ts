import { describe, expect, it } from 'bun:test'
import { SubpolarClient, SubpolarClientError, type AutomationDefinition } from '../src/index.ts'

describe('SubpolarClient automations', () => {
  it('uses the public API routes and typed envelopes', async () => {
    const calls: Array<{ url: string; method: string; body?: unknown }> = []
    const automation: AutomationDefinition = {
      id: 'auto/1',
      name: 'Daily digest',
      enabled: true,
      agentId: 'research',
      promptTemplate: 'Summarize {{ trigger.payload }}',
      trigger: { type: 'manual' },
      actions: [],
      createdAt: '2026-10-09T08:00:00.000Z',
      updatedAt: '2026-10-09T08:00:00.000Z',
    }
    const client = new SubpolarClient('http://localhost:4173', {
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({
          url: String(input),
          method: init?.method ?? 'GET',
          body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
        })
        const path = String(input)
        const body = path.endsWith('/webhook-secret')
          ? { webhook: { credentialRef: 'webhook-credential-1', url: 'https://subpolar.test/api/webhooks/abc', secret: 'one-time-secret' } }
          : path.endsWith('/run')
          ? { execution: { id: 'exec-1', automationId: 'auto/1', agentId: 'research', status: 'pending', createdAt: '2026-10-09T08:00:00.000Z' } }
          : path.endsWith('/executions')
            ? { executions: [] }
            : { automation }
        return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }) as typeof fetch,
    })

    expect(await client.getAutomation('auto/1')).toEqual({ automation })
    expect(await client.rotateWebhookSecret('auto/1')).toMatchObject({ webhook: { credentialRef: 'webhook-credential-1', secret: 'one-time-secret' } })
    expect(await client.runAutomation('auto/1', { idempotencyKey: 'manual-1' })).toMatchObject({ execution: { id: 'exec-1' } })
    expect(await client.listExecutions('auto/1')).toEqual({ executions: [] })
    expect(calls.map(({ url, method }) => [url, method])).toEqual([
      ['http://localhost:4173/api/v1/automations/auto%2F1', 'GET'],
      ['http://localhost:4173/api/v1/automations/auto%2F1/webhook-secret', 'POST'],
      ['http://localhost:4173/api/v1/automations/auto%2F1/run', 'POST'],
      ['http://localhost:4173/api/v1/automations/auto%2F1/executions', 'GET'],
    ])
    expect(calls[2]?.body).toEqual({ idempotencyKey: 'manual-1' })
  })

  it('surfaces public API errors with status and code', async () => {
    const client = new SubpolarClient('', {
      fetch: (async () => new Response(JSON.stringify({ error: 'Forbidden', code: 'FORBIDDEN' }), { status: 403 })) as typeof fetch,
    })
    await expect(client.listAutomations()).rejects.toBeInstanceOf(SubpolarClientError)
    await expect(client.listAutomations()).rejects.toMatchObject({ message: 'Forbidden', status: 403, code: 'FORBIDDEN' })
  })
})
