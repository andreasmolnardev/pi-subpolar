import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiDurableAgentEngine } from '../src/index.ts'
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import type { ProviderAccount } from '../../../@subpolar-agent/server/persistence/provider-accounts.ts'
import {
  composeProviderRuntimeId,
  createProviderRuntime,
  ProviderRuntimeCredentialStore,
  type ProviderRuntimeAccountService,
} from '../../../@subpolar-agent/server/application/runtime/provider-runtime.ts'

const temporaryDirectories: string[] = []

const account: ProviderAccount = {
  instanceId: 'durable-compatibility-account',
  providerType: 'openai',
  displayName: 'Durable compatibility fixture',
  authType: 'api_key',
  status: 'active',
  metadata: {},
  hasCredential: false,
  createdAt: 1,
  updatedAt: 1,
}

const accountService: ProviderRuntimeAccountService = {
  async listAccounts(userId) { return userId === 'owner-a' ? [account] : [] },
  async getAccount(userId, instanceId) {
    return userId === 'owner-a' && instanceId === account.instanceId ? account : null
  },
  async loadCredential() { return null },
  async updateAccount() { return null },
  async deleteAccount() { return false },
}

async function databasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'subpolar-durable-provider-compat-'))
  temporaryDirectories.push(directory)
  return join(directory, 'durable.sqlite')
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('Subpolar provider runtime with Pi Durable', () => {
  it('runs deterministic inference through an owner-scoped ProviderRuntime and the Durable boundary', async () => {
    const runtime = await createProviderRuntime({ userId: 'owner-a', accountService, accounts: [account] })
    const accountProviderId = composeProviderRuntimeId(account.providerType, account.instanceId)
    const faux = fauxProvider({ provider: 'openai' })
    faux.setResponses([fauxAssistantMessage('provider runtime inference passed')])
    const provider = runtime.getProvider(accountProviderId)
    expect(provider?.id).toBe(accountProviderId)
    expect(runtime.getProviders().some((entry) => entry.id === 'openai')).toBe(false)
    expect(runtime.getProvider('openai')).toBeUndefined()
    if (!provider) throw new Error('Owner-scoped provider is missing')

    // Keep the real owner-scoped ModelRuntime, credential store and Durable
    // inference path; only replace network transport/catalog with Pi's faux API.
    const fauxModel = faux.getModel()
    provider.getModels = () => [{ ...fauxModel, provider: accountProviderId }]
    Object.defineProperty(provider, 'auth', { value: faux.provider.auth })
    provider.streamSimple = faux.provider.streamSimple.bind(faux.provider) as unknown as typeof provider.streamSimple
    await runtime.refresh({ allowNetwork: false })
    const model = runtime.getModels(accountProviderId)[0]
    if (!model) throw new Error('Faux model was not published by the owner-scoped runtime')

    const engine = await PiDurableAgentEngine.initialize({ databasePath: await databasePath(), models: runtime, tools: [] })
    await engine.configure('owner-a', 'session-a', { model: { provider: accountProviderId, modelId: model.id } })
    await engine.submit({
      ownerId: 'owner-a', sessionId: 'session-a', requestId: 'compat-inference', runId: 'compat-run', prompt: 'infer deterministically',
    }, {
      request: {
        runId: 'compat-run', requestId: 'compat-inference', prompt: 'infer deterministically',
        principal: { id: 'owner-a', kind: 'user' }, sessionId: 'session-a',
      },
      context: {
        requestId: 'compat-inference', runId: 'compat-run', principal: { id: 'owner-a', kind: 'user' },
        sessionId: 'session-a', model: `${accountProviderId}/${model.id}`,
      },
      tools: { async call() { throw new Error('No tools should be called') } },
      async emit() {},
    })
    await expect(engine.wait('owner-a', 'session-a', 'compat-inference')).resolves.toMatchObject({
      status: 'done', output: 'provider runtime inference passed',
    })
    expect(faux.state.callCount).toBe(1)
    await engine.close()
  })

  it('keeps matching provider account IDs scoped to each owner credential store', async () => {
    const ownerService: ProviderRuntimeAccountService = {
      ...accountService,
      async listAccounts(userId) { return [{ ...account, hasCredential: true, displayName: userId }] },
      async getAccount(userId, instanceId) {
        return instanceId === account.instanceId ? { ...account, hasCredential: true, displayName: userId } : null
      },
      async loadCredential(userId, instanceId) {
        return instanceId === account.instanceId ? { type: 'api_key', key: `${userId}-credential` } : null
      },
    }
    const providerId = composeProviderRuntimeId(account.providerType, account.instanceId)
    const ownerA = new ProviderRuntimeCredentialStore({ userId: 'owner-a', accountService: ownerService, accounts: [account] })
    const ownerB = new ProviderRuntimeCredentialStore({ userId: 'owner-b', accountService: ownerService, accounts: [account] })

    await expect(ownerA.read(providerId)).resolves.toMatchObject({ key: 'owner-a-credential' })
    await expect(ownerB.read(providerId)).resolves.toMatchObject({ key: 'owner-b-credential' })
  })
})
