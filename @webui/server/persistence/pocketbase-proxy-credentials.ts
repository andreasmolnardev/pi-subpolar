import type PocketBase from 'pocketbase'
import type { RecordModel } from 'pocketbase'
import { createHash } from 'node:crypto'
import { escapeFilter } from './pocketbase.ts'

export type ProxyCredential = {
  id: string
  prefix: string
  hash: string
  createdAt: number
  lastUsedAt?: number
}

type CredentialRecord = RecordModel & Record<string, unknown>

function collection(client: PocketBase) {
  return client.collection('proxy_credentials') as unknown as {
    create: (data: Record<string, unknown>) => Promise<CredentialRecord>
    getFirstListItem: (filter: string, options?: Record<string, unknown>) => Promise<CredentialRecord>
    getFullList: (options?: Record<string, unknown>) => Promise<CredentialRecord[]>
    update: (id: string, data: Record<string, unknown>) => Promise<CredentialRecord>
    delete: (id: string) => Promise<boolean>
  }
}

function ownerFilter(ownerId: string): string {
  return `owner_id = "${escapeFilter(ownerId)}"`
}

function fromRecord(record: CredentialRecord): ProxyCredential {
  return {
    id: String(record.credential_id),
    prefix: String(record.prefix),
    hash: String(record.secret_hash),
    createdAt: Number(record.created_at),
    ...(typeof record.last_used_at === 'number' ? { lastUsedAt: record.last_used_at } : {}),
  }
}

export function hashProxySecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex')
}

export function proxyCredentialResponse(credential: ProxyCredential) {
  return { id: credential.id, prefix: credential.prefix, createdAt: credential.createdAt, lastUsedAt: credential.lastUsedAt ?? null }
}

export class PocketBaseProxyCredentialStore {
  constructor(private readonly client: PocketBase) {}

  async list(ownerId: string): Promise<ProxyCredential[]> {
    const records = await collection(this.client).getFullList({ filter: ownerFilter(ownerId), sort: 'created_at' })
    return records.filter((record) => !record.revoked_at).map(fromRecord)
  }

  async authenticate(secret: string): Promise<{ ownerId: string; credential: ProxyCredential } | null> {
    if (!secret) return null
    const record = await collection(this.client).getFirstListItem(`secret_hash = "${escapeFilter(hashProxySecret(secret))}"`).catch(() => null)
    if (!record || (record.revoked_at !== undefined && record.revoked_at !== null && Number(record.revoked_at) > 0)) return null
    const credential = fromRecord(record)
    await collection(this.client).update(record.id, { last_used_at: Date.now() })
    return { ownerId: String(record.owner_id), credential }
  }

  async create(ownerId: string, credential: ProxyCredential): Promise<void> {
    await collection(this.client).create({
      owner_id: ownerId,
      credential_id: credential.id,
      prefix: credential.prefix,
      secret_hash: credential.hash,
      created_at: credential.createdAt,
      last_used_at: credential.lastUsedAt ?? null,
      revoked_at: null,
    })
  }

  async revoke(ownerId: string, credentialId: string): Promise<boolean> {
    const record = await collection(this.client).getFirstListItem(`${ownerFilter(ownerId)} && credential_id = "${escapeFilter(credentialId)}"`).catch(() => null)
    if (!record) return false
    await collection(this.client).update(record.id, { revoked_at: Date.now() })
    return true
  }
}
