import { executeGit, type GitExecutor, GitExecutionError, DEFAULT_GIT_OUTPUT_BYTES } from './executor.ts'
import { GitServiceError, type GitBranch, type GitCheckpoint, type GitDiff, type GitMutationApproval, type GitMutationOperation, type GitMutationResult, type GitRepository, type GitStatus, type GitStatusEntry, type GitWorktree } from './contracts.ts'
import { GitPathPolicy, safeRef } from './policy.ts'
import { resolve } from 'node:path'

const GIT_DETAIL_LIMIT = 512
function conflictDetails(value: string): string { const detail = value.replaceAll(/\s+/g, ' ').trim().slice(0, GIT_DETAIL_LIMIT); return detail ? `Git checkpoint conflict: ${detail}` : 'Git checkpoint conflict' }
function executionError(error: unknown, conflict = false): never { if (error instanceof GitExecutionError) { if (conflict && error.kind === 'failed') throw new GitServiceError('GIT_CONFLICT', conflictDetails(error.stderr || error.stdout)); throw new GitServiceError(error.kind === 'timeout' ? 'GIT_TIMEOUT' : error.kind === 'output' ? 'GIT_OUTPUT_LIMIT' : 'GIT_FAILED', error.message) } ; throw error }
function lines(value: string): string[] { return value.split('\n').map((line) => line.trim()).filter(Boolean) }

export class GitReadService {
  constructor(protected readonly policy: GitPathPolicy, protected readonly run: GitExecutor = executeGit) {}
  protected async command(args: readonly string[], cwd: string, signal?: AbortSignal, maxOutputBytes = DEFAULT_GIT_OUTPUT_BYTES, truncateOutput = false) { const conflict = args[0] === 'stash' && args[1] === 'apply'; try { const result = await this.run(args, { cwd, signal, maxOutputBytes, truncateOutput }); if (result.code !== 0) { if (conflict) throw new GitServiceError('GIT_CONFLICT', conflictDetails(result.stderr || result.stdout)); throw new GitServiceError('GIT_FAILED', 'Git operation failed') } return result } catch (error) { return executionError(error, conflict) } }
  private async repository(root: string, signal?: AbortSignal): Promise<GitRepository> {
    try {
      const result = await this.command(['rev-parse', '--git-dir', '--is-bare-repository'], root, signal)
      const values = lines(result.stdout)
      if (values.length < 2 || values[1] !== 'false') throw new GitServiceError('NOT_REPOSITORY', 'Project is not a Git repository', 422)
      let head: string | null = null
      try { head = lines((await this.command(['rev-parse', '--verify', 'HEAD'], root, signal)).stdout)[0] ?? null } catch (error) { if (!(error instanceof GitServiceError) || error.code !== 'GIT_FAILED') throw error }
       return { root: '.', gitDir: resolve(root, values[0]!), bare: false, head }
    } catch (error) { if (error instanceof GitServiceError && error.code !== 'GIT_FAILED') throw error; throw new GitServiceError('NOT_REPOSITORY', 'Project is not a Git repository', 422) }
  }
  async discover(userId: string, projectId: string, signal?: AbortSignal) { const { root } = await this.policy.project(userId, projectId); return { repository: await this.repository(root, signal) } }
  async status(userId: string, projectId: string, signal?: AbortSignal): Promise<{ repository: GitRepository; status: GitStatus }> {
    const { root } = await this.policy.project(userId, projectId); const repository = await this.repository(root, signal)
    const result = await this.command(['status', '--porcelain=v1', '-z', '--branch'], root, signal)
     const tokens = result.stdout.split('\0').filter((token) => token !== ''); const branchLine = tokens.shift() ?? ''
     const branch = branchLine.match(/^## (.+?)(?:\.\.\S+)?(?: \[.*\])?$/)?.[1] ?? (branchLine === '## HEAD (no branch)' ? null : null)
     const tracking = branchLine.match(/\[ahead (\d+), behind (\d+)\]/); const entries: GitStatusEntry[] = []; const omitted: GitStatus['omitted'] = []
     for (let i = 0; i < tokens.length; i++) { const token = tokens[i]!; const code = token.slice(0, 2); const path = token.slice(3); let originalPath: string | undefined
       if (code.includes('R') || code.includes('C')) originalPath = tokens[++i]
       try {
         const safe = this.policy.path(root, path); if (!safe) continue
         const safeOriginal = originalPath === undefined ? undefined : this.policy.path(root, originalPath)
         entries.push({ path: safe, ...(safeOriginal ? { originalPath: safeOriginal } : {}), index: code[0]!, worktree: code[1]!, untracked: code === '??', renamed: code.includes('R') })
       } catch (error) {
         if (error instanceof GitServiceError && error.code === 'PATH_DENIED') { omitted.push({ path, reason: 'PATH_DENIED' }); continue }
         throw error
       }
     }
     return { repository, status: { branch, ahead: Number(tracking?.[1] ?? 0), behind: Number(tracking?.[2] ?? 0), entries, omitted, truncated: false } }
  }
  async branches(userId: string, projectId: string, signal?: AbortSignal) { const { root } = await this.policy.project(userId, projectId); const repository = await this.repository(root, signal); const result = await this.command(['for-each-ref', '--format=%(HEAD)%00%(refname:short)%00%(refname)%00%(upstream:short)', 'refs/heads', 'refs/remotes'], root, signal); const branches: GitBranch[] = []
    for (const row of result.stdout.split('\n').filter(Boolean)) { const [head, name, ref, target] = row.split('\0'); if (name && ref) branches.push({ name, ref, current: head === '*', remote: ref.startsWith('refs/remotes/'), ...(target ? { target } : {}) }) }; return { repository, branches }
  }
  async diff(userId: string, projectId: string, input: { path?: string; ref?: string; staged?: boolean } = {}, signal?: AbortSignal) { const { root } = await this.policy.project(userId, projectId); const repository = await this.repository(root, signal); const path = this.policy.path(root, input.path); const ref = safeRef(input.ref)
    const args = ['diff', '--no-ext-diff', '--binary', '--no-color']; if (input.staged) args.push('--cached'); if (ref) args.push(ref); args.push('--'); if (path) args.push(path); const result = await this.command(args, root, signal, DEFAULT_GIT_OUTPUT_BYTES, true); const binary = result.stdout.includes('Binary files') || result.stdout.includes('GIT binary patch'); return { repository, diff: { ...(ref ? { ref } : {}), ...(path ? { path } : {}), text: result.stdout, truncated: result.truncated === true, binary, bytes: Buffer.byteLength(result.stdout) } satisfies GitDiff }
  }
  async worktrees(userId: string, projectId: string, signal?: AbortSignal) { const { root } = await this.policy.project(userId, projectId); const repository = await this.repository(root, signal); const result = await this.command(['worktree', 'list', '--porcelain'], root, signal); const worktrees: GitWorktree[] = []; let current: Partial<GitWorktree> | undefined
    const flush = () => { if (current?.path) worktrees.push({ path: current.path === root ? '.' : current.path.slice(root.length + 1), head: current.head ?? null, branch: current.branch ?? null, detached: current.detached === true, locked: current.locked === true, prunable: current.prunable === true }); current = undefined }
    for (const line of result.stdout.split('\n')) { if (line.startsWith('worktree ')) { flush(); try { current = { path: this.policy.worktreePath(root, line.slice(9)), detached: false, locked: false, prunable: false } } catch { current = undefined } } else if (!current) continue; else if (line.startsWith('HEAD ')) current.head = line.slice(5); else if (line.startsWith('branch ')) current.branch = line.slice(7).replace(/^refs\/heads\//, ''); else if (line === 'detached') current.detached = true; else if (line.startsWith('locked')) current.locked = true; else if (line.startsWith('prunable')) current.prunable = true }; flush(); return { repository, worktrees } }
}

/** The only write surface for Git. Every operation is policy-authorized first. */
export class GitMutationService extends GitReadService {
  private async mutate(userId: string, projectId: string, operation: GitMutationOperation, approval: GitMutationApproval | undefined, args: string[], expected?: { head?: string | null; branch?: string | null }, authorized = false): Promise<GitMutationResult> {
    if (!authorized) await this.policy.authorizeMutation(userId, projectId, operation, approval)
    const { root } = await this.policy.project(userId, projectId)
    const before = await this.status(userId, projectId)
    if (expected && ((expected.head !== undefined && expected.head !== before.repository.head) || (expected.branch !== undefined && expected.branch !== before.status.branch))) throw new GitServiceError('CONFLICT', 'Repository changed since it was inspected')
    await this.command(args, root)
    const after = await this.status(userId, projectId)
    return { head: after.repository.head, branch: after.status.branch }
  }

  private paths(root: string, paths: readonly string[]): string[] {
    if (paths.length === 0 || paths.length > 128) throw new GitServiceError('INVALID_REQUEST', 'At least one path is required')
    const result = paths.map((path) => this.policy.path(root, path)).filter((path): path is string => path !== undefined)
    if (result.length !== paths.length) throw new GitServiceError('PATH_DENIED', 'Invalid repository path')
    return result
  }

  async stage(userId: string, projectId: string, paths: readonly string[], approval?: GitMutationApproval, expected?: { head?: string | null; branch?: string | null }) { const { root } = await this.policy.project(userId, projectId); return this.mutate(userId, projectId, 'stage', approval, ['add', '--', ...this.paths(root, paths)], expected) }
  async unstage(userId: string, projectId: string, paths: readonly string[], approval?: GitMutationApproval, expected?: { head?: string | null; branch?: string | null }) { const { root } = await this.policy.project(userId, projectId); return this.mutate(userId, projectId, 'unstage', approval, ['reset', '--', ...this.paths(root, paths)], expected) }
  async commit(userId: string, projectId: string, message: string, approval?: GitMutationApproval, expected?: { head?: string | null; branch?: string | null }) { if (!message.trim() || message.length > 1000 || message.includes('\0')) throw new GitServiceError('INVALID_REQUEST', 'Invalid commit message'); return this.mutate(userId, projectId, 'commit', approval, ['commit', '-m', message], expected) }
  async createBranch(userId: string, projectId: string, name: string, start?: string, approval?: GitMutationApproval, expected?: { head?: string | null; branch?: string | null }) { const ref = safeRef(name); if (!ref) throw new GitServiceError('REF_DENIED', 'Invalid Git reference'); const base = safeRef(start); return this.mutate(userId, projectId, 'branch-create', approval, ['branch', ref, ...(base ? [base] : [])], expected) }
  async switchBranch(userId: string, projectId: string, name: string, approval?: GitMutationApproval, expected?: { head?: string | null; branch?: string | null }) { const ref = safeRef(name); if (!ref) throw new GitServiceError('REF_DENIED', 'Invalid Git reference'); return this.mutate(userId, projectId, 'branch-switch', approval, ['switch', '--', ref], expected) }

  async captureCheckpoint(userId: string, projectId: string, approval?: GitMutationApproval): Promise<GitCheckpoint> {
    await this.policy.authorizeMutation(userId, projectId, 'checkpoint-capture', approval)
    const current = await this.status(userId, projectId)
    const { root } = await this.policy.project(userId, projectId)
    const stash = await this.command(['stash', 'create'], root)
    return { version: 1, id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`, head: current.repository.head, branch: current.status.branch, stash: lines(stash.stdout)[0] ?? null, untracked: current.status.entries.filter((entry) => entry.untracked).map((entry) => entry.path) }
  }

  async restoreCheckpoint(userId: string, projectId: string, checkpoint: GitCheckpoint, approval?: GitMutationApproval, options: { expectedHead?: string | null; expectedBranch?: string | null; deleteUntracked?: boolean } = {}): Promise<GitMutationResult> {
    await this.policy.authorizeMutation(userId, projectId, 'checkpoint-restore', approval)
    if (checkpoint.version !== 1 || !Array.isArray(checkpoint.untracked) || checkpoint.untracked.length > 128 || checkpoint.untracked.some((path) => typeof path !== 'string') || (checkpoint.stash !== null && !/^[0-9a-f]{7,64}$/.test(checkpoint.stash))) throw new GitServiceError('INVALID_REQUEST', 'Invalid checkpoint')
    const { root } = await this.policy.project(userId, projectId)
    const checkpointPaths = checkpoint.untracked.map((path) => this.policy.path(root, path)).filter((path): path is string => path !== undefined)
    if (checkpointPaths.length !== checkpoint.untracked.length || new Set(checkpointPaths).size !== checkpointPaths.length) throw new GitServiceError('PATH_DENIED', 'Invalid checkpoint path')
    const current = await this.status(userId, projectId)
    if ((options.expectedHead !== undefined && current.repository.head !== options.expectedHead) || (options.expectedBranch !== undefined && current.status.branch !== options.expectedBranch)) throw new GitServiceError('CONFLICT', 'Repository changed since it was inspected')
    const currentUntracked = current.status.entries.filter((entry) => entry.untracked)
    if (currentUntracked.length > 0 && options.deleteUntracked !== true) throw new GitServiceError('CONFLICT', 'Restore would affect untracked files')
    if (options.deleteUntracked === true) {
      if (!approval) throw new GitServiceError('APPROVAL_REQUIRED', 'Deleting untracked files requires explicit approval')
      throw new GitServiceError('UNSUPPORTED', 'Safe untracked deletion requires descriptor-relative filesystem operations')
    }
    if (!checkpoint.stash) return { head: current.repository.head, branch: current.status.branch }
    return this.mutate(userId, projectId, 'checkpoint-restore', approval, ['stash', 'apply', '--index', checkpoint.stash], { head: current.repository.head, branch: current.status.branch }, true)
  }
}
