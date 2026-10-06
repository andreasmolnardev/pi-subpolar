import { API_BASE_URL } from '@/config'
import { fetchWrapper } from './fetchWrapper'

export interface WorktreeSource { name: string; ref: string; current: boolean; remote: boolean; target?: string; sha?: string; symbolic?: string }
export interface WorktreeProviderRepository { remote: string; provider: 'github' | 'gitea'; owner: string; repo: string }
export interface WorktreeSources { repositoryId: string; repository: { head: string | null }; branches: WorktreeSource[]; remotes: string[]; providerRepository?: WorktreeProviderRepository }
export interface CreatedWorktree { repositoryId: string; projectId: number; worktree: { id: string; branch: string; path: string; baseRef: string; baseSha: string } }
const json = (body: unknown) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
const repository = (id: string) => `${API_BASE_URL}/api/projects/${encodeURIComponent(id)}/repository`
export const worktreesApi = {
  sources: (sessionId: string) => fetchWrapper<WorktreeSources>(`${API_BASE_URL}/api/sessions/${encodeURIComponent(sessionId)}/worktree-sources`),
  refreshRemote: (repositoryId: string, remote: string) => fetchWrapper<unknown>(`${repository(repositoryId)}/refresh`, json({ remote })),
  create: (repositoryId: string, input: { branch: string; sourceRef: string; expectedSha: string; approved: boolean }) => fetchWrapper<CreatedWorktree>(`${repository(repositoryId)}/worktrees`, json(input)),
  createSession: (created: CreatedWorktree, agent?: string) => fetchWrapper<{ session: { id: string; projectId: number } }>(`${API_BASE_URL}/api/sessions`, json({ repositoryId: created.repositoryId, worktreeId: created.worktree.id, agent, permission: 'ask' })),
}
