import { access, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ProjectRecord } from '../persistence/project-store.ts'
import { GitServiceError } from '../git/contracts.ts'
import { GitPathPolicy } from '../git/policy.ts'
import { GitExecutionError, type GitExecutor } from '../git/executor.ts'
import { GitMutationService, GitReadService } from '../git/service.ts'

const project = (path: string, userId = 'user-a'): ProjectRecord => ({ id: 'project-a', userId, name: 'A', path, createdAt: 1, updatedAt: 1 })

describe('Git read service', () => {
  it('resolves only owned projects and rejects traversal and symlink escapes', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'subpolar-git-'))
    const root = join(workspace, 'repo'); const outside = join(workspace, 'outside')
    await mkdir(root); await mkdir(outside); await writeFile(join(outside, 'secret'), 'secret'); await symlink(outside, join(root, 'link'))
    const policy = new GitPathPolicy(async (userId, id) => userId === 'user-a' && id === 'project-a' ? project(root) : null, workspace)
    expect((await policy.project('user-a', 'project-a')).root).toBe(root)
    await expect(policy.project('user-b', 'project-a')).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' })
    expect(() => policy.path(root, '../secret')).toThrowError(GitServiceError)
    expect(() => policy.path(root, 'link/secret')).toThrowError(GitServiceError)
  })

  it('passes argv without interpolation and parses status, branches, diff, and worktrees', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'subpolar-git-')); const root = join(workspace, 'repo'); await mkdir(root)
    const calls: string[][] = []
    const run: GitExecutor = async (args) => {
      calls.push([...args])
       if (args[0] === 'rev-parse' && args[1] === '--git-dir') return { stdout: '../common.git\nfalse\n', stderr: '', code: 0 }
      if (args[0] === 'rev-parse') return { stdout: 'abc123\n', stderr: '', code: 0 }
       if (args[0] === 'status') return { stdout: '## main...origin/main [ahead 1, behind 2]\0 M file.ts\0?? new.txt\0R  renamed.ts\0old.ts\0C  copied.ts\0source.ts\0', stderr: '', code: 0 }
      if (args[0] === 'for-each-ref') return { stdout: '*\0main\0refs/heads/main\0\n \0origin/main\0refs/remotes/origin/main\0\n', stderr: '', code: 0 }
      if (args[0] === 'diff') return { stdout: 'diff --git a/file.ts b/file.ts\n+hello\n', stderr: '', code: 0 }
      if (args[0] === 'worktree') return { stdout: `worktree ${root}\nHEAD abc123\nbranch refs/heads/main\n\n`, stderr: '', code: 0 }
      throw new Error('unexpected command')
    }
    const service = new GitReadService(new GitPathPolicy(async (userId, id) => userId === 'user-a' && id === 'project-a' ? project(root) : null, workspace), run)
     const status = await service.status('user-a', 'project-a')
     expect(status.repository.gitDir).toBe(join(workspace, 'common.git'))
     expect(status.status.entries).toEqual(expect.arrayContaining([
       expect.objectContaining({ path: 'renamed.ts', originalPath: 'old.ts', index: 'R', worktree: ' ' }),
       expect.objectContaining({ path: 'copied.ts', originalPath: 'source.ts', index: 'C', worktree: ' ' }),
     ]))
     expect(status.status.entries).toHaveLength(4)
     expect(status.status.omitted).toEqual([])
    expect((await service.branches('user-a', 'project-a')).branches[0]?.current).toBe(true)
    expect((await service.diff('user-a', 'project-a', { path: 'file.ts' })).diff.binary).toBe(false)
    expect((await service.worktrees('user-a', 'project-a')).worktrees[0]?.path).toBe('.')
    expect(calls.some((args) => args.includes('file.ts') && args.every((arg) => !arg.includes('&&')))).toBe(true)
    await expect(service.diff('user-a', 'project-a', { path: '--output=/tmp/x' })).rejects.toMatchObject({ code: 'PATH_DENIED' })
    await expect(service.diff('user-a', 'project-a', { ref: 'main..HEAD' })).rejects.toMatchObject({ code: 'REF_DENIED' })
  })

  it('omits an unsafe untracked symlink without losing safe status entries', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'subpolar-git-')); const root = join(workspace, 'repo'); const outside = join(workspace, 'outside'); await mkdir(root); await mkdir(outside); await symlink(outside, join(root, 'escape'))
    const run: GitExecutor = async (args) => {
      if (args[0] === 'rev-parse' && args[1] === '--git-dir') return { stdout: '.git\nfalse\n', stderr: '', code: 0 }
      if (args[0] === 'rev-parse') return { stdout: 'abc123\n', stderr: '', code: 0 }
      if (args[0] === 'status') return { stdout: '## main\0?? escape\0?? safe.txt\0', stderr: '', code: 0 }
      throw new Error('unexpected command')
    }
    const policy = new GitPathPolicy(async () => project(root), workspace)
    const status = await new GitReadService(policy, run).status('user-a', 'project-a')
    expect(status.status.entries).toEqual([expect.objectContaining({ path: 'safe.txt', untracked: true })])
    expect(status.status.omitted).toEqual([{ path: 'escape', reason: 'PATH_DENIED' }])
  })

  it('maps executor timeout/output failures to stable bounded errors', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'subpolar-git-')); const root = join(workspace, 'repo'); await mkdir(root)
    const policy = new GitPathPolicy(async (userId, id) => userId === 'user-a' && id === 'project-a' ? project(root) : null, workspace)
    const timeout: GitExecutor = async () => { throw new GitExecutionError('timeout') }
    const output: GitExecutor = async () => { throw new GitExecutionError('output') }
    await expect(new GitReadService(policy, timeout).discover('user-a', 'project-a')).rejects.toMatchObject({ code: 'GIT_TIMEOUT' })
    await expect(new GitReadService(policy, output).discover('user-a', 'project-a')).rejects.toMatchObject({ code: 'GIT_OUTPUT_LIMIT' })
  })

  it('requires policy approval and sends mutation paths as fixed argv', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'subpolar-git-')); const root = join(workspace, 'repo'); await mkdir(root)
    const calls: string[][] = []
    const run: GitExecutor = async (args) => {
      calls.push([...args])
      if (args[0] === 'rev-parse' && args[1] === '--git-dir') return { stdout: '.git\nfalse\n', stderr: '', code: 0 }
      if (args[0] === 'rev-parse') return { stdout: 'abc123\n', stderr: '', code: 0 }
      if (args[0] === 'status') return { stdout: '## main\0 M safe.txt\0', stderr: '', code: 0 }
      return { stdout: '', stderr: '', code: 0 }
    }
    const lookup = async (userId: string, id: string) => userId === 'user-a' && id === 'project-a' ? project(root) : null
    const denied = new GitMutationService(new GitPathPolicy(lookup, workspace, { allowMutations: true, approvalToken: 'ok' }), run)
    await expect(denied.stage('user-a', 'project-a', ['safe.txt'])).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' })
    await expect(denied.stage('user-a', 'project-a', ['--output=x'], { token: 'ok' })).rejects.toMatchObject({ code: 'PATH_DENIED' })
    await denied.stage('user-a', 'project-a', ['safe.txt'], { token: 'ok' })
    expect(calls).toContainEqual(['add', '--', 'safe.txt'])
    expect(calls.every((args) => args.every((arg) => !arg.includes('&&')))).toBe(true)
  })

  it('runs normal commit hooks and keeps the message as one argv value', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'subpolar-git-')); const root = join(workspace, 'repo'); await mkdir(root)
    const calls: string[][] = []
    const run: GitExecutor = async (args) => {
      calls.push([...args])
      if (args[0] === 'rev-parse' && args[1] === '--git-dir') return { stdout: '.git\nfalse\n', stderr: '', code: 0 }
      if (args[0] === 'rev-parse') return { stdout: 'abc123\n', stderr: '', code: 0 }
      if (args[0] === 'status') return { stdout: '## main\0', stderr: '', code: 0 }
      return { stdout: '', stderr: '', code: 0 }
    }
    const policy = new GitPathPolicy(async () => project(root), workspace, { allowMutations: true, approvalToken: 'ok' })
    await new GitMutationService(policy, run).commit('user-a', 'project-a', 'message; $(touch nope)', { token: 'ok' })
    expect(calls).toContainEqual(['commit', '-m', 'message; $(touch nope)'])
    expect(calls.flat()).not.toContain('--no-verify')
  })

  it('detects checkpoint conflicts and does not remove untracked files', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'subpolar-git-')); const root = join(workspace, 'repo'); await mkdir(root)
    const run: GitExecutor = async (args) => {
      if (args[0] === 'rev-parse' && args[1] === '--git-dir') return { stdout: '.git\nfalse\n', stderr: '', code: 0 }
      if (args[0] === 'rev-parse') return { stdout: 'abc123\n', stderr: '', code: 0 }
      if (args[0] === 'status') return { stdout: '## main\0?? local.txt\0', stderr: '', code: 0 }
      return { stdout: '', stderr: '', code: 0 }
    }
    const policy = new GitPathPolicy(async () => project(root), workspace, { allowMutations: true, approvalToken: 'ok' })
    const service = new GitMutationService(policy, run)
    await expect(service.restoreCheckpoint('user-a', 'project-a', { version: 1, id: 'x', head: 'abc123', branch: 'main', stash: null, untracked: [] }, { token: 'ok' }, { expectedHead: 'different' })).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(service.restoreCheckpoint('user-a', 'project-a', { version: 1, id: 'x', head: 'abc123', branch: 'main', stash: null, untracked: [] }, { token: 'ok' })).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('maps stash apply failures to bounded Git conflicts', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'subpolar-git-')); const root = join(workspace, 'repo'); await mkdir(root)
    const detail = 'x'.repeat(2000)
    const run: GitExecutor = async (args) => {
      if (args[0] === 'rev-parse' && args[1] === '--git-dir') return { stdout: '.git\nfalse\n', stderr: '', code: 0 }
      if (args[0] === 'rev-parse') return { stdout: 'abc123\n', stderr: '', code: 0 }
      if (args[0] === 'status') return { stdout: '## main\0', stderr: '', code: 0 }
      if (args[0] === 'stash' && args[1] === 'apply') return { stdout: '', stderr: detail, code: 1 }
      throw new Error('unexpected command')
    }
    const policy = new GitPathPolicy(async () => project(root), workspace, { allowMutations: true, approvalToken: 'ok' })
    const service = new GitMutationService(policy, run)
    await expect(service.restoreCheckpoint('user-a', 'project-a', { version: 1, id: 'x', head: 'abc123', branch: 'main', stash: 'abcdef1', untracked: [] }, { token: 'ok' })).rejects.toMatchObject({ code: 'GIT_CONFLICT', message: expect.stringMatching(/^Git checkpoint conflict: x{512}$/) })
  })

  it('fails closed for approved untracked deletion until descriptor-relative operations exist', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'subpolar-git-')); const root = join(workspace, 'repo'); await mkdir(root); await mkdir(join(root, '.git')); await writeFile(join(root, 'local.txt'), 'local')
    const run: GitExecutor = async (args) => {
      if (args[0] === 'rev-parse' && args[1] === '--git-dir') return { stdout: '.git\nfalse\n', stderr: '', code: 0 }
      if (args[0] === 'rev-parse') return { stdout: 'abc123\n', stderr: '', code: 0 }
      if (args[0] === 'status') return { stdout: '## main\0?? local.txt\0', stderr: '', code: 0 }
      throw new Error('unexpected command')
    }
    const policy = new GitPathPolicy(async () => project(root), workspace, { allowMutations: true, approvalToken: 'ok' })
    const service = new GitMutationService(policy, run)
    await expect(service.restoreCheckpoint('user-a', 'project-a', { version: 1, id: 'x', head: 'abc123', branch: 'main', stash: null, untracked: ['local.txt'] }, { token: 'ok' }, { deleteUntracked: true })).rejects.toMatchObject({ code: 'UNSUPPORTED' })
    await expect(access(join(root, 'local.txt'))).resolves.toBeNull()
  })

  it('rejects checkpoint entries whose parent is replaced by a symlink', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'subpolar-git-')); const root = join(workspace, 'repo'); const outside = join(workspace, 'outside'); await mkdir(root); await mkdir(outside); await writeFile(join(outside, 'file.txt'), 'outside'); await symlink(outside, join(root, 'nested'))
    const run: GitExecutor = async (args) => {
      if (args[0] === 'rev-parse' && args[1] === '--git-dir') return { stdout: '.git\nfalse\n', stderr: '', code: 0 }
      if (args[0] === 'rev-parse') return { stdout: 'abc123\n', stderr: '', code: 0 }
      if (args[0] === 'status') return { stdout: '## main\0', stderr: '', code: 0 }
      throw new Error('unexpected command')
    }
    const policy = new GitPathPolicy(async () => project(root), workspace, { allowMutations: true, approvalToken: 'ok' })
    await expect(new GitMutationService(policy, run).restoreCheckpoint('user-a', 'project-a', { version: 1, id: 'x', head: 'abc123', branch: 'main', stash: null, untracked: ['nested/file.txt'] }, { token: 'ok' }, { deleteUntracked: true })).rejects.toMatchObject({ code: 'PATH_DENIED' })
    await expect(readFile(join(outside, 'file.txt'), 'utf8')).resolves.toBe('outside')
  })

  it('restores all staged files when a later checkpoint operation fails', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'subpolar-git-')); const root = join(workspace, 'repo'); await mkdir(root); await mkdir(join(root, '.git')); await writeFile(join(root, 'first.txt'), 'first'); await writeFile(join(root, 'second.txt'), 'second')
    const run: GitExecutor = async (args) => {
      if (args[0] === 'rev-parse' && args[1] === '--git-dir') return { stdout: '.git\nfalse\n', stderr: '', code: 0 }
      if (args[0] === 'rev-parse') return { stdout: 'abc123\n', stderr: '', code: 0 }
      if (args[0] === 'status') return { stdout: '## main\0?? first.txt\0?? second.txt\0', stderr: '', code: 0 }
      if (args[0] === 'stash' && args[1] === 'apply') return { stdout: '', stderr: 'conflict', code: 1 }
      throw new Error('unexpected command')
    }
    const policy = new GitPathPolicy(async () => project(root), workspace, { allowMutations: true, approvalToken: 'ok' })
    await expect(new GitMutationService(policy, run).restoreCheckpoint('user-a', 'project-a', { version: 1, id: 'x', head: 'abc123', branch: 'main', stash: 'abcdef1', untracked: ['first.txt', 'second.txt'] }, { token: 'ok' }, { deleteUntracked: true })).rejects.toMatchObject({ code: 'UNSUPPORTED' })
    await expect(readFile(join(root, 'first.txt'), 'utf8')).resolves.toBe('first')
    await expect(readFile(join(root, 'second.txt'), 'utf8')).resolves.toBe('second')
  })

  it('rejects approved deletion outside the checkpoint scope', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'subpolar-git-')); const root = join(workspace, 'repo'); await mkdir(root); await writeFile(join(root, 'local.txt'), 'local')
    const run: GitExecutor = async (args) => {
      if (args[0] === 'rev-parse' && args[1] === '--git-dir') return { stdout: '.git\nfalse\n', stderr: '', code: 0 }
      if (args[0] === 'rev-parse') return { stdout: 'abc123\n', stderr: '', code: 0 }
      if (args[0] === 'status') return { stdout: '## main\0?? local.txt\0', stderr: '', code: 0 }
      throw new Error('unexpected command')
    }
    const policy = new GitPathPolicy(async () => project(root), workspace, { allowMutations: true, approvalToken: 'ok' })
    const service = new GitMutationService(policy, run)
    await expect(service.restoreCheckpoint('user-a', 'project-a', { version: 1, id: 'x', head: 'abc123', branch: 'main', stash: null, untracked: [] }, { token: 'ok' }, { deleteUntracked: true })).rejects.toMatchObject({ code: 'UNSUPPORTED' })
    await expect(access(join(root, 'local.txt'))).resolves.toBeNull()
  })
})
