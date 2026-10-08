import { describe, expect, test } from 'bun:test'
import {
  assertGatewayAccess,
  authenticateGatewayCredential,
  createGatewayCredential,
  hashGatewaySecret,
  listGatewayCredentials,
  revokeGatewayCredential,
  rotateGatewayCredential,
} from '../persistence/gateway-credentials.ts'

type RecordValue = Record<string, unknown> & { id: string }
function fakeClient() {
  const records: RecordValue[] = []
  let next = 1
  const collection = {
    create: async (value: Record<string, unknown>) => { const record = { ...value, id: `credential-${next++}` } as RecordValue; records.push(record); return record },
    getOne: async (id: string) => { const record = records.find((item) => item.id === id); if (!record) throw new Error('missing'); return record },
    getFirstListItem: async (filter: string) => {
      const match = /prefix = "([^"]+)"/.exec(filter) ?? /owner_id = "([^"]+)"/.exec(filter)
      const record = records.find((item) => String(item[filter.includes('prefix') ? 'prefix' : 'owner_id']) === match?.[1])
      if (!record) throw new Error('missing')
      return record
    },
    getFullList: async () => records,
    update: async (id: string, value: Record<string, unknown>) => { const record = records.find((item) => item.id === id)!; Object.assign(record, value); return record },
  }
  return { collection: () => collection, records } as never
}

describe('gateway credentials', () => {
  test('creates, lists, authenticates, rotates, and revokes without storing plaintext', async () => {
    const client = fakeClient()
    const created = await createGatewayCredential(client, { ownerId: 'user-1', principal: 'builder', permissions: ['call', 'events'], scope: { projectIds: ['project-1'], agentNames: ['master'], sessionIds: ['session-1'] } })
    expect(created.secret).toMatch(/^subpolar_gw_/)
    expect((client as unknown as { records: RecordValue[] }).records[0].secret_hash).toBe(hashGatewaySecret(created.secret))
    expect((client as unknown as { records: RecordValue[] }).records[0].secret_hash).not.toBe(created.secret)
    expect(await listGatewayCredentials(client, 'user-1')).toHaveLength(1)
    await expect(authenticateGatewayCredential(client, created.secret)).resolves.toMatchObject({ ownerId: 'user-1', principal: 'builder' })
    const rotated = await rotateGatewayCredential(client, 'user-1', (await listGatewayCredentials(client, 'user-1'))[0].id)
    expect(rotated?.secret).not.toBe(created.secret)
    await expect(authenticateGatewayCredential(client, created.secret)).rejects.toMatchObject({ code: 'GATEWAY_TOKEN_REVOKED' })
    await revokeGatewayCredential(client, 'user-1', rotated!.credential.id)
    await expect(authenticateGatewayCredential(client, rotated!.secret)).rejects.toMatchObject({ code: 'GATEWAY_TOKEN_REVOKED' })
  })

  test('denies permission and scope independently', async () => {
    const client = fakeClient()
    const created = await createGatewayCredential(client, { ownerId: 'user-1', principal: 'reader', permissions: ['list'], scope: { projectIds: ['project-1'] } })
    const auth = await authenticateGatewayCredential(client, created.secret)
    expect(() => assertGatewayAccess(auth, 'call', { projectId: 'project-1' })).toThrowError('Gateway credential lacks call permission')
    expect(() => assertGatewayAccess(auth, 'list', { projectId: 'project-2' })).toThrowError('Gateway credential is outside the requested scope')
  })

  test('allows registration only with the add permission', async () => {
    const client = fakeClient()
    const created = await createGatewayCredential(client, { ownerId: 'user-1', principal: 'registrar', permissions: ['add'], scope: { agentNames: ['master'] } })
    const auth = await authenticateGatewayCredential(client, created.secret)
    expect(() => assertGatewayAccess(auth, 'add', { agentName: 'master' })).not.toThrow()
    expect(() => assertGatewayAccess(auth, 'add', { agentName: 'other' })).toThrowError('Gateway credential is outside the requested scope')
  })

  test('rejects expiry and never exposes a secret in public records', async () => {
    const client = fakeClient()
    const created = await createGatewayCredential(client, { ownerId: 'user-1', principal: 'expired', permissions: ['list'], expiresAt: Date.now() + 5 })
    await new Promise((resolve) => setTimeout(resolve, 10))
    await expect(authenticateGatewayCredential(client, created.secret)).rejects.toMatchObject({ code: 'GATEWAY_TOKEN_EXPIRED' })
    const listed = await listGatewayCredentials(client, 'user-1')
    expect(JSON.stringify(listed)).not.toContain(created.secret)
  })
})
