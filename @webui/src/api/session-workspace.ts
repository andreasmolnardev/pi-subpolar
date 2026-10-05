import { API_BASE_URL } from '@/config'
import { fetchWrapper } from './fetchWrapper'

export interface WorkspaceFile {
  path: string
  status: string
  additions: number
  deletions: number
  binary?: boolean
}
export interface WorkspaceGroup { id: string; name: string; message: string; paths: string[] }
export interface SessionWorkspace {
  isGit: boolean
  branch: string | null
  files: WorkspaceFile[]
  additions: number
  deletions: number
  groups: WorkspaceGroup[]
}
export interface WorkspaceEntry { name: string; path: string; directory: boolean }
const base = (id: string) => `${API_BASE_URL}/api/sessions/${encodeURIComponent(id)}/workspace`
const json = (method: string, body: unknown) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

export const sessionWorkspaceApi = {
  get: (id: string) => fetchWrapper<SessionWorkspace>(base(id)),
  search: (id: string, query: string, signal?: AbortSignal) => fetchWrapper<{ paths: string[]; truncated: boolean }>(`${base(id)}/search`, { params: { query }, signal }),
  diff: (id: string, path: string) => fetchWrapper<{ text: string; binary?: boolean }>(`${base(id)}/diff`, { params: { path } }),
  files: (id: string, path = '') => fetchWrapper<{ entries: WorkspaceEntry[] }>(`${base(id)}/files`, { params: { path } }),
  file: (id: string, path: string) => fetchWrapper<{ content: string }>(`${base(id)}/file`, { params: { path } }),
  save: (id: string, path: string, content: string, expectedContent: string) => fetchWrapper<{ content: string }>(`${base(id)}/file`, json('PUT', { path, content, expectedContent })),
  createGroup: (id: string, name: string) => fetchWrapper<WorkspaceGroup>(`${base(id)}/groups`, json('POST', { name })),
  updateGroup: (id: string, groupId: string, update: { name?: string; message?: string }) => fetchWrapper<WorkspaceGroup>(`${base(id)}/groups/${encodeURIComponent(groupId)}`, json('PATCH', update)),
  stage: (id: string, path: string, groupId: string) => fetchWrapper<{ groups: WorkspaceGroup[] }>(`${base(id)}/stage`, json('POST', { path, groupId })),
  unstage: (id: string, path: string) => fetchWrapper<{ groups: WorkspaceGroup[] }>(`${base(id)}/unstage`, json('POST', { path })),
  commit: (id: string, groupId: string) => fetchWrapper<unknown>(`${base(id)}/commit`, json('POST', { groupId })),
}
