export type GitFileStatusType = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'copied'

export interface GitFileStatus {
  path: string
  status: GitFileStatusType
  staged: boolean
  oldPath?: string
  additions?: number
  deletions?: number
}

export interface GitCommit {
  hash: string
  authorName: string
  authorEmail: string
  date: string
  message: string
  unpushed?: boolean
}

export interface CommitFile {
  path: string
  status: GitFileStatusType
  oldPath?: string
  additions: number
  deletions: number
}

export interface CommitDetails extends GitCommit {
  files: CommitFile[]
}

export interface GitStatusResponse {
  branch: string
  ahead: number
  behind: number
  files: GitFileStatus[]
  hasChanges: boolean
}

export interface FileDiffResponse {
  path: string
  status: GitFileStatusType
  diff: string | null
  additions: number
  deletions: number
  isBinary: boolean
}

export interface RepositoryRead {
  root: string
  gitDir: string
  bare: boolean
  head: string | null
}

export interface RepositoryStatusRead {
  branch: string | null
  ahead: number
  behind: number
  entries: Array<{ path: string; originalPath?: string; index: string; worktree: string; untracked: boolean; renamed: boolean }>
  truncated: boolean
}

export interface RepositoryBranchRead { name: string; ref: string; current: boolean; remote: boolean; target?: string }
export interface RepositoryDiffRead { ref?: string; path?: string; text: string; truncated: boolean; binary: boolean; bytes: number }
export interface RepositoryWorktreeRead { path: string; head: string | null; branch: string | null; detached: boolean; locked: boolean; prunable: boolean }
