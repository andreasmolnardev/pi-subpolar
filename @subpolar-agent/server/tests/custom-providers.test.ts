import type PocketBase from 'pocketbase'
import { afterEach, describe, expect, it } from 'vitest'
import { createCustomProviderService, customProviderDiscoveryUrl, validateCustomProviderBaseUrl } from '../persistence/custom-providers.ts'

type RecordValue = Record<string, unknown> & { id: string }

class FakeCollection {
  readonly records: RecordValue[] = []
  private nextId = 1

  async getFirstListItem(filter: string): Promise<RecordValue> {
    const userId = /user_id = "([^\"]*)"/.exec(filter)?.[1]
    const providerId = /provider_id = "([^\"]*)"/.exec(filter)?.[1]
    const record = this.records.find((item) => item.user_id === userId && (providerId === undefined || item.provider_id === providerId))
    if (!record) throw Object.assign(new Error('not found'), { status: 404 })
    return { ...record }
  }

  async getFullList(options?: { filter?: string }): Promise<RecordValue[]> {
    const userId = /user_id = "([^\"]*)"/.exec(options?.filter ?? '')?.[1]
    return this.records.filter((record) => userId === undefined || record.user_id === userId).map((record) => ({ ...record }))
  }

  async create(data: Record<string, unknown>): Promise<RecordValue> {
    const record = { ...data, id: `custom-${this.nextId++}` }
    this.records.push(record)
    return { ...record }
  }

  async update(id: string, data: Record<string, unknown>): Promise<RecordValue> {
    const record = this.records.find((item) => item.id === id)
    if (!record) throw Object.assign(new Error('not found'), { status: 404 })
    Object.assign(record, data)
    return { ...record }
  }

  async delete(id: string): Promise<boolean> {
    const index = this.records.findIndex((item) => item.id === id)
    if (index >= 0) this.records.splice(index, 1)
    return index >= 0
  }
}

class FakePocketBase {
  readonly providers = new FakeCollection()

  collection(name: string): FakeCollection {
    if (name !== 'custom_providers') throw new Error(`Unexpected collection: ${name}`)
    return this.providers
  }
}

const secretKey = process.env.SUBPOLAR_PROVIDER_SECRET_KEY

afterEach(() => {
  if (secretKey === undefined) delete process.env.SUBPOLAR_PROVIDER_SECRET_KEY
  else process.env.SUBPOLAR_PROVIDER_SECRET_KEY = secretKey
})

describe('custom provider ownership', () => {
  it('rejects embedded credentials and sensitive query parameters', () => {
    expect(() => validateCustomProviderBaseUrl('https://user:password@models.example.test')).toThrow()
    expect(() => validateCustomProviderBaseUrl('https://models.example.test/?api_key=secret')).toThrow()
    expect(() => validateCustomProviderBaseUrl('https://models.example.test/?client_secret=secret')).toThrow()
    expect(() => validateCustomProviderBaseUrl('https://models.example.test/?x-auth-token=secret')).toThrow()
    expect(validateCustomProviderBaseUrl('https://models.example.test/?region=local')).toBe('https://models.example.test/?region=local')
  })

  it('appends discovery paths without moving or dropping the query', () => {
    expect(customProviderDiscoveryUrl('https://models.example.test/api?region=local&mode=test'))
      .toBe('https://models.example.test/api/v1/models?region=local&mode=test')
  })

  it('scopes records by user and never returns encrypted credentials', async () => {
    process.env.SUBPOLAR_PROVIDER_SECRET_KEY = '0123456789abcdef0123456789abcdef'
    const client = new FakePocketBase()
    const service = createCustomProviderService(client as unknown as PocketBase)
    const input = {
      id: 'local',
      name: 'Local model',
      baseUrl: 'https://models.example.test',
      api: 'openai-completions',
      apiKey: 'secret-key',
      headers: { Authorization: 'Bearer secret-header', 'X-Trace': 'safe' },
      authHeader: true,
      models: [{ id: 'model-1' }],
    }

    const first = await service.save('user-1', input)
    expect(first.provider).not.toHaveProperty('apiKey')
    expect(first.provider.headers).toEqual({ 'X-Trace': 'safe' })
    expect(JSON.stringify(first.provider)).not.toContain('secret')
    expect(await service.list('user-2')).toEqual([])

    await service.save('user-2', { ...input, name: 'Other local' })
    expect((await service.list('user-1'))[0]?.name).toBe('Local model')
    expect((await service.list('user-2'))[0]?.name).toBe('Other local')
    expect(client.providers.records[0]?.credential_payload).not.toContain('secret-key')
  })
})
