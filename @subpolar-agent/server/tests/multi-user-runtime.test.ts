import { afterEach, describe, expect, it, vi } from 'vitest'
import { InMemoryCredentialStore } from '@earendil-works/pi-ai'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { createProviderRuntime, createSharedProviderCatalogRuntime, composeProviderRuntimeId, type ProviderRuntimeAccountService } from '../application/runtime/provider-runtime.ts'
import type { ProviderAccount } from '../persistence/provider-accounts.ts'
import { assertTenantSession, tenantSessionKey } from '../application/runtime/tenant-runtime.ts'
import { authenticateProxyRuntime, proxyModel } from '../application/runtime/owner-bound-proxy.ts'
import { createBridgeRequestHandler } from '../bridge-request-handler.ts'
import { createStatelessSubpolarAgentRuntime } from '../application/runtime/stateless-subpolar-agent-runtime.ts'

const account: ProviderAccount = { instanceId: 'same-account', providerType: 'openai', displayName: 'Test', authType: 'api_key', status: 'active', metadata: {}, hasCredential: true, createdAt: 1, updatedAt: 1 }
function service(): ProviderRuntimeAccountService {
  return {
    listAccounts: async (owner) => owner === 'empty' ? [] : [{ ...account }],
    getAccount: async (owner, id) => owner !== 'empty' && id === account.instanceId ? { ...account } : null,
    loadCredential: async (owner) => ({ type: 'api_key', key: `stub-${owner}` }),
    updateAccount: vi.fn(), deleteAccount: vi.fn(),
  }
}
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })

describe('multi-user runtime credential boundary', () => {
  it('keeps the shared catalog unconfigured even when host environment has an API key', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'stub-host-key')
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected network') }))
    const catalog = await createSharedProviderCatalogRuntime()
    expect(await catalog.getAuth('openai')).toBeUndefined()
    expect(catalog.getProviderAuthStatus('openai').configured).toBe(false)
    expect(catalog.getModels('openai').length).toBeGreaterThan(0)
    expect(catalog.getProvider('openai')?.auth.oauth?.loginLabel).toBe('Sign in with ChatGPT')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('never delegates to credential/config closures in a shared runtime', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'stub-host-key')
    const shared = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false })
    shared.registerProvider('openai', { apiKey: 'stub-server-local', headers: { 'x-server-secret': 'stub-header' } })
    const runtime = await createProviderRuntime({ userId: 'alice', accountService: service(), baseRuntime: shared })
    const id = composeProviderRuntimeId('openai', account.instanceId)
    const auth = await runtime.getAuth(runtime.getModels(id)[0]!)
    expect(auth?.auth.apiKey).toBe('stub-alice')
    expect(JSON.stringify(auth)).not.toContain('stub-server-local')
    expect(JSON.stringify(auth)).not.toContain('stub-header')
    expect(runtime.getModel('openai', runtime.getModels(id)[0]!.id)).toBeUndefined()
    const empty = await createProviderRuntime({ userId: 'empty', accountService: service(), baseRuntime: shared })
    expect(empty.getModels()).toEqual([])
    expect(await empty.getAuth(id)).toBeUndefined()
    await expect(createProviderRuntime({ userId: 'alice', accountService: service(), accounts: [{ ...account, providerType: 'server-custom' }], baseRuntime: shared })).rejects.toThrow('Owned custom provider inference')
  })

  it('concurrent inference with identical account ids sends only each owner credential', async () => {
    const requests: string[] = []
    const stubFetch = vi.fn(async (_input: unknown, init?: RequestInit) => {
      requests.push(new Headers(init?.headers).get('authorization')!)
      await Promise.resolve()
      return new Response(`data: ${JSON.stringify({ type: 'response.completed', response: { id: 'stub', status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 } } })}\n\n`, { headers: { 'content-type': 'text/event-stream' } })
    })
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected live network') }))
    const runtimes = await Promise.all(['alice', 'bob'].map((userId) => createProviderRuntime({ userId, accountService: service() })))
    const id = composeProviderRuntimeId('openai', account.instanceId)
    const results = await Promise.all(runtimes.map((runtime) => runtime.completeSimple(runtime.getModels(id)[0]!, { messages: [{ role: 'user', content: 'stub request', timestamp: 1 }] }, { fetch: Object.assign(stubFetch, { preconnect: vi.fn() }) as typeof fetch, maxRetries: 0 })))
    expect(results.map((result) => result.stopReason)).not.toContain('error')
    expect(requests.sort()).toEqual(['Bearer stub-alice', 'Bearer stub-bob'])
    expect(results.map((result) => result.provider)).toEqual([id, id])
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('multi-user caller boundary', () => {
  it('proxy tokens resolve only their persisted owner and require qualified owned models', async () => {
    const calls: string[] = []
    const runtimeForOwner = async (ownerId: string) => {
      calls.push(ownerId)
      return createProviderRuntime({ userId: ownerId, accountService: service() })
    }
    const authenticate = async (secret: string) => secret === 'alice-token' ? { ownerId: 'alice' } : null
    expect(await authenticateProxyRuntime('invalid', { authenticate, runtimeForOwner })).toBeUndefined()
    expect(calls).toEqual([])
    const runtime = (await authenticateProxyRuntime('alice-token', { authenticate, runtimeForOwner }))!
    const id = composeProviderRuntimeId('openai', account.instanceId)
    const modelId = runtime.getModels(id)[0]!.id
    expect(calls).toEqual(['alice'])
    expect(proxyModel(runtime, { providerID: id, modelID: modelId })).toBeDefined()
    expect(proxyModel(runtime, { providerID: 'openai', modelID: modelId })).toBeUndefined()
    expect(proxyModel(runtime, undefined)).toBeUndefined()
    expect(proxyModel(runtime, { providerID: 'openai~foreign', modelID: modelId })).toBeUndefined()
  })
  it('uses collision-free owner/session keys and rejects retargeted records', () => {
    expect(tenantSessionKey('alice', 'same')).not.toBe(tenantSessionKey('bob', 'same'))
    expect(tenantSessionKey('a:b', 'c')).not.toBe(tenantSessionKey('a', 'b:c'))
    expect(() => assertTenantSession('alice', 'one', { userId: 'bob', id: 'one' })).toThrow('mismatch')
    expect(() => assertTenantSession('alice', 'one', { userId: 'alice', id: 'two' })).toThrow('mismatch')
  })

  it.each(['/api/sessions/same/rpc', '/api/session/same/prompt', '/api/providers', '/api/settings'])('does not let an installation token select a tenant on %s', async (path) => {
    const database = vi.fn()
    const handle = createBridgeRequestHandler({ internalToken: 'stub-installation', requestId: () => 'request', json: (value: unknown, status = 200) => Response.json(value, { status }), applicationDatabase: database })
    const response = await handle(new Request(`http://localhost${path}`, { method: 'POST', headers: { authorization: 'Bearer stub-installation' } }))
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ error: { code: 'INTERNAL_ROUTE_DENIED' } })
    expect(database).not.toHaveBeenCalled()
  })

  it.each(['principal', 'session', 'run'])('rejects a retargeted resolved %s before execution or persistence', async (mismatch) => {
    const collection = vi.fn()
    const execute = vi.fn()
    const runtime = createStatelessSubpolarAgentRuntime({ ownerId: 'alice', client: { collection } as never, gateway: {} as never, execute,
      resolveContext: async () => ({ principal: { id: mismatch === 'principal' ? 'bob' : 'alice', kind: 'user' }, sessionId: mismatch === 'session' ? 'foreign' : 'same', requestId: 'req', runId: mismatch === 'run' ? 'foreign' : 'run' }),
    })
    await expect(runtime.runPrompt({ ownerId: 'alice', sessionId: 'same', runId: 'run', requestId: 'req', prompt: 'stub' })).rejects.toThrow('tenant or run mismatch')
    expect(collection).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
  })

  it('rejects a stateless caller owner mismatch before touching the database', async () => {
    const collection = vi.fn()
    const runtime = createStatelessSubpolarAgentRuntime({ ownerId: 'alice', client: { collection } as never, gateway: {} as never, resolveContext: vi.fn(), execute: vi.fn() })
    await expect(runtime.runPrompt({ ownerId: 'bob', sessionId: 'same', runId: 'run', requestId: 'req', prompt: 'stub' })).rejects.toThrow('owner mismatch')
    expect(collection).not.toHaveBeenCalled()
  })
})
