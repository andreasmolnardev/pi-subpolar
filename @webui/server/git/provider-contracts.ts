/**
 * Remote Git provider foundation. This adapter is intentionally not connected to
 * owner credential UI: existing general preferences are not a safe credential store.
 */
export type GitProviderId = 'github' | 'gitee'

export type GitProviderCapabilities = Readonly<{
  repoMetadata: true
  branches: true
  issues: true
  comments: true
  pullRequests: true
  statuses: true
  createPullRequest: boolean
}>

export type GitProviderRepository = Readonly<{
  id: string | number
  fullName: string
  name: string
  owner: string
  description: string | null
  defaultBranch: string | null
  htmlUrl: string
  private: boolean
}>

export type GitProviderBranch = Readonly<{ name: string; sha: string; protected: boolean }>
export type GitProviderIssue = Readonly<{ id: string | number; number: number; title: string; body: string | null; state: string; htmlUrl: string; user: string | null }>
export type GitProviderComment = Readonly<{ id: string | number; body: string; htmlUrl: string; user: string | null; createdAt: string | null }>
export type GitProviderPullRequest = Readonly<{ id: string | number; number: number; title: string; body: string | null; state: string; htmlUrl: string; head: string; headSha: string | null; base: string; merged: boolean }>
export type GitProviderStatus = Readonly<{ state: string; sha: string; description: string | null; targetUrl: string | null; context: string | null }>
export type GitProviderCreatePullRequestInput = Readonly<{ title: string; head: string; base: string; body?: string; draft?: boolean }>

export type GitProviderRepositoryRef = Readonly<{ owner: string; repo: string }>
export type GitProviderTokenSource = (provider: GitProviderId) => string | undefined | Promise<string | undefined>

export interface GitProvider {
  readonly id: GitProviderId
  readonly capabilities: GitProviderCapabilities
  discoverCapabilities(): GitProviderCapabilities
  getRepository(ref: GitProviderRepositoryRef, signal?: AbortSignal): Promise<GitProviderRepository>
  listBranches(ref: GitProviderRepositoryRef, signal?: AbortSignal): Promise<GitProviderBranch[]>
  listIssues(ref: GitProviderRepositoryRef, signal?: AbortSignal): Promise<GitProviderIssue[]>
  listComments(ref: GitProviderRepositoryRef, issueNumber: number, signal?: AbortSignal): Promise<GitProviderComment[]>
  listPullRequests(ref: GitProviderRepositoryRef, signal?: AbortSignal): Promise<GitProviderPullRequest[]>
  listStatuses(ref: GitProviderRepositoryRef, sha: string, signal?: AbortSignal): Promise<GitProviderStatus[]>
  createPullRequest(ref: GitProviderRepositoryRef, input: GitProviderCreatePullRequestInput, signal?: AbortSignal): Promise<GitProviderPullRequest>
}

export class GitProviderError extends Error {
  constructor(readonly code: 'INVALID_REQUEST' | 'UNAUTHORIZED' | 'NOT_FOUND' | 'RATE_LIMITED' | 'UPSTREAM_ERROR' | 'TIMEOUT' | 'RESPONSE_TOO_LARGE' | 'INVALID_RESPONSE', message: string) {
    super(message)
    this.name = 'GitProviderError'
  }
}
