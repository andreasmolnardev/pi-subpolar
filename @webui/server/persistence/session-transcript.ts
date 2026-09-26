import type PocketBase from 'pocketbase'
import { type RecordModel } from 'pocketbase'
import { redactSensitive } from '../core/security-redaction.ts'
import { escapeFilter } from './pocketbase.ts'

export const SESSION_TRANSCRIPTS_COLLECTION = 'session_transcripts'

export type SessionTranscript = {
  ownerId: string
  sessionId: string
  entries: unknown[]
  leafId: string | null
  updatedAt: number
}

type CollectionRecord = RecordModel & Record<string, unknown>
type TranscriptCollection = {
  getFirstListItem: (filter: string, options?: Record<string, unknown>) => Promise<CollectionRecord>
  getFullList: (options?: Record<string, unknown>) => Promise<CollectionRecord[]>
  create: (data: Record<string, unknown>) => Promise<CollectionRecord>
  update: (id: string, data: Record<string, unknown>) => Promise<CollectionRecord>
}

function collection(client: PocketBase): TranscriptCollection {
  return client.collection(SESSION_TRANSCRIPTS_COLLECTION) as unknown as TranscriptCollection
}

function value(value: string): string {
  return escapeFilter(value)
}

function transcriptFromRecord(record: CollectionRecord): SessionTranscript {
  return {
    ownerId: String(record.owner_id),
    sessionId: String(record.session_id),
    entries: Array.isArray(record.entries) ? record.entries : [],
    leafId: typeof record.leaf_id === 'string' && record.leaf_id ? record.leaf_id : null,
    updatedAt: typeof record.updated_at === 'number' ? record.updated_at : 0,
  }
}

export class SessionTranscriptRepository {
  constructor(private readonly client: PocketBase) {}

  async get(ownerId: string, sessionId: string): Promise<SessionTranscript | null> {
    const record = await collection(this.client)
      .getFirstListItem(`owner_id = "${value(ownerId)}" && session_id = "${value(sessionId)}"`)
      .catch(() => null)
    return record ? transcriptFromRecord(record) : null
  }

  async list(ownerId: string): Promise<SessionTranscript[]> {
    const records = await collection(this.client).getFullList({
      filter: `owner_id = "${value(ownerId)}"`,
      sort: '-updated_at',
    })
    return records.map(transcriptFromRecord)
  }

  async save(ownerId: string, sessionId: string, entries: readonly unknown[], leafId: string | null): Promise<SessionTranscript> {
    const current = await this.get(ownerId, sessionId)
    const data = {
      owner_id: ownerId,
      session_id: sessionId,
      // Transcript data is application-owned and must not become a secret sink.
      entries: redactSensitive([...entries]),
      leaf_id: leafId ?? '',
      updated_at: Date.now(),
    }
    const record = current
      ? await collection(this.client).update((await collection(this.client).getFirstListItem(`owner_id = "${value(ownerId)}" && session_id = "${value(sessionId)}"`)).id, data)
      : await collection(this.client).create(data)
    return transcriptFromRecord(record)
  }
}
