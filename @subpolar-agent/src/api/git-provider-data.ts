import { API_BASE_URL } from '@/config'
import { fetchWrapper } from './fetchWrapper'

export type ProviderRepositoryMapping = Readonly<{ accountId: string; owner: string; repo: string }>
export type ProviderRepository = Readonly<Record<string, unknown>>
export type ProviderBranch = Readonly<Record<string, unknown>>
export type ProviderIssue = Readonly<{ number: number; title: string; state: string; body?: string | null; [key: string]: unknown }>
export type ProviderComment = Readonly<{ body?: string | null; user?: { login?: string } | string; createdAt?: string; [key: string]: unknown }>
export type ProviderPullRequest = Readonly<{
  number: number
  title: string
  state: string
  body?: string | null
  base?: string | { ref?: string }
  head?: string
  headSha?: string | null
  [key: string]: unknown
}>
export type ProviderStatus = Readonly<Record<string, unknown>>

const root = `${API_BASE_URL}/api/git/provider-accounts`
const repoPath = (mapping: ProviderRepositoryMapping) => `${root}/${encodeURIComponent(mapping.accountId)}/repos/${encodeURIComponent(mapping.owner)}/${encodeURIComponent(mapping.repo)}`

export const gitProviderDataApi = {
  repository: (mapping: ProviderRepositoryMapping) => fetchWrapper<{ repository: ProviderRepository }>(`${repoPath(mapping)}/repository`),
  branches: (mapping: ProviderRepositoryMapping) => fetchWrapper<{ branches: ProviderBranch[] }>(`${repoPath(mapping)}/branches`),
  issues: (mapping: ProviderRepositoryMapping) => fetchWrapper<{ issues: ProviderIssue[] }>(`${repoPath(mapping)}/issues`),
  pulls: (mapping: ProviderRepositoryMapping) => fetchWrapper<{ pulls: ProviderPullRequest[] }>(`${repoPath(mapping)}/pulls`),
  comments: (mapping: ProviderRepositoryMapping, number: number) => fetchWrapper<{ comments: ProviderComment[] }>(`${repoPath(mapping)}/issues/${encodeURIComponent(String(number))}/comments`),
  statuses: (mapping: ProviderRepositoryMapping, sha: string) => fetchWrapper<{ statuses: ProviderStatus[] }>(`${repoPath(mapping)}/statuses/${encodeURIComponent(sha)}`),
}
