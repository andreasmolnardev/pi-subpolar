import type PocketBase from 'pocketbase'
import type { ProviderAccountService } from '../persistence/provider-accounts.ts'

type LegacyGitCredential = Record<string, unknown>
type MigrationStatus = Readonly<{
  version: 1
  completedAt: number
  migrated: number
  alreadyMigrated: number
  removedUnsupported: number
  removedInvalid: number
  removedKeyUnavailable: number
  removedMigrationFailure: number
}>
type AccountStore = Pick<ProviderAccountService, 'createAccount' | 'listAccounts'>
type MigrationOptions = { now?: () => number; encryptionKeyAvailable?: () => boolean }

const migrationFailure = () => new Error('Legacy Git credential migration could not be completed')

type Provider = 'github'
const providerForHost = (value: unknown): Provider | undefined => {
  if (typeof value !== 'string') return undefined
  const host = value.trim().toLowerCase()
  if (host === 'github.com' || host === 'https://github.com' || host === 'https://github.com/') return 'github'

  return undefined
}

function hasProviderEncryptionKey(): boolean {
  const value = process.env.SUBPOLAR_PROVIDER_SECRET_KEY?.trim() ?? ''
  const hex = value.startsWith('hex:') ? value.slice(4) : value
  if (/^[0-9a-f]{64}$/i.test(hex)) return true
  const base64 = value.startsWith('base64:') ? value.slice(7) : value
  if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(base64)) {
    const normalized = base64.replaceAll('-', '+').replaceAll('_', '/')
    if (Buffer.from(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='), 'base64').byteLength === 32) return true
  }
  return Buffer.byteLength(value, 'utf8') === 32
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function label(value: unknown, provider: Provider): string {
  if (typeof value !== 'string') return `${provider} account`
  const clean = value.trim().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 200)
  return clean || `${provider} account`
}

function username(value: unknown): string {
  if (typeof value !== 'string') return ''
  const clean = value.trim()
  return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(clean) ? clean : ''
}

function preferenceCollection(client: PocketBase) {
  return client.collection('user_preferences') as unknown as {
    getFullList: () => Promise<Array<Record<string, unknown>>>
    getOne: (id: string) => Promise<Record<string, unknown>>
    update: (id: string, data: Record<string, unknown>) => Promise<unknown>
  }
}

/**
 * Eagerly migrates the former preference-embedded Git secrets for every owner.
 * Only PATs with an exact GitHub.com host mapping are retained, and
 * those are written through ProviderAccountService's encrypted credential path.
 * Unsupported or invalid legacy entries are removed with count-only status recorded per owner.
 * Supported PAT sources remain untouched unless encrypted persistence succeeds.
 */
export async function migrateLegacyGitCredentials(
  client: PocketBase,
  accounts: AccountStore,
  options: MigrationOptions = {},
): Promise<{ ownersProcessed: number; credentialsMigrated: number; credentialsRemoved: number }> {
  const now = options.now ?? Date.now
  const keyAvailable = options.encryptionKeyAvailable ?? hasProviderEncryptionKey
  const preferences = preferenceCollection(client)
  const rows = await preferences.getFullList()
  let ownersProcessed = 0
  let credentialsMigrated = 0
  let credentialsRemoved = 0

  for (const listed of rows) {
    const ownerId = typeof listed.user_id === 'string' ? listed.user_id : ''
    const listedPreferences = record(listed.preferences)
    if (!ownerId || !listedPreferences || !Object.prototype.hasOwnProperty.call(listedPreferences, 'gitCredentials')) continue

    const entries = Array.isArray(listedPreferences.gitCredentials) ? listedPreferences.gitCredentials : []
    const status = {
      version: 1 as const,
      completedAt: now(),
      migrated: 0,
      alreadyMigrated: 0,
      removedUnsupported: 0,
      removedInvalid: 0,
      removedKeyUnavailable: 0,
      removedMigrationFailure: 0,
    }
    let existingAccounts: Awaited<ReturnType<AccountStore['listAccounts']>>
    try {
      existingAccounts = await accounts.listAccounts(ownerId)
    } catch {
      throw migrationFailure()
    }
    const hasSupportedPat = entries.some((value) => {
      const item = record(value)
      return item?.type === 'pat' && Boolean(providerForHost(item.host))
        && typeof item.token === 'string' && Boolean(item.token.trim())
        && item.token.length <= 4096 && !/[\r\n]/.test(item.token)
    })
    if (hasSupportedPat && !keyAvailable()) throw migrationFailure()

    for (const [index, value] of entries.entries()) {
      const item = record(value) as LegacyGitCredential | null
      const provider = providerForHost(item?.host)
      if (!item || item.type !== 'pat' || !provider) {
        status.removedUnsupported++
        continue
      }
      if (typeof item.token !== 'string' || !item.token.trim() || item.token.length > 4096 || /[\r\n]/.test(item.token)) {
        status.removedInvalid++
        continue
      }

      const migrationKey = `legacy-git-v1:${String(listed.updated_at ?? 'unknown')}:${index}`
      const alreadyStored = existingAccounts?.some((account) =>
        account.providerType === `git:${provider}` && account.metadata.legacyMigrationKey === migrationKey && account.hasCredential)
      if (alreadyStored) {
        status.alreadyMigrated++
        continue
      }
      try {
        const legacyUsername = username(item.username)
        const displayName = label(item.name, provider)
        await accounts.createAccount(ownerId, {
          providerType: `git:${provider}`,
          displayName,
          authType: 'api_key',
          credential: { type: 'api_key', key: item.token.trim() },
          metadata: { username: legacyUsername, legacyMigrationKey: migrationKey },
        })
        status.migrated++
      } catch {
        throw migrationFailure()
      }
    }

    let current: Record<string, unknown>
    try {
      current = await preferences.getOne(String(listed.id))
    } catch {
      throw migrationFailure()
    }
    if (current.user_id !== ownerId) continue
    const currentPreferences = record(current.preferences) ?? {}
    if (JSON.stringify(currentPreferences.gitCredentials) !== JSON.stringify(listedPreferences.gitCredentials)) throw migrationFailure()
    delete currentPreferences.gitCredentials
    currentPreferences.gitCredentialMigration = status satisfies MigrationStatus
    try {
      await preferences.update(String(current.id), { preferences: currentPreferences, updated_at: now() })
    } catch {
      throw migrationFailure()
    }
    ownersProcessed++
    credentialsMigrated += status.migrated
    credentialsRemoved += status.removedUnsupported + status.removedInvalid + status.removedKeyUnavailable + status.removedMigrationFailure
  }

  return { ownersProcessed, credentialsMigrated, credentialsRemoved }
}
