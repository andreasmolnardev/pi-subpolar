import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiDurableAgentEngine, type PiDurableModels } from '../src/index.ts'
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
  it('opens the Durable Harness with an owner-scoped provider runtime without loading credentials', async () => {
    const runtime = await createProviderRuntime({
      userId: 'owner-a',
      accountService,
      accounts: [account],
    })
    const accountProviderId = composeProviderRuntimeId(account.providerType, account.instanceId)
    expect(runtime.getProvider(accountProviderId)?.id).toBe(accountProviderId)
    expect(runtime.getModels(accountProviderId).length).toBeGreaterThan(0)
    expect(runtime.getProviders().some((provider) => provider.id === 'openai')).toBe(false)
    expect(runtime.getProvider('openai')).toBeUndefined()

    const engine = await PiDurableAgentEngine.initialize({
      databasePath: await databasePath(),
      // Workspaces resolve separate Pi AI module instances with nominally branded types.
      // This cast is limited to this runtime boundary test; the Harness is exercised below.
      models: runtime as unknown as PiDurableModels,
      tools: [],
    })
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
