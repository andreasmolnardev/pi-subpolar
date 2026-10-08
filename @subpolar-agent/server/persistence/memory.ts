import type PocketBase from 'pocketbase'
import { escapeFilter } from './pocketbase.ts'

export type MemoryScope = 'user' | 'agent' | 'project'
export type MemoryRecord = {
  id: string
  owner_id: string
  scope: MemoryScope
  agent_id?: string
  project_id?: string
  content: string
  metadata: Record<string, unknown>
  created_at: number
  updated_at: number
  version: number
  tombstone: boolean
  idempotency_key?: string
}

export type MemoryContext = { ownerId: string; agentId: string; projectId?: string }
export const MEMORY_MAX_LIMIT = 50
const MEMORY_CONTENT_LIMIT = 32 * 1024

export class MemoryAccessError extends Error {
  readonly code = 'MEMORY_SCOPE_DENIED'
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is required`)
  return value.trim()
}

function scope(value: unknown): MemoryScope {
  if (value === 'user' || value === 'agent' || value === 'project') return value
  throw new Error('scope must be user, agent, or project')
}

function record(value: Record<string, unknown>): MemoryRecord {
  const item = value as MemoryRecord
  return {
    id: String(item.id), owner_id: String(item.owner_id), scope: scope(item.scope),
    ...(typeof item.agent_id === 'string' ? { agent_id: item.agent_id } : {}),
    ...(typeof item.project_id === 'string' ? { project_id: item.project_id } : {}),
    content: String(item.content ?? ''), metadata: item.metadata && typeof item.metadata === 'object' && !Array.isArray(item.metadata) ? item.metadata as Record<string, unknown> : {},
    created_at: Number(item.created_at), updated_at: Number(item.updated_at), version: Number(item.version ?? 1), tombstone: item.tombstone === true,
    ...(typeof item.idempotency_key === 'string' ? { idempotency_key: item.idempotency_key } : {}),
  }
}

function assertVisible(item: MemoryRecord, context: MemoryContext): void {
  if (item.owner_id !== context.ownerId) throw new MemoryAccessError('Memory record is not owned by the active user')
  if (item.scope === 'agent' && item.agent_id !== context.agentId) throw new MemoryAccessError('Memory record is outside the active agent scope')
  if (item.scope === 'project' && (!context.projectId || item.project_id !== context.projectId)) throw new MemoryAccessError('Memory record is outside the active project scope')
}

function uniqueIndexForIdempotency(index: string): boolean {
  const normalized = index.toLowerCase().replaceAll('`', '').replaceAll('"', '').replace(/\s+/g, ' ')
  return /create\s+unique\s+index\s+\S+\s+on\s+memory_records\s*\(\s*owner_id\s*,\s*idempotency_key\s*\)/.test(normalized)
}

export class PocketBaseMemoryService {
  constructor(private readonly client: PocketBase, private readonly collectionName = 'memory_records') {}

  private collection() { return this.client.collection(this.collectionName) }

  private async assertAtomicIdempotency(): Promise<void> {
    const collections = (this.client as PocketBase & { collections?: { getOne?: (name: string) => Promise<unknown> } }).collections
    if (!collections?.getOne) throw new Error('Memory idempotency requires a verified unique owner/idempotency index')
    const schema = await collections.getOne(this.collectionName).catch(() => null) as { indexes?: unknown } | null
    const indexes = Array.isArray(schema?.indexes) ? schema.indexes : []
    if (!indexes.some((index) => typeof index === 'string' && uniqueIndexForIdempotency(index))) {
      throw new Error('Memory idempotency requires a verified unique owner/idempotency index')
    }
  }

  async query(context: MemoryContext, input: { scope?: MemoryScope; query?: string; limit?: number }): Promise<MemoryRecord[]> {
    const limit = Math.min(Math.max(Math.trunc(input.limit ?? 20), 1), MEMORY_MAX_LIMIT)
    const requested = input.scope === undefined ? undefined : scope(input.scope)
    const query = typeof input.query === 'string' ? input.query.trim().toLocaleLowerCase() : ''
    const records = await this.collection().getFullList({ filter: `owner_id = "${escapeFilter(context.ownerId)}"`, sort: '-updated_at' })
    return records.map((value) => record(value)).filter((item) => {
      if (item.tombstone || (requested && item.scope !== requested)) return false
      try { assertVisible(item, context) } catch { return false }
      return !query || item.content.toLocaleLowerCase().includes(query)
    }).slice(0, limit)
  }

  async write(context: MemoryContext, input: { scope: MemoryScope; content: string; metadata?: Record<string, unknown>; idempotencyKey?: string }): Promise<MemoryRecord> {
    const selected = scope(input.scope)
    const content = text(input.content, 'content')
    if (content.length > MEMORY_CONTENT_LIMIT) throw new Error('Memory content exceeds the configured limit')
    const now = Date.now()
    if (input.idempotencyKey) {
      await this.assertAtomicIdempotency()
      const existing = await this.collection().getFirstListItem(`owner_id = "${escapeFilter(context.ownerId)}" && idempotency_key = "${escapeFilter(input.idempotencyKey)}"`).catch(() => null)
      if (existing) { const item = record(existing); assertVisible(item, context); return item }
    }
    const data = {
      owner_id: context.ownerId,
      scope: selected,
      ...(selected === 'agent' ? { agent_id: context.agentId } : {}),
      ...(selected === 'project' ? { project_id: text(context.projectId, 'projectId') } : {}),
      content,
      metadata: input.metadata ?? {},
      created_at: now,
      updated_at: now,
      version: 1,
      tombstone: false,
      ...(input.idempotencyKey ? { idempotency_key: input.idempotencyKey } : {}),
    }
    try {
      return record(await this.collection().create(data))
    } catch (error) {
      if (!input.idempotencyKey) throw error
      const existing = await this.collection().getFirstListItem(`owner_id = "${escapeFilter(context.ownerId)}" && idempotency_key = "${escapeFilter(input.idempotencyKey)}"`).catch(() => null)
      if (!existing) throw error
      const item = record(existing)
      assertVisible(item, context)
      return item
    }
  }

  async update(context: MemoryContext, id: string, input: { content?: string; metadata?: Record<string, unknown>; version: number }): Promise<MemoryRecord> {
    const current = await this.collection().getOne(text(id, 'id')).catch(() => null)
    if (!current) throw new MemoryAccessError('Memory record was not found')
    const item = record(current); assertVisible(item, context)
    if (item.tombstone || item.version !== input.version) throw new Error('Memory record version conflict')
    const content = input.content === undefined ? item.content : text(input.content, 'content')
    if (content.length > MEMORY_CONTENT_LIMIT) throw new Error('Memory content exceeds the configured limit')
    return record(await this.collection().update(item.id, { ...(input.content === undefined ? {} : { content }), ...(input.metadata === undefined ? {} : { metadata: input.metadata }), version: item.version + 1, updated_at: Date.now() }))
  }

  async tombstone(context: MemoryContext, id: string, version: number): Promise<MemoryRecord> {
    const current = await this.collection().getOne(text(id, 'id')).catch(() => null)
    if (!current) throw new MemoryAccessError('Memory record was not found')
    const item = record(current); assertVisible(item, context)
    if (item.tombstone) return item
    if (item.version !== version) throw new Error('Memory record version conflict')
    return record(await this.collection().update(item.id, { tombstone: true, version: item.version + 1, updated_at: Date.now() }))
  }
}
