import { API_BASE_URL } from '@/config'
import { fetchWrapper } from './fetchWrapper'

export interface StoredSession {
  id: string
  projectId: number | null
  directory: string | null
  title: string | null
  createdAt: number
  updatedAt: number
  archived: boolean
}

export interface StoredSessionPage {
  sessions: StoredSession[]
  nextCursor?: string
  page: { limit: number; order: 'asc' | 'desc'; hasNext: boolean; nextCursor?: string }
}

export async function listStoredSessions(): Promise<StoredSession[]> {
  const res = await fetchWrapper<{ sessions: StoredSession[] }>(`${API_BASE_URL}/api/sessions`)
  return res.sessions
}

export async function listStoredSessionsPage(params: { limit?: number; search?: string; cursor?: string } = {}): Promise<StoredSessionPage> {
  const query = new URLSearchParams()
  if (params.limit !== undefined) query.set('limit', String(params.limit))
  if (params.search) query.set('search', params.search)
  if (params.cursor) query.set('cursor', params.cursor)
  const suffix = query.toString() ? `?${query.toString()}` : ''
  const res = await fetchWrapper<StoredSessionPage>(`${API_BASE_URL}/api/sessions${suffix}`)
  return { ...res, page: res.page ?? { limit: params.limit ?? 25, order: 'desc', hasNext: Boolean(res.nextCursor), nextCursor: res.nextCursor } }
}

export async function updateStoredSession(
  sessionId: string,
  data: { directory?: string | null; title?: string | null; projectId?: number | string | null; archived?: boolean },
): Promise<void> {
  await fetchWrapper(`${API_BASE_URL}/api/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
}
