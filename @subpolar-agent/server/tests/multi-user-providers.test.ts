import type PocketBase from 'pocketbase'
import { afterEach, describe, expect, it } from 'vitest'
import { ProviderAccountService, PROVIDER_ACCOUNTS_COLLECTION, PROVIDER_ACCOUNT_CREDENTIALS_COLLECTION, ensureProviderAccountCollections } from '../persistence/provider-accounts.ts'
import { CustomProviderService } from '../persistence/custom-providers.ts'
import { PocketBaseProviderLoginFlowStorage, PROVIDER_LOGIN_FLOWS_COLLECTION, ensureProviderLoginFlowCollection } from '../persistence/provider-login-flow-store.ts'
import type { StoredProviderLoginFlow } from '../application/runtime/provider-login-flow.ts'

type Row = Record<string, unknown> & { id: string }
const missing = () => Object.assign(new Error('not found'), { status: 404 })

class CollectionAdmin {
  readonly records: Row[]
  constructor(records: Row[]) { this.records = records }
  async getOne(name: string): Promise<Row> {
    const record = this.records.find((item) => item.name === name)
    if (!record) throw missing()
    return { ...record }
  }
  async create(data: Record<string, unknown>): Promise<Row> {
    const record = { ...data, id: `collection-${this.records.length + 1}` } as Row
    this.records.push(record)
    return { ...record }
  }
  async update(id: string, data: Record<string, unknown>): Promise<Row> {
    const record = this.records.find((item) => item.id === id)
    if (!record) throw missing()
    Object.assign(record, data)
    return { ...record }
  }
}

function collectionAdminClient(records: Row[]): PocketBase {
  return { collections: new CollectionAdmin(records) } as unknown as PocketBase
}

class Store {
  rows: Row[] = []
  unfiltered = false
  writes: string[] = []
  response: Row | undefined
  failCreate = false
  async getFirstListItem(filter: string): Promise<Row> {
    const predicates = [...filter.matchAll(/(\w+) = "([^\"]*)"/g)]
    const row = this.rows.find((item) => this.unfiltered || predicates.every(([, key, value]) => item[key!] === value))
    if (!row) throw missing()
    return { ...row }
  }
  async getFullList(options?: { filter?: string }): Promise<Row[]> {
    const owner = /user_id = "([^\"]*)"/.exec(options?.filter ?? '')?.[1]
    return this.rows.filter((row) => this.unfiltered || row.user_id === owner).map((row) => ({ ...row }))
  }
  async create(data: Record<string, unknown>): Promise<Row> {
    if (this.failCreate) { this.unfiltered = true; throw new Error('creation failed') }
    const row = { ...data, id: `row-${this.rows.length + 1}` }
    this.rows.push(row)
    this.writes.push(`create:${row.id}`)
    return this.response ?? { ...row }
  }
  async update(id: string, data: Record<string, unknown>): Promise<Row> {
    const row = this.rows.find((item) => item.id === id)
    if (!row) throw missing()
    Object.assign(row, data)
    this.writes.push(`update:${id}`)
    return this.response ?? { ...row }
  }
  async delete(id: string): Promise<boolean> {
    this.writes.push(`delete:${id}`)
    this.rows = this.rows.filter((row) => row.id !== id)
    return true
  }
}

function fixture() {
  const stores = new Map<string, Store>()
  const store = (name: string) => {
    if (!stores.has(name)) stores.set(name, new Store())
    return stores.get(name)!
  }
  const client = { collection: store } as unknown as PocketBase
  return {
    client, store,
    accounts: store(PROVIDER_ACCOUNTS_COLLECTION),
    credentials: store(PROVIDER_ACCOUNT_CREDENTIALS_COLLECTION),
    service: new ProviderAccountService(client, { encryptionKey: '0123456789abcdef0123456789abcdef', instanceId: () => 'shared', now: () => 100 }),
  }
}
const oauth = (owner: string) => ({ type: 'oauth' as const, access: `${owner}-access`, refresh: `${owner}-refresh`, expires: 900, clientId: `${owner}-client`, scopes: ['openid'] })
const accountInput = (owner: string) => ({ providerType: 'openai', displayName: owner, authType: 'oauth' as const, credential: oauth(owner), metadata: { label: owner } })
const customInput = (owner: string) => ({ id: 'local', name: owner, baseUrl: 'https://models.example.test', apiKey: `${owner}-secret`, headers: { Authorization: `${owner}-header`, 'X-Trace': owner }, models: [{ id: owner, access_token: 'hidden' }] })
const flow = (ownerId: string, flowId = 'shared-flow'): StoredProviderLoginFlow => ({ ownerId, flowId, providerInstanceId: 'shared', runtimeProviderId: 'openai', type: 'oauth', phase: 'pending', createdAt: 1, updatedAt: 1, expiresAt: 10, nextSequence: 0, events: [] })
const originalKey = process.env.SUBPOLAR_PROVIDER_SECRET_KEY

afterEach(() => {
  if (originalKey === undefined) delete process.env.SUBPOLAR_PROVIDER_SECRET_KEY
  else process.env.SUBPOLAR_PROVIDER_SECRET_KEY = originalKey
})

describe('provider persistence returned-record multi-user fences', () => {
  it('hardens every rule on pre-existing provider account collections', async () => {
    const permissive = {
      listRule: '', viewRule: '', createRule: '', updateRule: '', deleteRule: '',
    }
    const records: Row[] = [
      { id: 'accounts', name: PROVIDER_ACCOUNTS_COLLECTION, fields: [], indexes: [], ...permissive },
      { id: 'credentials', name: PROVIDER_ACCOUNT_CREDENTIALS_COLLECTION, fields: [], indexes: [], ...permissive },
    ]

    await ensureProviderAccountCollections(collectionAdminClient(records))

    expect(records[0]).toMatchObject({
      listRule: '@request.auth.id = user_id',
      viewRule: '@request.auth.id = user_id',
      createRule: '@request.auth.id = user_id',
      updateRule: '@request.auth.id = user_id',
      deleteRule: '@request.auth.id = user_id',
    })
    expect(records[1]).toMatchObject({ listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null })
  })

  it('hardens every rule on a pre-existing provider login flow collection', async () => {
    const records: Row[] = [{
      id: 'flows', name: PROVIDER_LOGIN_FLOWS_COLLECTION, fields: [], indexes: [],
      listRule: '', viewRule: '', createRule: '', updateRule: '', deleteRule: '',
    }]

    await ensureProviderLoginFlowCollection(collectionAdminClient(records))

    expect(records[0]).toMatchObject({
      listRule: '@request.auth.id = user_id',
      viewRule: '@request.auth.id = user_id',
      createRule: '@request.auth.id = @request.body.user_id',
      updateRule: '@request.auth.id = user_id',
      deleteRule: '@request.auth.id = user_id',
    })
  })

  it('does not project or mutate foreign-first accounts with the same instance/provider IDs', async () => {
    const f = fixture()
    await f.service.createAccount('b', accountInput('b'))
    await f.service.createAccount('a', accountInput('a'))
    f.accounts.unfiltered = true
    f.credentials.unfiltered = true
    const before = JSON.stringify([f.accounts.rows, f.credentials.rows])
    expect(await f.service.listAccounts('a')).toMatchObject([{ displayName: 'a', metadata: { label: 'a' } }])
    expect(await f.service.getAccount('a', 'shared')).toBeNull()
    expect(await f.service.getAccountStatus('a', 'shared')).toBeNull()
    expect(await f.service.loadCredential('a', 'shared')).toBeNull()
    expect(await f.service.updateAccount('a', 'shared', { credential: oauth('rotated'), metadata: { label: 'changed' } })).toBeNull()
    expect(await f.service.deleteAccount('a', 'shared')).toBe(false)
    expect(JSON.stringify([f.accounts.rows, f.credentials.rows])).toBe(before)
    // Same owner, wrong selector is also not an authorized record.
    expect(await f.service.getAccount('b', 'other-instance')).toBeNull()
    expect(await f.service.updateAccount('b', 'other-instance', { displayName: 'wrong' })).toBeNull()
    expect(await f.service.deleteAccount('b', 'other-instance')).toBe(false)
  })

  it.each(['owner', 'instance', 'provider'])('checks credential %s before decrypt, refresh, or deletion', async (selector) => {
    const f = fixture()
    await f.service.createAccount('b', accountInput('b'))
    await f.service.createAccount('a', accountInput('a'))
    const bad = f.credentials.rows[0]!
    if (selector !== 'owner') bad.user_id = 'a'
    if (selector === 'instance') bad.instance_id = 'wrong-instance'
    if (selector === 'provider') bad.provider_type = 'anthropic'
    bad.payload = 'not even an encrypted envelope'
    f.credentials.unfiltered = true
    const before = JSON.stringify([f.accounts.rows, f.credentials.rows])
    expect(await f.service.loadCredential('a', 'shared')).toBeNull()
    await expect(f.service.updateAccount('a', 'shared', { credential: oauth('rotated'), metadata: { label: 'changed' } })).rejects.toThrow('credential record')
    await expect(f.service.deleteAccount('a', 'shared')).rejects.toThrow('credential record')
    expect(JSON.stringify([f.accounts.rows, f.credentials.rows])).toBe(before)
  })

  it('refreshes OAuth credentials and metadata, then deletes only the requested owner', async () => {
    const f = fixture()
    await f.service.createAccount('b', accountInput('b'))
    await f.service.createAccount('a', accountInput('a'))
    const foreign = JSON.stringify([f.accounts.rows[0], f.credentials.rows[0]])
    await f.service.updateAccount('a', 'shared', { credential: oauth('rotated'), metadata: { label: 'updated' } })
    expect(await f.service.loadCredential('a', 'shared')).toEqual(oauth('rotated'))
    expect(await f.service.loadCredential('b', 'shared')).toEqual(oauth('b'))
    expect(await f.service.getAccount('a', 'shared')).toMatchObject({ metadata: { label: 'updated' }, lastUsedAt: 100 })
    expect(JSON.stringify(await f.service.listAccounts('a'))).not.toContain('rotated-access')
    expect(JSON.stringify([f.accounts.rows[0], f.credentials.rows[0]])).not.toContain('rotated')
    // Remove the last-used write caused by the explicit owner-b read for comparison.
    f.accounts.rows[0]!.last_used_at = null
    expect(JSON.stringify([f.accounts.rows[0], f.credentials.rows[0]])).toBe(foreign)
    expect(await f.service.deleteAccount('a', 'shared')).toBe(true)
    expect(f.accounts.rows.map((row) => row.user_id)).toEqual(['b'])
    expect(f.credentials.rows.map((row) => row.user_id)).toEqual(['b'])
  })

  it('allows matching owner-first refresh and deletion with filters entirely ignored', async () => {
    const f = fixture()
    await f.service.createAccount('a', accountInput('a'))
    await f.service.createAccount('b', accountInput('b'))
    const foreign = JSON.stringify([f.accounts.rows[1], f.credentials.rows[1]])
    f.accounts.unfiltered = true
    f.credentials.unfiltered = true
    expect(await f.service.listAccounts('a')).toHaveLength(1)
    await f.service.updateAccount('a', 'shared', { credential: oauth('rotated'), metadata: { label: 'updated' } })
    expect(await f.service.loadCredential('a', 'shared')).toEqual(oauth('rotated'))
    expect(await f.service.getAccount('a', 'shared')).toMatchObject({ metadata: { label: 'updated' }, lastUsedAt: 100 })
    expect(JSON.stringify([f.accounts.rows[1], f.credentials.rows[1]])).toBe(foreign)
    await f.service.deleteAccount('a', 'shared')
    expect(JSON.stringify([f.accounts.rows[0], f.credentials.rows[0]])).toBe(foreign)
    expect(await f.service.loadCredential('b', 'shared')).toEqual(oauth('b'))
  })

  it.each(['owner', 'instance', 'provider', 'authType'])('retains legacy credential AAD binding to %s', async (selector) => {
    const f = fixture()
    await f.service.createAccount('a', accountInput('a'))
    delete f.credentials.rows[0]!.provider_type
    expect(await f.service.loadCredential('a', 'shared')).toEqual(oauth('a'))
    let owner = 'a'
    let instance = 'shared'
    if (selector === 'owner') {
      owner = 'b'
      f.accounts.rows[0]!.user_id = owner
      f.credentials.rows[0]!.user_id = owner
    }
    if (selector === 'instance') {
      instance = 'other'
      f.accounts.rows[0]!.instance_id = instance
      f.credentials.rows[0]!.instance_id = instance
    }
    if (selector === 'provider') f.accounts.rows[0]!.provider_type = 'anthropic'
    if (selector === 'authType') f.accounts.rows[0]!.auth_type = 'api_key'
    const writes = f.accounts.writes.length
    await expect(f.service.loadCredential(owner, instance)).rejects.toThrow()
    expect(f.accounts.writes).toHaveLength(writes)
  })

  it('rejects foreign account write responses before projecting metadata or performing cleanup', async () => {
    const f = fixture()
    await f.service.createAccount('b', accountInput('b'))
    f.accounts.response = f.accounts.rows[0]
    await expect(f.service.createAccount('a', accountInput('a'))).rejects.toThrow('account record')
    expect(f.credentials.rows.map((row) => row.user_id)).toEqual(['b'])
    f.accounts.response = undefined
    await f.service.createAccount('a', accountInput('a'))
    f.accounts.response = f.accounts.rows[0]
    const before = JSON.stringify(f.credentials.rows)
    await expect(f.service.updateAccount('a', 'shared', { credential: oauth('rotated') })).rejects.toThrow('account record')
    expect(JSON.stringify(f.credentials.rows)).toBe(before)
  })

  it('fences custom CRUD/discovery metadata before decrypting or retaining foreign secrets', async () => {
    process.env.SUBPOLAR_PROVIDER_SECRET_KEY = '0123456789abcdef0123456789abcdef'
    const f = fixture()
    const service = new CustomProviderService(f.client)
    const store = f.store('custom_providers')
    await service.save('b', customInput('b'))
    await service.save('a', customInput('a'))
    store.unfiltered = true
    const before = JSON.stringify(store.rows)
    const own = await service.list('a')
    expect(own).toMatchObject([{ id: 'local', name: 'a', headers: { 'X-Trace': 'a' }, models: [{ id: 'a' }] }])
    expect(JSON.stringify(own)).not.toMatch(/credential_payload|Authorization|access_token|a-secret|b-header/)
    await expect(service.save('a', { ...customInput('a'), apiKey: undefined })).rejects.toThrow('provider record')
    await expect(service.save('a', customInput('replacement'))).rejects.toThrow('provider record')
    await service.delete('a', 'local')
    await service.delete('b', 'wrong-provider')
    await expect(service.save('b', { ...customInput('b'), id: 'wrong-provider' })).rejects.toThrow('provider record')
    expect(JSON.stringify(store.rows)).toBe(before)
    store.unfiltered = false
    await service.save('a', { ...customInput('updated'), apiKey: undefined, headers: { 'X-Trace': 'updated' } })
    expect(store.rows[1]!.credential_payload).toBe(JSON.parse(before)[1].credential_payload)
    await service.delete('a', 'local')
    expect(store.rows).toEqual([JSON.parse(before)[0]])
    store.response = store.rows[0]
    await expect(service.save('a', customInput('a'))).rejects.toThrow('provider record')
  })

  it('fences flow owner/ID before projection, expiration, overwrite and deletion', async () => {
    const f = fixture()
    const storage = new PocketBaseProviderLoginFlowStorage(f.client, { now: () => 1 })
    const store = f.store('provider_login_flows')
    await storage.set(flow('b', 'foreign-flow'))
    await storage.set(flow('a'))
    store.rows[0]!.events = [{ sequence: 1, timestamp: 1, type: 'info', message: 'foreign-token-metadata' }]
    store.unfiltered = true
    const before = JSON.stringify(store.rows)
    const expiredReader = new PocketBaseProviderLoginFlowStorage(f.client, { now: () => 20 })
    expect(await expiredReader.getOwned('a', 'shared-flow')).toBeUndefined()
    expect(await expiredReader.getOwned('a', 'foreign-flow')).toBeUndefined()
    expect(await expiredReader.get('shared-flow')).toBeUndefined()
    await storage.deleteOwned('a', 'foreign-flow')
    await storage.deleteOwned('b', 'shared-flow')
    await storage.delete('shared-flow')
    await expect(storage.set(flow('b'))).rejects.toThrow()
    await expect(storage.set(flow('a'))).rejects.toThrow()
    expect(JSON.stringify(store.rows)).toBe(before)
    store.unfiltered = false
    expect(await storage.getOwned('a', 'shared-flow')).toMatchObject({ ownerId: 'a', events: [] })
    await storage.deleteOwned('a', 'shared-flow')
    expect(store.rows).toEqual([JSON.parse(before)[0]])
  })

  it('rejects a foreign-first flow even when both owners have the same flow/account/provider IDs', async () => {
    const f = fixture()
    const storage = new PocketBaseProviderLoginFlowStorage(f.client, { now: () => 1 })
    const store = f.store('provider_login_flows')
    await storage.set(flow('b'))
    store.rows.push({ ...store.rows[0]!, id: 'own-flow', user_id: 'a' })
    store.unfiltered = true
    const before = JSON.stringify(store.rows)
    expect(await storage.getOwned('a', 'shared-flow')).toBeUndefined()
    await storage.deleteOwned('a', 'shared-flow')
    await expect(storage.set(flow('a'))).rejects.toThrow()
    expect(JSON.stringify(store.rows)).toBe(before)
  })

  it('projects only known flow fields for the authorized owner', async () => {
    const f = fixture()
    const storage = new PocketBaseProviderLoginFlowStorage(f.client, { now: () => 1 })
    await storage.set(flow('a'))
    Object.assign(f.store('provider_login_flows').rows[0]!, {
      access_token: 'row-secret', credential: oauth('a'),
      events: [{ sequence: 1, timestamp: 1, type: 'info', message: 'Continue', token: 'event-secret' }],
      error: { code: 'LOGIN_FAILED', message: 'provider-secret' },
    })
    const publicFlow = await storage.getOwned('a', 'shared-flow')
    expect(publicFlow).toMatchObject({ ownerId: 'a', events: [{ type: 'info', message: 'Continue' }] })
    expect(JSON.stringify(publicFlow)).not.toMatch(/row-secret|event-secret|provider-secret|a-access|a-refresh/)
    expect(publicFlow).not.toHaveProperty('error')
  })

  it('checks owner and flow ID again after a create race', async () => {
    const f = fixture()
    const storage = new PocketBaseProviderLoginFlowStorage(f.client, { now: () => 1 })
    const store = f.store('provider_login_flows')
    await storage.set(flow('a', 'different-flow'))
    const before = JSON.stringify(store.rows)
    store.failCreate = true
    await expect(storage.set(flow('a'))).rejects.toThrow()
    expect(JSON.stringify(store.rows)).toBe(before)
    expect(store.writes).toHaveLength(1)
  })

  it('rejects completed flow results for a different provider/account', async () => {
    const f = fixture()
    const storage = new PocketBaseProviderLoginFlowStorage(f.client, { now: () => 1 })
    await expect(storage.set({ ...flow('a'), phase: 'completed', result: { flowId: 'shared-flow', providerInstanceId: 'wrong', runtimeProviderId: 'openai', type: 'oauth', credentialType: 'oauth', completedAt: 1 } })).rejects.toThrow('result is invalid')
    expect(f.store('provider_login_flows').writes).toEqual([])
  })
})
