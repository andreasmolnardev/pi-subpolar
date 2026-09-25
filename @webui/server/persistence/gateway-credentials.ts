import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type PocketBase from 'pocketbase'

export const GATEWAY_PERMISSIONS = ['list', 'query', 'describe', 'add', 'call', 'approvals', 'events'] as const
export type GatewayPermission = typeof GATEWAY_PERMISSIONS[number]

export type GatewayScope = {
  projectIds?: string[]
  agentNames?: string[]
  sessionIds?: string[]
}

export type GatewayCredential = {
  id: string
  ownerId: string
  principal: string
  prefix: string
  permissions: GatewayPermission[]
  scope: GatewayScope
  createdAt: number
  expiresAt?: number
  revokedAt?: number
  lastUsedAt?: number
}

export type GatewayCredentialAuth = GatewayCredential & { tokenId: string }

export class GatewayAuthError extends Error {
  constructor(readonly code: 'GATEWAY_TOKEN_REQUIRED' | 'GATEWAY_TOKEN_INVALID' | 'GATEWAY_TOKEN_EXPIRED' | 'GATEWAY_TOKEN_REVOKED' | 'GATEWAY_PERMISSION_DENIED' | 'GATEWAY_SCOPE_DENIED', message?: string) {
    super(message ?? code)
  }
}

type GatewayRecord = Record<string, unknown> & { id: string }
const collectionName = 'gateway_credentials'
const tokenPrefix = 'subpolar_gw_'

function list(value: unknown): string[] { return Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim()))] : [] }
function hash(secret: string): string { return createHash('sha256').update(secret).digest('hex') }
function recordToCredential(record: GatewayRecord): GatewayCredential {
  const expiresAt = typeof record.expires_at === 'number' && record.expires_at > 0 ? record.expires_at : undefined
  const revokedAt = typeof record.revoked_at === 'number' && record.revoked_at > 0 ? record.revoked_at : undefined
  return {
    id: record.id,
    ownerId: String(record.owner_id),
    principal: String(record.principal),
    prefix: String(record.prefix),
    permissions: list(record.permissions).filter((item): item is GatewayPermission => (GATEWAY_PERMISSIONS as readonly string[]).includes(item)),
    scope: { projectIds: list(record.project_ids), agentNames: list(record.agent_names), sessionIds: list(record.session_ids) },
    createdAt: Number(record.created_at),
    ...(expiresAt === undefined ? {} : { expiresAt }),
    ...(revokedAt === undefined ? {} : { revokedAt }),
    ...(typeof record.last_used_at === 'number' ? { lastUsedAt: record.last_used_at } : {}),
  }
}

export function publicGatewayCredential(credential: GatewayCredential): Omit<GatewayCredential, 'revokedAt'> & { revoked: boolean } {
  const { revokedAt, ...safe } = credential
  return { ...safe, revoked: revokedAt !== undefined }
}

export function hashGatewaySecret(secret: string): string { return hash(secret) }

export async function createGatewayCredential(client: PocketBase, input: { ownerId: string; principal: string; permissions: readonly GatewayPermission[]; scope?: GatewayScope; expiresAt?: number }): Promise<{ credential: GatewayCredential; secret: string }> {
  const secret = `${tokenPrefix}${randomBytes(32).toString('base64url')}`
  const now = Date.now()
  const scope = { projectIds: list(input.scope?.projectIds), agentNames: list(input.scope?.agentNames), sessionIds: list(input.scope?.sessionIds) }
  const permissions = [...new Set(input.permissions)].filter((item): item is GatewayPermission => (GATEWAY_PERMISSIONS as readonly string[]).includes(item))
  if (!input.ownerId.trim() || !input.principal.trim() || !permissions.length) throw new GatewayAuthError('GATEWAY_PERMISSION_DENIED', 'A credential owner, principal, and permission are required')
  if (input.expiresAt !== undefined && (!Number.isFinite(input.expiresAt) || input.expiresAt <= now)) throw new GatewayAuthError('GATEWAY_TOKEN_EXPIRED', 'Credential expiry must be in the future')
  const record = await client.collection(collectionName).create({ owner_id: input.ownerId, principal: input.principal.trim(), prefix: secret.slice(0, 22), secret_hash: hash(secret), permissions, project_ids: scope.projectIds, agent_names: scope.agentNames, session_ids: scope.sessionIds, created_at: now, expires_at: input.expiresAt ?? 0, revoked_at: 0, last_used_at: 0 }) as unknown as GatewayRecord
  return { credential: recordToCredential(record), secret }
}

export async function listGatewayCredentials(client: PocketBase, ownerId: string): Promise<GatewayCredential[]> {
  const records = await client.collection(collectionName).getFullList({ filter: `owner_id = "${ownerId.replaceAll('"', '\\"')}"`, sort: '-created_at' }) as unknown as GatewayRecord[]
  return records.map(recordToCredential)
}

export async function revokeGatewayCredential(client: PocketBase, ownerId: string, id: string): Promise<boolean> {
  const record = await client.collection(collectionName).getOne(id).catch(() => null) as unknown as GatewayRecord | null
  if (!record || String(record.owner_id) !== ownerId) return false
  await client.collection(collectionName).update(id, { revoked_at: Date.now() })
  return true
}

export async function rotateGatewayCredential(client: PocketBase, ownerId: string, id: string): Promise<{ credential: GatewayCredential; secret: string } | null> {
  const record = await client.collection(collectionName).getOne(id).catch(() => null) as unknown as GatewayRecord | null
  if (!record || String(record.owner_id) !== ownerId) return null
  const old = recordToCredential(record)
  await client.collection(collectionName).update(id, { revoked_at: Date.now() })
  return createGatewayCredential(client, { ownerId, principal: old.principal, permissions: old.permissions, scope: old.scope, ...(old.expiresAt === undefined ? {} : { expiresAt: old.expiresAt }) })
}

export async function authenticateGatewayCredential(client: PocketBase, token: string | null): Promise<GatewayCredentialAuth> {
  if (!token?.trim()) throw new GatewayAuthError('GATEWAY_TOKEN_REQUIRED', 'A scoped gateway token is required')
  const value = token.trim()
  if (!value.startsWith(tokenPrefix)) throw new GatewayAuthError('GATEWAY_TOKEN_INVALID', 'Invalid scoped gateway token')
  const prefix = value.slice(0, 22)
  const record = await client.collection(collectionName).getFirstListItem(`prefix = "${prefix}"`).catch(() => null) as unknown as GatewayRecord | null
  if (!record) throw new GatewayAuthError('GATEWAY_TOKEN_INVALID', 'Invalid scoped gateway token')
  const expected = Buffer.from(String(record.secret_hash), 'hex')
  const actual = Buffer.from(hash(value), 'hex')
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new GatewayAuthError('GATEWAY_TOKEN_INVALID', 'Invalid scoped gateway token')
  const credential = recordToCredential(record)
  if (credential.revokedAt !== undefined) throw new GatewayAuthError('GATEWAY_TOKEN_REVOKED', 'Scoped gateway token has been revoked')
  if (credential.expiresAt !== undefined && credential.expiresAt <= Date.now()) throw new GatewayAuthError('GATEWAY_TOKEN_EXPIRED', 'Scoped gateway token has expired')
  await client.collection(collectionName).update(record.id, { last_used_at: Date.now() })
  return { ...credential, tokenId: record.id }
}

export function assertGatewayAccess(credential: GatewayCredentialAuth, permission: GatewayPermission, context: { projectId?: string; agentName?: string; sessionId?: string }): void {
  if (!credential.permissions.includes(permission)) throw new GatewayAuthError('GATEWAY_PERMISSION_DENIED', `Gateway credential lacks ${permission} permission`)
  const scope = credential.scope
  if (Boolean(scope.projectIds?.length && (!context.projectId || !scope.projectIds.includes(context.projectId))) || Boolean(scope.agentNames?.length && (!context.agentName || !scope.agentNames.includes(context.agentName))) || Boolean(scope.sessionIds?.length && (!context.sessionId || !scope.sessionIds.includes(context.sessionId)))) throw new GatewayAuthError('GATEWAY_SCOPE_DENIED', 'Gateway credential is outside the requested scope')
}
