import { API_BASE_URL } from '@/config'
import { fetchWrapper, fetchWrapperBlob, fetchWrapperVoid } from './fetchWrapper'
export interface BrowserScope { projectId?: string; sessionId?: string; taskId?: string }
export interface BrowserProfile { id: string; name: string; busy?: boolean; lifecycle?: string }
export interface BrowserSession { id: string; lifecycle: string; current_url?: string; current_tab_id?: string; tabs: Array<{ id: string; title: string; url: string }> }
export interface BrowserController { leaseId: string; expiresAt: number }
export interface BrowserConfiguration { allowedProfileIds: string[]; defaultProfileId?: string; allowEphemeral?: boolean }
export interface ScreenshotArtifact { id: string; status: string; mimeType?: string; createdAt?: number }
const root = `${API_BASE_URL}/api/browser`
const json = (method: string, body: unknown) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
const sessionUrl = (id: string, action: string) => `${root}/sessions/${encodeURIComponent(id)}/${action}`
export const browserApi = {
  profiles: () => fetchWrapper<{ profiles: BrowserProfile[] }>(`${root}/profiles`),
  createProfile: (name: string) => fetchWrapper<{ profile: BrowserProfile }>(`${root}/profiles`, json('POST', { name })),
  renameProfile: (id: string, name: string) => fetchWrapper(`${root}/profiles/${encodeURIComponent(id)}`, json('PATCH', { name })),
  deleteProfile: (id: string) => fetchWrapperVoid(`${root}/profiles/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  clearProfile: (id: string) => fetchWrapperVoid(`${root}/profiles/${encodeURIComponent(id)}/clear`, { method: 'POST' }),
  sessions: (scope: BrowserScope) => fetchWrapper<{ sessions: BrowserSession[] }>(`${root}/sessions`, { params: { ...scope } }),
  create: (scope: BrowserScope, profileId?: string) => fetchWrapper<{ session: BrowserSession }>(`${root}/sessions`, json('POST', { ...scope, profileId })),
  frame: (id: string, scope: BrowserScope, signal?: AbortSignal) => fetchWrapper<{ frame: { mimeType: string; data: string }; session: BrowserSession; controller: BrowserController | null }>(sessionUrl(id, 'frame'), { params: { ...scope }, signal }),
  control: (id: string, scope: BrowserScope, action: 'take' | 'renew' | 'release', leaseId?: string) => fetchWrapper<{ controller: BrowserController | null }>(sessionUrl(id, 'control'), { ...json('POST', { action, leaseId }), params: { ...scope } }),
  input: (id: string, scope: BrowserScope, leaseId: string, operation: string, input: Record<string, unknown>) => fetchWrapper<{ session: BrowserSession }>(sessionUrl(id, 'input'), { ...json('POST', { leaseId, operation, input }), params: { ...scope } }),
  close: (id: string, scope: BrowserScope) => fetchWrapper(sessionUrl(id, 'close'), { method: 'POST', params: { ...scope } }),
  artifact: (id: string, signal?: AbortSignal) => fetchWrapperBlob(`${root}/artifacts/${encodeURIComponent(id)}/file`, { signal }),
}
