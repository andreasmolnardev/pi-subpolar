import { API_BASE_URL } from '@/config'
import { fetchWrapper } from './fetchWrapper'

export type GitProviderId = 'github' | 'gitea'
export type GitProviderAccount = {
  id: string
  provider: GitProviderId
  username: string
  displayName: string
  avatarUrl: string | null
  status: 'connected' | 'disabled'
  capabilities: { repoMetadata: true; branches: true; issues: true; comments: true; pullRequests: true; statuses: true; createPullRequest: false }
  connectedAt: number
}

const endpoint = `${API_BASE_URL}/api/git/provider-accounts`
export const gitProviderAccountsApi = {
  list: async (): Promise<{ accounts: GitProviderAccount[] }> => fetchWrapper(endpoint),
  connect: async (provider: GitProviderId, token: string): Promise<{ account: GitProviderAccount }> => fetchWrapper(endpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider, token }),
  }),
  status: async (id: string) => fetchWrapper(`${endpoint}/${encodeURIComponent(id)}/status`),
  revoke: async (id: string): Promise<{ ok: boolean }> => fetchWrapper(`${endpoint}/${encodeURIComponent(id)}`, { method: 'DELETE' }),
}
