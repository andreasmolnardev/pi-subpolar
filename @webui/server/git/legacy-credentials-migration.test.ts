import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { migrateLegacyGitCredentials } from './legacy-credentials-migration.ts'


function fixture(values: Array<{ id: string; user_id: string; preferences: Record<string, unknown>; updated_at?: number }>) {
  const rows = new Map(values.map((item) => [item.id, structuredClone(item)]))
  const creates: Array<{ owner: string; input: any }> = []
  const client = { collection(name: string) {
    if (name !== 'user_preferences') throw new Error('Unexpected collection')
    return {
      async getFullList() { return [...rows.values()].map((row) => structuredClone(row)) },
      async getOne(id: string) { const row = rows.get(id); if (!row) throw new Error('not found'); return structuredClone(row) },
      async update(id: string, data: any) { const row = rows.get(id)!; Object.assign(row, structuredClone(data)); return row },
    }
  } }
  const accountStore = {
    async listAccounts(owner: string) { return creates.filter((item) => item.owner === owner).map((item, index) => ({
      instanceId: `id-${owner}-${index}`, providerType: item.input.providerType, metadata: item.input.metadata, hasCredential: true,
    })) as any },
    async createAccount(owner: string, input: any) { creates.push({ owner, input }); return { instanceId: `id-${owner}-${creates.length}`, createdAt: 1 } as any },
  }
  return { client: client as any, rows, creates, accountStore }
}

describe('eager legacy Git credential migration', () => {
  it('migrates GitHub PATs, removes obsolete Gitee entries, and is idempotent', async () => {
    const f = fixture([
      { id: 'prefs-a', user_id: 'owner-a', updated_at: 20, preferences: { theme: 'dark', gitCredentials: [
        { type: 'pat', host: 'github.com', name: 'Personal', username: 'alice', token: 'github-secret' },
        { type: 'pat', host: 'https://gitee.com/', name: 'Work', token: 'gitee-secret' },
        { type: 'ssh', host: 'github.com', name: 'SSH', sshPrivateKey: 'private-key-secret' },
        { type: 'pat', host: 'git.example.test', name: 'Unknown host', token: 'unknown-secret' },
      ] } },
      { id: 'prefs-b', user_id: 'owner-b', updated_at: 10, preferences: { gitCredentials: [{ type: 'pat', host: 'gitee.com', name: 'B', token: 'owner-b-secret' }] } },
      { id: 'prefs-c', user_id: 'owner-c', preferences: { theme: 'light' } },
    ])

    const result = await migrateLegacyGitCredentials(f.client, f.accountStore as any, { now: () => 500, encryptionKeyAvailable: () => true })
    expect(result).toEqual({ ownersProcessed: 2, credentialsMigrated: 1, credentialsRemoved: 4 })
    expect(f.creates.map(({ owner, input }) => [owner, input.providerType, input.credential.key])).toEqual([
      ['owner-a', 'git:github', 'github-secret'],
    ])
    for (const row of f.rows.values()) {
      expect(row.preferences).not.toHaveProperty('gitCredentials')
      expect(JSON.stringify(row.preferences)).not.toMatch(/github-secret|gitee-secret|private-key-secret|unknown-secret|owner-b-secret/)
    }
    expect(f.rows.get('prefs-a')!.preferences.gitCredentialMigration).toMatchObject({ version: 1, migrated: 1, removedUnsupported: 3, completedAt: 500 })
    expect(await migrateLegacyGitCredentials(f.client, f.accountStore as any)).toEqual({ ownersProcessed: 0, credentialsMigrated: 0, credentialsRemoved: 0 })
    expect(f.creates).toHaveLength(1)
  })

  it('awaits migration readiness before Bun starts serving bridge routes', async () => {
    const bridge = readFileSync(join(import.meta.dir, '..', '..', 'bridge.ts'), 'utf8')
    expect(bridge.indexOf('await bridgeRuntime.startupReady')).toBeGreaterThanOrEqual(0)
    expect(bridge.indexOf('await bridgeRuntime.startupReady')).toBeLessThan(bridge.indexOf('Bun.serve'))
  })

  it('retains supported PAT sources when encryption is unavailable', async () => {
    delete process.env.SUBPOLAR_PROVIDER_SECRET_KEY
    const f = fixture([{ id: 'prefs-a', user_id: 'owner-a', preferences: { gitCredentials: [
      { type: 'pat', host: 'github.com', name: 'Personal', token: 'must-not-remain' },
    ] } }])
    await expect(migrateLegacyGitCredentials(f.client, f.accountStore as any, { encryptionKeyAvailable: () => false, now: () => 700 }))
      .rejects.toThrow('Legacy Git credential migration could not be completed')
    expect(f.creates).toHaveLength(0)
    expect(f.rows.get('prefs-a')!.preferences.gitCredentials).toEqual([
      { type: 'pat', host: 'github.com', name: 'Personal', token: 'must-not-remain' },
    ])
    expect(f.rows.get('prefs-a')!.preferences).not.toHaveProperty('gitCredentialMigration')
  })

  it('retains supported PATs after transient vault failure and retries exactly once', async () => {
    const f = fixture([{ id: 'prefs-a', user_id: 'owner-a', preferences: { gitCredentials: [
      { type: 'pat', host: 'github.com', name: 'Personal', token: 'write-failure-secret' },
    ] } }])
    const create = f.accountStore.createAccount
    f.accountStore.createAccount = async () => { throw new Error('secret must never be logged') }
    await expect(migrateLegacyGitCredentials(f.client, f.accountStore as any, { encryptionKeyAvailable: () => true }))
      .rejects.toThrow('Legacy Git credential migration could not be completed')
    expect(f.rows.get('prefs-a')!.preferences.gitCredentials).toHaveLength(1)

    f.accountStore.createAccount = create
    const result = await migrateLegacyGitCredentials(f.client, f.accountStore as any, { encryptionKeyAvailable: () => true })
    expect(result).toEqual({ ownersProcessed: 1, credentialsMigrated: 1, credentialsRemoved: 0 })
    expect(f.creates).toHaveLength(1)
    expect(f.rows.get('prefs-a')!.preferences).not.toHaveProperty('gitCredentials')
    expect(await migrateLegacyGitCredentials(f.client, f.accountStore as any, { encryptionKeyAvailable: () => true }))
      .toEqual({ ownersProcessed: 0, credentialsMigrated: 0, credentialsRemoved: 0 })
    expect(f.creates).toHaveLength(1)
  })
})
