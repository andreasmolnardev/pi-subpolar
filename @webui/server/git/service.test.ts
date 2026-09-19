import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ProjectRecord } from '../project-store.ts'
import { GitServiceError } from './contracts.ts'
import { GitPathPolicy } from './policy.ts'
import { GitExecutionError, type GitExecutor } from './executor.ts'
import { GitReadService } from './service.ts'

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
})
