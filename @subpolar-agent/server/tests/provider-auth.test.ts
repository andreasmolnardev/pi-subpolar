import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type PocketBase from 'pocketbase'
import { describe, expect, it, vi } from 'vitest'
import { getSupportedThinkingLevels, InMemoryCredentialStore } from '@earendil-works/pi-ai'
import { ModelRuntime, SettingsManager } from '@earendil-works/pi-coding-agent'
import { createProviderLoginRuntime, createProviderRuntime, composeProviderRuntimeId } from '../application/runtime/provider-runtime.ts'
import type {
  Api,
  AuthInteraction,
  AuthType,
  Credential,
  Model,
  Provider as PiProvider,
} from '@earendil-works/pi-ai'
import { ProviderAccountService } from '../persistence/provider-accounts.ts'
import {
  composeModelSelection,
  composeProviderInstanceId,
  createProviderCatalog,
  parseModelSelection,
  parseProviderInstanceId,
  type ProviderCatalogRuntime,
} from '../application/runtime/provider-catalog.ts'
import {
  ProviderLoginFlowController,
  type ProviderLoginFlowReference,
  type ProviderRuntimeFactoryContext,
} from '../application/runtime/provider-login-flow.ts'

type FakeRecord = Record<string, unknown> & { id: string }

type FakeCollectionName = 'provider_accounts' | 'provider_account_credentials'

class FakeCollection {
  readonly records: FakeRecord[] = []
  private nextId = 1

  constructor(private readonly name: FakeCollectionName) {}

  async getFirstListItem(filter: string): Promise<FakeRecord> {
    const record = this.records.find((candidate) => this.matches(candidate, filter))
    if (!record) throw Object.assign(new Error('Record not found'), { status: 404 })
    return { ...record }
  }

  async getFullList(options?: { filter?: string }): Promise<FakeRecord[]> {
    return this.records
      .filter((record) => this.matches(record, options?.filter ?? ''))
      .map((record) => ({ ...record }))
  }

  async create(data: Record<string, unknown>): Promise<FakeRecord> {
    const record = { ...data, id: `${this.name === 'provider_accounts' ? 'account' : 'credential'}-${this.nextId++}` }
    this.records.push(record)
    return { ...record }
  }

  async update(id: string, data: Record<string, unknown>): Promise<FakeRecord> {
    const record = this.records.find((candidate) => candidate.id === id)
    if (!record) throw Object.assign(new Error('Record not found'), { status: 404 })
    Object.assign(record, data)
    return { ...record }
  }

  async delete(id: string): Promise<boolean> {
    const index = this.records.findIndex((candidate) => candidate.id === id)
    if (index < 0) throw Object.assign(new Error('Record not found'), { status: 404 })
    this.records.splice(index, 1)
    return true
  }

  private matches(record: FakeRecord, filter: string): boolean {
    const userId = /user_id = "([^"]*)"/.exec(filter)?.[1]
    const instanceId = /instance_id = "([^"]*)"/.exec(filter)?.[1]
    return (userId === undefined || record.user_id === userId)
      && (instanceId === undefined || record.instance_id === instanceId)
  }
}

class FakePocketBase {
  readonly accounts = new FakeCollection('provider_accounts')
  readonly credentials = new FakeCollection('provider_account_credentials')

  collection(name: string): FakeCollection {
    if (name === 'provider_accounts') return this.accounts
    if (name === 'provider_account_credentials') return this.credentials
    throw new Error(`Unexpected collection: ${name}`)
  }
}

const encryptionKey = '01234567890123456789012345678901'

function accountService(
  client: FakePocketBase,
  instanceIds: string[],
  now = 1_000,
): ProviderAccountService {
  return new ProviderAccountService(client as unknown as PocketBase, {
    encryptionKey,
    instanceId: () => {
      const instanceId = instanceIds.shift()
      if (!instanceId) throw new Error('No test instance id available')
      return instanceId
    },
    now: () => now,
  })
}

function apiKey(key: string): Credential {
  return { type: 'api_key', key }
}

function oauthCredential(): Credential {
  return { type: 'oauth', refresh: 'refresh-token', access: 'access-token', expires: 9_999 }
}

async function tick(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

async function waitForPrompt(
  controller: ProviderLoginFlowController,
  reference: ProviderLoginFlowReference,
): Promise<NonNullable<Awaited<ReturnType<ProviderLoginFlowController['getStatus']>>['currentPrompt']>> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const status = await controller.getStatus(reference)
    if (status.currentPrompt) return status.currentPrompt
    if (status.phase !== 'pending') throw new Error(`Login flow ended as ${status.phase}`)
    await tick()
  }
  throw new Error('Timed out waiting for provider login prompt')
}

async function waitForPhase(
  controller: ProviderLoginFlowController,
  reference: ProviderLoginFlowReference,
  phase: 'completed' | 'failed' | 'cancelled' | 'expired',
) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const status = await controller.getStatus(reference)
    if (status.phase === phase) return status
    await tick()
  }
  throw new Error(`Timed out waiting for login flow phase ${phase}`)
}

describe('native OpenAI Codex OAuth integration (separate from direct ChatGPT sign-in)', () => {
  it('logs in via native device code, saves owner-scoped accounts, and selects models without sharing credentials', async () => {
    const client = new FakePocketBase()
    const service = accountService(client, ['personal', 'work'])
    const sharedCredentials = new InMemoryCredentialStore()
    const shared = await ModelRuntime.create({ credentials: sharedCredentials, modelsPath: null, refreshOnCreate: false })
    const provider = shared.getProvider('openai-codex')!
    expect(provider.auth.oauth?.isSubscription).toBe(true)
    const access = `header.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'chatgpt-test' } })).toString('base64url')}.signature`
    const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/usercode')) return Response.json({ device_auth_id: 'test-device', user_code: 'ABCD-EFGH', interval: 0 })
      if (url.endsWith('/deviceauth/token')) return Response.json({ authorization_code: 'test-code', code_verifier: 'test-verifier' })
      if (url.endsWith('/oauth/token')) return Response.json({ access_token: access,
              refresh_token: String(init?.body).includes('grant_type=refresh_token') ? 'rotated-private-refresh' : 'private-refresh', expires_in: 3600 })
      throw new Error(`Unexpected network request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    try {
      const controller = new ProviderLoginFlowController({
        runtimeFactory: () => createProviderLoginRuntime(provider),
        credentialSink: async (context, credential) => {
          await service.createAccount(context.ownerId, { providerType: context.runtimeProviderId,
            displayName: context.displayName ?? 'ChatGPT', authType: credential.type, credential })
        },
      })
      for (const displayName of ['Personal', 'Work']) {
        const flow = await controller.start({ ownerId: 'owner-a', providerInstanceId: 'openai-codex', type: 'oauth', displayName })
        const reference = { ownerId: 'owner-a', flowId: flow.flowId }
        const prompt = await waitForPrompt(controller, reference)
        expect(prompt.prompt).toMatchObject({ type: 'select', options: [
          { id: 'browser', label: 'Browser login (default)' },
          { id: 'device_code', label: 'Device code login (headless)' },
        ] })
        await controller.respond({ ...reference, promptId: prompt.promptId, value: 'device_code' })
        const completed = await waitForPhase(controller, reference, 'completed')
        const events = await controller.getEvents(reference)
        expect(events.events).toContainEqual(expect.objectContaining({ type: 'device_code', userCode: 'ABCD-EFGH' }))
        const publicState = JSON.stringify({ completed, events })
        expect(publicState).not.toContain(access)
        expect(publicState).not.toContain('private-refresh')
        await expect(controller.getStatus({ ownerId: 'owner-b', flowId: flow.flowId })).rejects.toMatchObject({ code: 'FLOW_NOT_FOUND' })
      }
      expect(await sharedCredentials.list()).toEqual([])
      expect(await service.listAccounts('owner-b')).toEqual([])
      const accounts = await service.listAccounts('owner-a')
      expect(accounts.map((account) => account.displayName).sort()).toEqual(['Personal', 'Work'])
      const runtime = await createProviderRuntime({ userId: 'owner-a', accountService: service, baseRuntime: shared })
      for (const account of accounts) {
        const id = composeProviderRuntimeId('openai-codex', account.instanceId)
        const models = await runtime.getAvailable(id)
        expect(models.length).toBeGreaterThan(0)
        expect(runtime.getModel(id, models[0]!.id)).toBeDefined()
        expect((await runtime.getAuth(models[0]!))?.auth.apiKey).toBe(access)
      }
      const firstAccount = accounts[0]!
      await service.updateAccount('owner-a', firstAccount.instanceId, { credential: {
        type: 'oauth', access, refresh: 'private-refresh', expires: Date.now() - 1, accountId: 'chatgpt-test',
      } })
      const refreshedRuntime = await createProviderRuntime({ userId: 'owner-a', accountService: service, baseRuntime: shared })
      await refreshedRuntime.getAuth(composeProviderRuntimeId('openai-codex', firstAccount.instanceId))
      expect(await service.loadCredential('owner-a', firstAccount.instanceId)).toMatchObject({ refresh: 'rotated-private-refresh' })
      expect(await service.loadCredential('owner-a', accounts[1]!.instanceId)).toMatchObject({ refresh: 'private-refresh' })
      expect(await sharedCredentials.list()).toEqual([])
      expect(JSON.stringify(createProviderCatalog(shared, { accounts: accounts.map((account) => ({
        id: account.instanceId, provider_id: account.providerType, display_name: account.displayName,
        auth_type: account.authType, status: 'authenticated',
      })) }))).not.toContain('private-refresh')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('native OpenAI Sign in with ChatGPT', () => {
  const deviceId = 'bda98322-0154-4b61-a805-0319125e7b20'
  const tokenResponse = { access_token: 'direct-access', refresh_token: 'direct-refresh',
    id_token: 'mock-id-token', expires_in: 3600, scope: 'openid chatgpt.tokens.use.direct' }

  it('persists the native installation UUID across reloads and ignores project device IDs', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'subpolar-provider-device-'))
    try {
      const cwd = join(directory, 'project')
      const agentDir = join(directory, 'agent')
      mkdirSync(join(cwd, '.pi'), { recursive: true })
      writeFileSync(join(cwd, '.pi', 'settings.json'), JSON.stringify({ deviceId }))
      const settings = SettingsManager.create(cwd, agentDir)
      const id = settings.getOrCreateDeviceId()
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
      expect(id).not.toBe(deviceId)
      expect(settings.getOrCreateDeviceId()).toBe(id)
      await settings.flush()
      expect(SettingsManager.create(cwd, agentDir).getOrCreateDeviceId()).toBe(id)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('uses native registration, issued client ID, token refresh, account selection and Responses request rules', async () => {
    const client = new FakePocketBase()
    const service = accountService(client, ['direct', 'key'])
    const sharedCredentials = new InMemoryCredentialStore()
    const shared = await ModelRuntime.create({ credentials: sharedCredentials, modelsPath: null, refreshOnCreate: false })
    const provider = shared.getProvider('openai')!
    expect(provider.auth.oauth?.loginLabel).toBe('Sign in with ChatGPT')
    expect(provider.auth.apiKey).toBeDefined()
    expect(shared.getProvider('openai-codex')?.auth.oauth).toBeDefined()
    const catalog = createProviderCatalog(shared)
    expect(catalog.providers.find((entry) => entry.id === 'openai')?.authMethods).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'api_key' }),
      expect.objectContaining({ kind: 'subscription', label: 'Sign in with ChatGPT' }),
    ]))
    const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      expect(String(input)).toBe('https://auth.openai.com/api/accounts/oauth/token')
      const body = new URLSearchParams(String(init?.body))
      expect(body.get('client_id')).toBe('issued-client')
      expect(body.get('resource')).toBe('https://api.openai.com/v1')
      return Response.json({ ...tokenResponse, refresh_token: body.get('grant_type') === 'refresh_token' ? 'rotated-direct-refresh' : 'direct-refresh' })
    })
    vi.stubGlobal('fetch', fetchMock)
    try {
      const controller = new ProviderLoginFlowController({
        loginOptions: { getDeviceId: () => deviceId },
        runtimeFactory: () => createProviderLoginRuntime(provider),
        credentialSink: async (context, credential) => {
          await service.createAccount(context.ownerId, { providerType: context.runtimeProviderId,
            displayName: 'Direct ChatGPT', authType: credential.type, credential })
        },
      })
      const flow = await controller.start({ ownerId: 'owner-a', providerInstanceId: 'openai', type: 'oauth' })
      const reference = { ownerId: 'owner-a', flowId: flow.flowId }
      const prompt = await waitForPrompt(controller, reference)
      expect(prompt.prompt.type).toBe('manual_code')
      const events = await controller.getEvents(reference)
      const authUrl = events.events.find((event) => event.type === 'auth_url')!
      if (authUrl.type !== 'auth_url') throw new Error('Missing native authorization URL')
      const authorize = new URL(authUrl.url)
      expect(authorize.origin + authorize.pathname).toBe('https://auth.openai.com/api/accounts/authorize')
      expect(authorize.searchParams.get('client_id')).toBe('dynamic_agent_client')
      expect(authorize.searchParams.get('ext_agent_host_id')).toBe(`urn:uuid:${deviceId}`)
      expect(authorize.searchParams.get('scope')).toContain('chatgpt.tokens.use.direct')
      expect(authorize.searchParams.get('code_challenge_method')).toBe('S256')
      const redirect = new URL(authorize.searchParams.get('redirect_uri')!)
      redirect.search = new URLSearchParams({ code: 'mock-code', state: authorize.searchParams.get('state')!, client_id: 'issued-client' }).toString()
      await controller.respond({ ...reference, promptId: prompt.promptId, value: redirect.toString() })
      const completed = await waitForPhase(controller, reference, 'completed')
      expect(JSON.stringify(completed)).not.toContain('direct-access')
      await expect(controller.getStatus({ ownerId: 'owner-b', flowId: flow.flowId })).rejects.toMatchObject({ code: 'FLOW_NOT_FOUND' })
      const stored = await service.loadCredential('owner-a', 'direct')
      expect(stored).toMatchObject({ clientId: 'issued-client', scopes: ['openid', 'chatgpt.tokens.use.direct'] })
      await service.updateAccount('owner-a', 'direct', { credential: { ...stored!, expires: Date.now() - 1 } as Credential })
      await service.createAccount('owner-a', { providerType: 'openai', displayName: 'API key', authType: 'api_key', credential: apiKey('sk-test-key') })
      const runtime = await createProviderRuntime({ userId: 'owner-a', accountService: service, baseRuntime: shared })
      const directId = composeProviderRuntimeId('openai', 'direct')
      const keyId = composeProviderRuntimeId('openai', 'key')
      const model = runtime.getModels(directId).find((entry) => entry.reasoning)!
      expect(model.api).toBe('openai-responses')
      expect(getSupportedThinkingLevels(model)).toContain('medium')
      expect((await runtime.getAuth(model))?.auth.apiKey).toBe('direct-access')
      expect(await service.loadCredential('owner-a', 'direct')).toMatchObject({ refresh: 'rotated-direct-refresh' })
      expect((await runtime.getAuth(keyId))?.auth.apiKey).toBe('sk-test-key')
      const accountCatalog = createProviderCatalog(runtime)
      expect(accountCatalog.providers.find((entry) => entry.id === keyId)?.authMethods).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'api_key', status: expect.objectContaining({ state: 'authenticated' }) }),
        expect.objectContaining({ kind: 'subscription', status: expect.objectContaining({ state: 'unconfigured' }) }),
      ]))
      expect(await sharedCredentials.list()).toEqual([])
      expect(await service.listAccounts('owner-b')).toEqual([])
      const other = await createProviderRuntime({ userId: 'owner-b', accountService: service, baseRuntime: shared })
      expect(other.getModel(directId, model.id)).toBeUndefined()
      expect(await other.getAvailable()).toEqual([])

      const requests: { url: string; headers: Headers; body: Record<string, unknown> }[] = []
      const inferenceFetch = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        requests.push({ url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) })
        return new Response(`data: ${JSON.stringify({ type: 'response.completed', response: {
          id: 'resp_mock', status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 },
        } })}\n\n`, { headers: { 'content-type': 'text/event-stream' } })
      })
      for (const id of [directId, keyId]) {
        const selected = runtime.getModel(id, model.id)!
        const result = await runtime.completeSimple(selected, { systemPrompt: 'Test system prompt', messages: [{ role: 'user', content: 'Test only', timestamp: 1 }] }, {
          fetch: Object.assign(inferenceFetch, { preconnect: vi.fn() }), reasoning: 'medium', temperature: 0.2, maxTokens: 64, cacheRetention: 'long', maxRetries: 0,
        })
        expect(result.stopReason, result.errorMessage).not.toBe('error')
                expect(result.provider).toBe(id)
      }
      const stream = runtime.stream({ ...model, api: 'openai-responses' }, {
        systemPrompt: 'Test system prompt', messages: [{ role: 'user', content: 'Test only', timestamp: 1 }],
      }, { fetch: Object.assign(inferenceFetch, { preconnect: vi.fn() }), reasoningEffort: 'medium', maxRetries: 0 })
      const streamedEvents = []
      for await (const event of stream) {
        streamedEvents.push(event)
        if ('partial' in event) expect(event.partial.provider).toBe(directId)
        if (event.type === 'done') expect(event.message.provider).toBe(directId)
      }
      expect(streamedEvents.some((event) => event.type === 'done')).toBe(true)
      expect((await stream.result()).provider).toBe(directId)
      expect(requests).toHaveLength(3)
      for (const request of requests) {
        expect(request.url).toBe('https://api.openai.com/v1/responses')
        expect(request.body.model).toBe(model.id)
        expect(request.body.reasoning).toMatchObject({ effort: 'medium' })
        expect(JSON.stringify(request.body)).toContain('Test system prompt')
      }
      expect(requests[0]!.headers.get('authorization')).toBe('Bearer direct-access')
      for (const field of ['temperature', 'max_output_tokens', 'prompt_cache_retention', 'prompt_cache_options']) expect(requests[0]!.body).not.toHaveProperty(field)
      expect(requests[1]!.headers.get('authorization')).toBe('Bearer sk-test-key')
      expect(requests[1]!.body).toMatchObject({ temperature: 0.2, max_output_tokens: 64 })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it.each([
    { patch: { scope: 'openid' }, message: 'chatgpt.tokens.use.direct' },
    { patch: { id_token: undefined }, message: 'ID token' },
    { patch: { expires_in: 0 }, message: 'expires_in' },
    { patch: { access_token: '' }, message: 'access_token' },
  ])('rejects invalid native token responses: $message', async ({ patch, message }) => {
    const shared = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false })
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...tokenResponse, ...patch })))
    let authorize: URL | undefined
    try {
      await expect(shared.getProvider('openai')!.auth.oauth!.login({
        signal: new AbortController().signal,
        notify: (event) => { if (event.type === 'auth_url') authorize = new URL(event.url) },
        prompt: async () => `http://127.0.0.1:1455/auth/callback?code=mock-code&state=${authorize!.searchParams.get('state')}&client_id=issued-client`,
      }, { getDeviceId: () => deviceId })).rejects.toThrow(message)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

function catalogRuntime(): ProviderCatalogRuntime {
  const model = {
    id: 'models/gpt-4o',
    provider: 'same-provider',
    name: 'Model\u0000 Name',
    api: 'openai-completions',
    reasoning: 'yes',
    input: ['text', 'audio', 'image'],
    cost: { input: Number.NaN, output: 2, cacheRead: Number.POSITIVE_INFINITY, cacheWrite: 3 },
    contextWindow: Number.POSITIVE_INFINITY,
    maxTokens: 4_096,
  } as unknown as Model<Api>
  const provider = {
    id: 'same-provider',
    name: 'Same Provider',
    headers: { authorization: 'Bearer runtime-secret', 'x-provider-token': 'provider-secret' },
    auth: {
      apiKey: { name: 'Provider API key' },
      oauth: { name: 'Provider OAuth' },
    },
  } as unknown as PiProvider

  return {
    getProviders: () => [provider],
    getModels: (providerId?: string) => providerId === undefined || providerId === provider.id ? [model] : [],
  }
}

describe('provider account encryption and ownership', () => {
  it('stores encrypted credentials and exposes only non-secret account/status data', async () => {
    const client = new FakePocketBase()
    const service = accountService(client, ['account-a'])
    const secret = 'api-key-that-must-not-leak'

    const account = await service.createAccount('user-1', {
      providerType: 'same-provider',
      displayName: 'Primary account',
      authType: 'api_key',
      credential: apiKey(secret),
      metadata: { email: 'one@example.test', team: 'platform' },
    })

    expect(account).toMatchObject({
      instanceId: 'account-a',
      providerType: 'same-provider',
      authType: 'api_key',
      hasCredential: true,
    })
    expect(JSON.stringify(account)).not.toContain(secret)
    expect(JSON.stringify(await service.getAccountStatus('user-1', account.instanceId))).not.toContain(secret)

    const payload = String(client.credentials.records[0]?.payload)
    const envelope = JSON.parse(payload) as Record<string, unknown>
    expect(envelope).toMatchObject({ v: 1, alg: 'aes-256-gcm' })
    expect(typeof envelope.iv).toBe('string')
    expect(typeof envelope.tag).toBe('string')
    expect(typeof envelope.ciphertext).toBe('string')
    expect(payload).not.toContain(secret)
    expect(client.accounts.records[0]).not.toHaveProperty('credential')

    await expect(service.createAccount('user-1', {
      providerType: 'same-provider',
      displayName: 'Rejected metadata',
      authType: 'api_key',
      credential: apiKey('another-secret'),
      metadata: { access_token: 'must-be-rejected' },
    })).rejects.toThrow('metadata key access_token is not allowed')

    await expect(service.loadCredential('user-1', account.instanceId)).resolves.toEqual(apiKey(secret))
    expect(JSON.stringify(await service.getAccount('user-1', account.instanceId))).not.toContain(secret)
  })

  it('keeps two accounts for one provider separate and owner-scoped', async () => {
    const client = new FakePocketBase()
    const service = accountService(client, ['account-a', 'account-b', 'foreign-account'])

    const first = await service.createAccount('user-1', {
      providerType: 'same-provider',
      displayName: 'Work',
      authType: 'api_key',
      credential: apiKey('work-secret'),
    })
    const second = await service.createAccount('user-1', {
      providerType: 'same-provider',
      displayName: 'Personal',
      authType: 'api_key',
      credential: apiKey('personal-secret'),
    })
    const foreign = await service.createAccount('user-2', {
      providerType: 'same-provider',
      displayName: 'Other user',
      authType: 'oauth',
      credential: oauthCredential(),
    })

    expect(first.instanceId).not.toBe(second.instanceId)
    expect(first.providerType).toBe(second.providerType)
    expect((await service.listAccounts('user-1')).map((item) => item.instanceId)).toEqual(['account-a', 'account-b'])
    expect((await service.listAccounts('user-2')).map((item) => item.instanceId)).toEqual([foreign.instanceId])
    await expect(service.loadCredential('user-1', first.instanceId)).resolves.toEqual(apiKey('work-secret'))
    await expect(service.loadCredential('user-1', second.instanceId)).resolves.toEqual(apiKey('personal-secret'))
    await expect(service.getAccount('user-2', first.instanceId)).resolves.toBeNull()
    await expect(service.loadCredential('user-2', first.instanceId)).resolves.toBeNull()
    await expect(service.getAccountStatus('user-2', second.instanceId)).resolves.toBeNull()
  })
})

describe('provider selection and catalog sanitization', () => {
  it('round-trips qualified selections and rejects malformed delimiters', () => {
    const instanceId = composeProviderInstanceId('same/provider', 'account/one')
    const selection = composeModelSelection(instanceId, 'models/gpt/4o')

    expect(parseProviderInstanceId(instanceId)).toEqual({ providerId: 'same/provider', accountId: 'account/one' })
    expect(parseModelSelection(selection)).toEqual({ instanceId, modelId: 'models/gpt/4o' })
    expect(parseProviderInstanceId('bad%ZZ')).toBeUndefined()
    expect(parseModelSelection('')).toBeUndefined()
    expect(parseModelSelection('/model')).toBeUndefined()
    expect(parseModelSelection('instance/')).toBeUndefined()
    expect(parseModelSelection('%ZZ/model')).toBeUndefined()
  })

  it('includes the runtime instance and its models by default', () => {
    const catalog = createProviderCatalog(catalogRuntime())

    expect(catalog.providers[0]?.instances.map((item) => item.instanceId)).toEqual(['same-provider'])
    expect(catalog.models.map((model) => model.id)).toEqual(['same-provider/models%2Fgpt-4o'])
  })

  it('builds separate sanitized instances and models without provider secrets', () => {
    const secret = 'catalog-provider-secret'
    const catalog = createProviderCatalog(catalogRuntime(), {
      includeRuntimeInstance: false,
      accounts: [
        {
          provider_id: 'same-provider',
          id: 'account-a',
          display_name: 'Account\u0000 A',
          auth_method: 'api_key',
          status: 'authenticated',
          api_key: secret,
          access_token: secret,
        },
        {
          provider_id: 'same-provider',
          id: 'account-b',
          display_name: 'Account B',
          auth_method: 'oauth',
          status: 'expired',
          refresh_token: secret,
        },
      ],
    })

    const provider = catalog.providers[0]
    expect(provider).toMatchObject({ id: 'same-provider', source: 'mixed' })
    expect(provider?.instances.map((item) => item.instanceId)).toEqual(['same-provider~account-a', 'same-provider~account-b'])
    expect(provider?.instances[0]?.label).toBe('Account A')
    expect(provider?.instances[1]?.status).toMatchObject({ state: 'expired', configured: false })
    expect(catalog.models.map((model) => model.id)).toEqual([
      'same-provider~account-a/models%2Fgpt-4o',
      'same-provider~account-b/models%2Fgpt-4o',
    ])
    expect(catalog.models[0]).toMatchObject({
      instanceId: 'same-provider~account-a',
      providerId: 'same-provider',
      modelId: 'models/gpt-4o',
      name: 'Model Name',
      reasoning: false,
      input: ['text', 'image'],
      cost: { input: 0, output: 2, cacheRead: 0, cacheWrite: 3 },
      contextWindow: 0,
    })

    const serialized = JSON.stringify(catalog)
    expect(serialized).not.toContain(secret)
    expect(serialized).not.toContain('runtime-secret')
    expect(serialized).not.toContain('x-provider-token')
  })
})

describe('provider login flow controller', () => {
  it('runs an API-key login with a secret prompt and replayable non-secret events', async () => {
    const contexts: ProviderRuntimeFactoryContext[] = []
    const controller = new ProviderLoginFlowController({
      flowIdFactory: () => 'flow-api-key',
      providerInstances: {
        'same-provider~account-a': { runtimeProviderId: 'same-provider', accountContext: { accountId: 'account-a' } },
      },
      runtimeFactory: async (context) => {
        contexts.push(context)
        return {
          login: async (providerId: string, type: AuthType, interaction: AuthInteraction): Promise<Credential> => {
            expect(providerId).toBe('same-provider')
            expect(type).toBe('api_key')
            interaction.notify({ type: 'info', message: 'API key required' })
            const key = await interaction.prompt({ type: 'secret', message: 'Enter API key', placeholder: 'sk-...' })
            return apiKey(key)
          },
        }
      },
    })
    const reference = { ownerId: 'user-1', flowId: 'flow-api-key' }

    await expect(controller.start({ ...reference, providerInstanceId: 'same-provider~account-a', type: 'api_key' }))
      .resolves.toMatchObject({ phase: 'pending', providerInstanceId: 'same-provider~account-a' })
    const prompt = await waitForPrompt(controller, reference)
    expect(prompt.prompt).toEqual({ type: 'secret', message: 'Enter API key', placeholder: 'sk-...' })
    expect(contexts[0]).toMatchObject({
      ownerId: 'user-1',
      providerInstanceId: 'same-provider~account-a',
      runtimeProviderId: 'same-provider',
      accountContext: { accountId: 'account-a' },
      type: 'api_key',
    })

    const events = await controller.getEvents(reference)
    expect(events.events.map((event) => event.type)).toEqual(['info', 'prompt'])
    expect(events.events[1]).toMatchObject({ type: 'prompt', promptId: prompt.promptId, prompt: prompt.prompt })
    expect(JSON.stringify(events)).not.toContain('key-entered-by-user')

    await controller.respond({ ...reference, promptId: prompt.promptId, value: 'key-entered-by-user' })
    const completed = await waitForPhase(controller, reference, 'completed')
    expect(completed.result).toMatchObject({
      providerInstanceId: 'same-provider~account-a',
      runtimeProviderId: 'same-provider',
      type: 'api_key',
      credentialType: 'api_key',
    })
    expect(JSON.stringify(completed)).not.toContain('key-entered-by-user')
    await expect(controller.getResult(reference)).resolves.toMatchObject({ credentialType: 'api_key' })
  })

  it('runs OAuth prompts/events, validates select responses, and returns no tokens', async () => {
    const controller = new ProviderLoginFlowController({
      flowIdFactory: () => 'flow-oauth',
      providerInstances: { oauth: { runtimeProviderId: 'same-provider' } },
      runtimeFactory: async () => ({
        login: async (_providerId: string, type: AuthType, interaction: AuthInteraction): Promise<Credential> => {
          expect(type).toBe('oauth')
          interaction.notify({ type: 'auth_url', url: 'https://login.example.test/start', instructions: 'Open this URL' })
          interaction.notify({ type: 'device_code', userCode: 'ABCD-EFGH', verificationUri: 'https://login.example.test/device' })
          const choice = await interaction.prompt({
            type: 'select',
            message: 'Choose OAuth account',
            options: [
              { id: 'pro', label: 'Pro account', description: 'Use the subscription account' },
              { id: 'work', label: 'Work account' },
            ],
          })
          expect(choice).toBe('pro')
          return oauthCredential()
        },
      }),
    })
    const reference = { ownerId: 'user-1', flowId: 'flow-oauth' }

    await controller.start({ ...reference, providerInstanceId: 'oauth', type: 'oauth' })
    const prompt = await waitForPrompt(controller, reference)
    const events = await controller.getEvents({ ...reference, after: 0, limit: 10 })
    expect(events.events.map((event) => event.type)).toEqual(['auth_url', 'device_code', 'prompt'])
    expect(prompt.prompt).toMatchObject({ type: 'select', message: 'Choose OAuth account' })
    expect(prompt.prompt.type === 'select' ? prompt.prompt.options : []).toHaveLength(2)

    await expect(controller.respond({ ...reference, promptId: prompt.promptId, value: 'unknown' }))
      .rejects.toMatchObject({ code: 'INVALID_PROMPT_RESPONSE' })
    await controller.respond({ ...reference, promptId: prompt.promptId, value: 'pro' })
    const result = await controller.getResult({ ...reference })
    expect(result).toMatchObject({ type: 'oauth', credentialType: 'oauth' })
    expect(JSON.stringify(result)).not.toContain('refresh-token')
    expect(JSON.stringify(result)).not.toContain('access-token')
  })

  it('cancels a pending login for its owner and aborts provider work', async () => {
    let signal: AbortSignal | undefined
    const controller = new ProviderLoginFlowController({
      flowIdFactory: () => 'flow-cancel',
      runtimeFactory: async () => ({
        login: async (_providerId: string, _type: AuthType, interaction: AuthInteraction): Promise<Credential> => {
          signal = interaction.signal
          await interaction.prompt({ type: 'secret', message: 'Never completed' })
          return apiKey('unreachable')
        },
      }),
    })
    const reference = { ownerId: 'user-1', flowId: 'flow-cancel' }

    await controller.start({ ...reference, providerInstanceId: 'same-provider', type: 'api_key' })
    const prompt = await waitForPrompt(controller, reference)
    await expect(controller.getStatus({ ...reference, ownerId: 'other-user' })).rejects.toMatchObject({ code: 'FLOW_NOT_FOUND' })

    const cancelled = await controller.cancel(reference)
    expect(cancelled.phase).toBe('cancelled')
    expect(cancelled.currentPrompt).toBeUndefined()
    expect(signal?.aborted).toBe(true)
    await tick()
    await expect(controller.getStatus(reference)).resolves.toMatchObject({ phase: 'cancelled' })
    await expect(controller.respond({ ...reference, promptId: prompt.promptId, value: 'too-late' }))
      .rejects.toMatchObject({ code: 'FLOW_NOT_ACTIVE' })
  })

  it('expires a pending login using the injected clock and rejects late responses', async () => {
    let currentTime = 10_000
    let signal: AbortSignal | undefined
    const controller = new ProviderLoginFlowController({
      flowIdFactory: () => 'flow-expiry',
      ttlMs: 1_000,
      now: () => currentTime,
      runtimeFactory: async () => ({
        login: async (_providerId: string, _type: AuthType, interaction: AuthInteraction): Promise<Credential> => {
          signal = interaction.signal
          await interaction.prompt({ type: 'secret', message: 'Expires soon' })
          return apiKey('unreachable')
        },
      }),
    })
    const reference = { ownerId: 'user-1', flowId: 'flow-expiry' }

    await controller.start({ ...reference, providerInstanceId: 'same-provider', type: 'api_key' })
    const prompt = await waitForPrompt(controller, reference)
    currentTime = 11_000

    const expired = await controller.getStatus(reference)
    expect(expired.phase).toBe('expired')
    expect(expired.currentPrompt).toBeUndefined()
    expect(signal?.aborted).toBe(true)
    await expect(controller.respond({ ...reference, promptId: prompt.promptId, value: 'too-late' }))
      .rejects.toMatchObject({ code: 'FLOW_EXPIRED' })
  })
})
