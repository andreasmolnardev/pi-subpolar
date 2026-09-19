import { executeGit, type GitExecutor, GitExecutionError, DEFAULT_GIT_OUTPUT_BYTES } from './executor.ts'
import { GitServiceError, type GitBranch, type GitDiff, type GitRepository, type GitStatus, type GitStatusEntry, type GitWorktree } from './contracts.ts'
import { GitPathPolicy, safeRef } from './policy.ts'
import { resolve } from 'node:path'

function executionError(error: unknown): never { if (error instanceof GitExecutionError) throw new GitServiceError(error.kind === 'timeout' ? 'GIT_TIMEOUT' : error.kind === 'output' ? 'GIT_OUTPUT_LIMIT' : 'GIT_FAILED', error.message) ; throw error }
function lines(value: string): string[] { return value.split('\n').map((line) => line.trim()).filter(Boolean) }

export class GitReadService {
  constructor(private readonly policy: GitPathPolicy, private readonly run: GitExecutor = executeGit) {}
  private async command(args: readonly string[], cwd: string, signal?: AbortSignal, maxOutputBytes = DEFAULT_GIT_OUTPUT_BYTES, truncateOutput = false) { try { return await this.run(args, { cwd, signal, maxOutputBytes, truncateOutput }) } catch (error) { return executionError(error) } }
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
