export type GitErrorCode = 'INVALID_REQUEST' | 'PROJECT_NOT_FOUND' | 'NOT_REPOSITORY' | 'PATH_DENIED' | 'REF_DENIED' | 'MUTATION_DENIED' | 'APPROVAL_REQUIRED' | 'UNSUPPORTED' | 'CONFLICT' | 'GIT_CONFLICT' | 'GIT_FAILED' | 'GIT_TIMEOUT' | 'GIT_OUTPUT_LIMIT'

export type GitRepository = { root: '.'; gitDir: '.git' | string; bare: boolean; head: string | null }
export type GitStatusEntry = { path: string; originalPath?: string; index: string; worktree: string; untracked: boolean; renamed: boolean }
export type GitStatusOmission = { path: string; reason: 'PATH_DENIED' }
export type GitStatus = { branch: string | null; ahead: number; behind: number; entries: GitStatusEntry[]; omitted: GitStatusOmission[]; truncated: boolean }
export type GitBranch = { name: string; ref: string; current: boolean; remote: boolean; target?: string }
export type GitDiff = { ref?: string; path?: string; text: string; truncated: boolean; binary: boolean; bytes: number }
export type GitWorktree = { path: string; head: string | null; branch: string | null; detached: boolean; locked: boolean; prunable: boolean }

export type GitReadResult = {
  repository: GitRepository
  status?: GitStatus
  branches?: GitBranch[]
  diff?: GitDiff
  worktrees?: GitWorktree[]
}

export class GitServiceError extends Error {
  constructor(readonly code: GitErrorCode, message: string, readonly status = code === 'PROJECT_NOT_FOUND' ? 404 : code === 'PATH_DENIED' || code === 'REF_DENIED' || code === 'MUTATION_DENIED' || code === 'APPROVAL_REQUIRED' || code === 'UNSUPPORTED' ? 400 : code === 'NOT_REPOSITORY' ? 422 : code === 'GIT_TIMEOUT' || code === 'GIT_OUTPUT_LIMIT' ? 504 : code === 'CONFLICT' || code === 'GIT_CONFLICT' ? 409 : 400) {
    super(message)
    this.name = 'GitServiceError'
  }
}

export type GitMutationOperation = 'stage' | 'unstage' | 'commit' | 'branch-create' | 'branch-switch' | 'checkpoint-capture' | 'checkpoint-restore'
export type GitMutationApproval = { token?: string }
export type GitMutationResult = { head: string | null; branch: string | null }
export type GitCheckpoint = { version: 1; id: string; head: string | null; branch: string | null; stash: string | null; untracked: string[] }
