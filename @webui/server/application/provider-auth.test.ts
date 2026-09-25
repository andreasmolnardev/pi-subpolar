import type PocketBase from 'pocketbase'
import { describe, expect, it } from 'vitest'
import type {
  Api,
  AuthInteraction,
  AuthType,
  Credential,
  Model,
  Provider as PiProvider,
} from '@earendil-works/pi-ai'
import { ProviderAccountService } from '../persistence/provider-accounts'
import {
  composeModelSelection,
  composeProviderInstanceId,
  createProviderCatalog,
  parseModelSelection,
  parseProviderInstanceId,
  type ProviderCatalogRuntime,
} from './provider-catalog'
import {
  ProviderLoginFlowController,
  type ProviderLoginFlowReference,
  type ProviderRuntimeFactoryContext,
} from './provider-login-flow'

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
