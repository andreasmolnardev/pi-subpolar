import { afterEach, describe, expect, it, vi } from 'vitest'
import * as gitExecutor from '../git/executor.ts'
import * as filesystem from 'node:fs/promises'
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, chmod, realpath } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionWorkspaceService } from '../application/session-workspace.ts'
import { handleSessionsRoute } from '../routes/sessions.ts'


const temporary: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()

  await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true })))
})
async function fixture(git = true, publishIndex?: typeof filesystem.rename, persistState?: typeof filesystem.rename) {
  const temp = await mkdtemp(join(tmpdir(), 'session-review-')); temporary.push(temp)
  const repository = join(temp, 'repo'), storage = join(temp, 'state')
  await mkdir(repository)
  const root = await realpath(repository)
  const run = (...args: string[]) => execFileSync('/usr/bin/git', args, { cwd: root, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } }).toString().trim()
  if (git) {
    run('init', '-q'); run('config', 'user.name', 'Test'); run('config', 'user.email', 'test@example.test')
    await writeFile(join(root, 'a.txt'), 'a original\n')
    await writeFile(join(root, 'b.txt'), 'b original\n')
    await writeFile(join(root, 'index.txt'), 'index original\n')
    run('add', '.'); run('commit', '-qm', 'initial')
  }
  let service = new SessionWorkspaceService(storage, publishIndex, persistState)
  const request = (method: string, endpoint = '', input: Record<string, unknown> = {}, path: string | null = null) => service.request('owner', 'session', root, method, endpoint ? endpoint.split('/') : [], path, input) as Promise<any>
  const group = async (name: string) => {
    const result = await request('POST', 'groups', { name })
    await request('PATCH', `groups/${result.id}`, { message: `commit ${name}` })
    return result.id as string
  }
  return { root, storage, run, request, group, reload: () => { service = new SessionWorkspaceService(storage, publishIndex, persistState) } }
}

async function simulateUnpublishedCommit(f: Awaited<ReturnType<typeof fixture>>, groupId: string) {
  const statePath = join(f.storage, `${createHash('sha256').update(JSON.stringify(['owner', 'session'])).digest('hex')}.json`)
  const state = JSON.parse(await readFile(statePath, 'utf8'))
  const parent = f.run('rev-parse', 'HEAD')
  const index = join(f.root, '.git', 'index')
  const originalIndex = await readFile(index)
  f.run('add', 'a.txt')
  f.run('commit', '-qm', 'published before simulated process crash')
  const commit = f.run('rev-parse', 'HEAD')
  const preparedIndex = await readFile(index)
  await writeFile(index, originalIndex)
  const indexDigest = createHash('sha256').update(preparedIndex).digest('hex')
  state.pendingCommit = { groupId, commit, parent, indexDigest }
  await writeFile(statePath, JSON.stringify(state))
  const lock = `${index}.lock`
  await writeFile(lock, preparedIndex, { flag: 'wx' })
  return { commit, index, lock, preparedIndex, originalIndex, statePath }
}

describe('session workspace review in real repositories', { timeout: 20_000 }, () => {
  it('reports worktree totals, untracked files, and the exact GET contracts', async () => {
    const f = await fixture()
    await writeFile(join(f.root, 'a.txt'), 'replacement\nsecond\n')
    await writeFile(join(f.root, 'new.txt'), 'new\n')
    const workspace = await f.request('GET')
    expect(Object.keys(workspace).sort()).toEqual(['additions', 'branch', 'deletions', 'files', 'groups', 'isGit'])
    expect(workspace.isGit).toBe(true)
    expect(workspace.files).toEqual([
      { path: 'a.txt', status: 'modified', additions: 2, deletions: 1 },
      { path: 'new.txt', status: 'added', additions: 1, deletions: 0 },
    ])
    expect(workspace.additions).toBe(3); expect(workspace.deletions).toBe(1)
    expect((await f.request('GET', 'diff', {}, 'new.txt')).text).toContain('+new\n')
    expect(await f.request('GET', 'file', {}, 'new.txt')).toEqual({ content: 'new\n' })
    expect((await f.request('GET', 'files', {}, '')).entries).toContainEqual({ name: 'new.txt', path: 'new.txt', directory: false })
  })

  it('commits only selected snapshots, survives restart, and preserves unrelated index entries', async () => {
    const f = await fixture()
    await writeFile(join(f.root, 'index.txt'), 'preexisting staged\n'); f.run('add', 'index.txt')
    const unrelatedEntries = f.run('ls-files', '--stage', '--', 'index.txt', 'b.txt')
    const stagedIndexEntry = f.run('ls-files', '--stage', '--', 'index.txt')
    const a = await f.group('A'), b = await f.group('B')
    await writeFile(join(f.root, 'a.txt'), 'A staged snapshot\n')
    await writeFile(join(f.root, 'b.txt'), 'B staged snapshot\n')
    await writeFile(join(f.root, 'new.txt'), 'untracked snapshot\n')
    await f.request('POST', 'stage', { path: 'a.txt', groupId: a })
    await f.request('POST', 'stage', { path: 'new.txt', groupId: a })
    await f.request('POST', 'stage', { path: 'b.txt', groupId: b })
    await writeFile(join(f.root, 'a.txt'), 'edited AFTER staging\n')
    f.reload()
    const commit = await f.request('POST', 'commit', { groupId: a })
    expect(commit.commit).toMatch(/^[a-f0-9]{40,64}$/)
    expect(f.run('show', 'HEAD:a.txt')).toBe('A staged snapshot')
    expect(f.run('show', 'HEAD:new.txt')).toBe('untracked snapshot')
    expect(f.run('show', 'HEAD:b.txt')).toBe('b original')
    expect(f.run('show', 'HEAD:index.txt')).toBe('index original')
    expect(f.run('ls-files', '--stage', '--', 'index.txt', 'b.txt')).toBe(unrelatedEntries)
    expect(f.run('show', ':a.txt')).toBe('A staged snapshot')
    expect(f.run('show', ':new.txt')).toBe('untracked snapshot')
    expect(f.run('diff', '--cached', '--name-only')).toBe('index.txt')
    const status = execFileSync('/usr/bin/git', ['status', '--porcelain'], { cwd: f.root }).toString()
    expect(status).toContain(' M a.txt\n')
    expect(status).toContain(' M b.txt\n')
    expect(status).toContain('M  index.txt\n')
    expect(await readFile(join(f.root, 'a.txt'), 'utf8')).toBe('edited AFTER staging\n')
    expect(commit.groups.find((g: any) => g.id === b).paths).toEqual(['b.txt'])
    await f.request('POST', 'commit', { groupId: b })
    expect(f.run('show', 'HEAD:b.txt')).toBe('B staged snapshot')
    expect(f.run('ls-files', '--stage', '--', 'index.txt')).toBe(stagedIndexEntry)
    expect(f.run('diff', '--cached', '--name-only')).toBe('index.txt')
  })

  it('leaves git status clean after an ordinary group commit', async () => {
    const f = await fixture(), id = await f.group('ordinary')
    await writeFile(join(f.root, 'a.txt'), 'committed\n')
    await writeFile(join(f.root, 'new.txt'), 'new committed\n')
    await f.request('POST', 'stage', { path: 'a.txt', groupId: id })
    await f.request('POST', 'stage', { path: 'new.txt', groupId: id })
    await f.request('POST', 'commit', { groupId: id })
    expect(f.run('status', '--porcelain')).toBe('')
    expect((await f.request('GET')).files).toEqual([])
  })

  it('preserves preexisting staged content on selected paths while committing the group snapshot', async () => {
    const f = await fixture(), id = await f.group('selected')
    await writeFile(join(f.root, 'a.txt'), 'preexisting staged version\n'); f.run('add', 'a.txt')
    const stagedEntry = f.run('ls-files', '--stage', '--', 'a.txt')
    await writeFile(join(f.root, 'a.txt'), 'selected snapshot\n')
    await f.request('POST', 'stage', { path: 'a.txt', groupId: id })
    await f.request('POST', 'commit', { groupId: id })
    expect(f.run('show', 'HEAD:a.txt')).toBe('selected snapshot')
    expect(f.run('show', ':a.txt')).toBe('preexisting staged version')
    expect(f.run('ls-files', '--stage', '--', 'a.txt')).toBe(stagedEntry)
    // The real staged diff remains intentional, but HEAD and the worktree match.
    const workspace = await f.request('GET')
    expect(workspace.files).toEqual([])
    expect(workspace.additions).toBe(0); expect(workspace.deletions).toBe(0)
    expect(await f.request('GET', 'diff', {}, 'a.txt')).toEqual({ text: '' })
  })

  it('preserves staged additions, deletions, executable-mode edits and intent-to-add on selected paths', async () => {
    const f = await fixture(), id = await f.group('staged entries')
    f.run('rm', '--cached', 'a.txt')
    await chmod(join(f.root, 'b.txt'), 0o755); f.run('add', 'b.txt')
    await writeFile(join(f.root, 'new.txt'), 'preexisting addition\n'); f.run('add', 'new.txt')
    await writeFile(join(f.root, 'intent.txt'), 'intent\n'); f.run('add', '-N', 'intent.txt')
    const selectedEntries = f.run('ls-files', '--stage', '--', 'a.txt', 'b.txt', 'new.txt', 'intent.txt')
    const intentFlags = f.run('ls-files', '--debug', '--', 'intent.txt')
    await writeFile(join(f.root, 'a.txt'), 'selected A\n')
    await chmod(join(f.root, 'b.txt'), 0o644); await writeFile(join(f.root, 'b.txt'), 'selected B\n')
    await writeFile(join(f.root, 'new.txt'), 'selected addition\n')
    for (const path of ['a.txt', 'b.txt', 'new.txt', 'intent.txt']) await f.request('POST', 'stage', { path, groupId: id })
    await f.request('POST', 'commit', { groupId: id })
    expect(f.run('ls-files', '--stage', '--', 'a.txt', 'b.txt', 'new.txt', 'intent.txt')).toBe(selectedEntries)
    expect(f.run('ls-files', '--debug', '--', 'intent.txt')).toBe(intentFlags)
    expect(f.run('show', 'HEAD:a.txt')).toBe('selected A')
    expect(f.run('ls-tree', 'HEAD', 'b.txt')).toMatch(/^100644 blob/)
    expect(f.run('show', 'HEAD:new.txt')).toBe('selected addition')
    expect(f.run('show', ':new.txt')).toBe('preexisting addition')
    expect((await f.request('GET')).files).toEqual([])
  })

  it('handles deleted files and executable snapshots', async () => {
    const f = await fixture(), id = await f.group('deletion')
    await rm(join(f.root, 'a.txt'))
    await writeFile(join(f.root, 'run.sh'), '#!/bin/sh\nexit 0\n'); await chmod(join(f.root, 'run.sh'), 0o755)
    await f.request('POST', 'stage', { path: 'a.txt', groupId: id })
    await f.request('POST', 'stage', { path: 'run.sh', groupId: id })
    await f.request('POST', 'commit', { groupId: id })
    expect(f.run('ls-tree', 'HEAD', 'a.txt')).toBe('')
    expect(f.run('ls-tree', 'HEAD', 'run.sh')).toMatch(/^100755 blob/)
    expect(f.run('status', '--porcelain')).toBe('')
  })

  it('commits groups in an unborn repository and creates a matching index', async () => {
    const f = await fixture(false)
    f.run('init', '-q'); f.run('config', 'user.name', 'Test'); f.run('config', 'user.email', 'test@example.test')
    await writeFile(join(f.root, 'new.txt'), 'first\n')
    const id = await f.group('first')
    await f.request('POST', 'stage', { path: 'new.txt', groupId: id })
    await f.request('POST', 'commit', { groupId: id })
    expect(f.run('show', 'HEAD:new.txt')).toBe('first')
    expect(f.run('show', ':new.txt')).toBe('first')
    expect(f.run('status', '--porcelain')).toBe('')
  })

  it('rejects stale snapshots after an external commit and leaves the index intact', async () => {
    const f = await fixture(), id = await f.group('stale')
    await writeFile(join(f.root, 'a.txt'), 'snapshot\n')
    await f.request('POST', 'stage', { path: 'a.txt', groupId: id })
    await writeFile(join(f.root, 'a.txt'), 'external commit\n'); f.run('add', 'a.txt'); f.run('commit', '-qm', 'external')
    const index = await readFile(join(f.root, '.git', 'index')), head = f.run('rev-parse', 'HEAD')
    await expect(f.request('POST', 'commit', { groupId: id })).rejects.toMatchObject({ status: 409, code: 'SNAPSHOT_CONFLICT' })
    expect(f.run('rev-parse', 'HEAD')).toBe(head)
    expect(await readFile(join(f.root, '.git', 'index'))).toEqual(index)
    expect((await f.request('GET')).groups[0].paths).toEqual(['a.txt'])
  })

  it('preserves snapshots/index on an empty commit failure', async () => {
    const f = await fixture(), id = await f.group('empty')
    await f.request('POST', 'stage', { path: 'a.txt', groupId: id })
    const index = await readFile(join(f.root, '.git', 'index'))
    await expect(f.request('POST', 'commit', { groupId: id })).rejects.toMatchObject({ code: 'EMPTY_GROUP' })
    expect(await readFile(join(f.root, '.git', 'index'))).toEqual(index)
    expect((await f.request('GET')).groups[0].paths).toEqual(['a.txt'])
  })

  it('does not count index-only additions or staged deletions restored in the worktree', async () => {
    const f = await fixture()
    await writeFile(join(f.root, 'index-only.txt'), 'staged addition\n'); f.run('add', 'index-only.txt')
    await rm(join(f.root, 'index-only.txt'))
    f.run('rm', '--cached', 'a.txt')
    const workspace = await f.request('GET')
    expect(workspace.files).toEqual([])
    expect(workspace.additions).toBe(0); expect(workspace.deletions).toBe(0)
    expect(await f.request('GET', 'diff', {}, 'a.txt')).toEqual({ text: '' })
    await expect(f.request('GET', 'diff', {}, 'index-only.txt')).rejects.toMatchObject({ status: 404 })
    await writeFile(join(f.root, 'a.txt'), 'real worktree change\nsecond line\n')
    const changed = await f.request('GET')
    expect(changed.files).toEqual([{ path: 'a.txt', status: 'modified', additions: 2, deletions: 1 }])
    expect((await f.request('GET', 'diff', {}, 'a.txt')).text).toContain('+real worktree change')
  })

  it('preserves an existing index.lock and rejects the commit without moving HEAD', async () => {
    const f = await fixture(), id = await f.group('locked')
    await writeFile(join(f.root, 'a.txt'), 'snapshot\n')
    await f.request('POST', 'stage', { path: 'a.txt', groupId: id })
    const head = f.run('rev-parse', 'HEAD'), index = await readFile(join(f.root, '.git', 'index'))
    const lock = join(f.root, '.git', 'index.lock')
    await writeFile(lock, 'other Git operation')
    await expect(f.request('POST', 'commit', { groupId: id })).rejects.toMatchObject({ status: 409, code: 'INDEX_BUSY' })
    expect(await readFile(lock, 'utf8')).toBe('other Git operation')
    expect(f.run('rev-parse', 'HEAD')).toBe(head)
    expect(await readFile(join(f.root, '.git', 'index'))).toEqual(index)
    expect((await f.request('GET')).groups[0].paths).toEqual(['a.txt'])
    await rm(lock)
    await f.request('POST', 'commit', { groupId: id })
    expect(f.run('status', '--porcelain')).toBe('')
  })

  it('preserves index changes made by external Git before acquiring the index lock', async () => {
    const f = await fixture(), id = await f.group('concurrent')
    await writeFile(join(f.root, 'a.txt'), 'group snapshot\n')
    await f.request('POST', 'stage', { path: 'a.txt', groupId: id })
    const execute = gitExecutor.executeGit
    let stagedEntry = ''
    vi.spyOn(gitExecutor, 'executeGit').mockImplementation(async (args, options) => {
      const result = await execute(args, options)
      if (args.includes('commit-tree')) {
        await writeFile(join(f.root, 'a.txt'), 'externally staged during commit\n')
        f.run('add', 'a.txt')
        stagedEntry = f.run('ls-files', '--stage', '--', 'a.txt')
      }
      return result
    })
    await f.request('POST', 'commit', { groupId: id })
    expect(f.run('show', 'HEAD:a.txt')).toBe('group snapshot')
    expect(f.run('ls-files', '--stage', '--', 'a.txt')).toBe(stagedEntry)
    expect(f.run('show', ':a.txt')).toBe('externally staged during commit')
  })

  it('holds index.lock through HEAD publication and never removes a subsequent writer lock', async () => {
    const f = await fixture(true, async (source, destination) => {
      await filesystem.rename(source, destination)
      await writeFile(source, 'next writer')
    }), id = await f.group('locking')
    await writeFile(join(f.root, 'a.txt'), 'snapshot\n')
    await f.request('POST', 'stage', { path: 'a.txt', groupId: id })
    const execute = gitExecutor.executeGit
    const index = join(f.root, '.git', 'index'), lock = `${index}.lock`
    let checked = false
    vi.spyOn(gitExecutor, 'executeGit').mockImplementation(async (args, options) => {
      if (args.includes('update-ref')) {
        expect(await readFile(lock)).not.toHaveLength(0)
        expect(() => f.run('add', 'a.txt')).toThrow()
        checked = true
      }
      return execute(args, options)
    })

    await f.request('POST', 'commit', { groupId: id })
    expect(checked).toBe(true)

    expect(await readFile(lock, 'utf8')).toBe('next writer')
    await rm(lock)
    expect(f.run('status', '--porcelain')).toBe('')
  })

  it('restores HEAD and retains snapshots if publishing the reconciled index fails', async () => {
    const f = await fixture(true, async () => { throw Object.assign(new Error('injected rename failure'), { code: 'EIO' }) }), id = await f.group('publication failure')
    await writeFile(join(f.root, 'a.txt'), 'snapshot\n')
    await f.request('POST', 'stage', { path: 'a.txt', groupId: id })
    const index = join(f.root, '.git', 'index'), original = await readFile(index), head = f.run('rev-parse', 'HEAD')

    await expect(f.request('POST', 'commit', { groupId: id })).rejects.toMatchObject({ status: 500, code: 'INDEX_PUBLISH_FAILED' })
    expect(f.run('rev-parse', 'HEAD')).toBe(head)
    expect(await readFile(index)).toEqual(original)
    await expect(readFile(`${index}.lock`)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await f.request('GET')).groups[0].paths).toEqual(['a.txt'])
  })

  it('recovers an exact prepared index lock after a crash between ref and index publication', async () => {
    const f = await fixture(), id = await f.group('crash recovery')
    await writeFile(join(f.root, 'a.txt'), 'snapshot\n')
    await f.request('POST', 'stage', { path: 'a.txt', groupId: id })
    const crash = await simulateUnpublishedCommit(f, id)

    const retry = await f.request('POST', 'commit', { groupId: id })
    expect(retry).toMatchObject({ commit: crash.commit })
    expect(await readFile(crash.index)).toEqual(crash.preparedIndex)
    await expect(readFile(crash.lock)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await f.request('GET')).groups.find((group: any) => group.id === id).paths).toEqual([])
  })

  it('fails closed and preserves a mismatched index lock during pending-commit recovery', async () => {
    const f = await fixture(), id = await f.group('foreign index lock')
    await writeFile(join(f.root, 'a.txt'), 'snapshot\n')
    await f.request('POST', 'stage', { path: 'a.txt', groupId: id })
    const crash = await simulateUnpublishedCommit(f, id)
    const foreignLock = Buffer.from('another Git writer lock')
    await writeFile(crash.lock, foreignLock)

    await expect(f.request('POST', 'commit', { groupId: id })).rejects.toMatchObject({ status: 500, code: 'COMMIT_RECOVERY_REQUIRED' })
    expect(await readFile(crash.lock)).toEqual(foreignLock)
    expect(await readFile(crash.index)).toEqual(crash.originalIndex)
    const state = JSON.parse(await readFile(crash.statePath, 'utf8'))
    expect(state.pendingCommit).toMatchObject({ commit: crash.commit, groupId: id })
    expect(state.groups.find((group: any) => group.id === id).snapshots).toHaveProperty('a.txt')
  })

  it('returns the published commit and recovers cleared snapshots after persistence failure', async () => {
    let originalHead = ''
    let failed = false
    const rename = filesystem.rename
    const f = await fixture(true, undefined, async (source, destination) => {
      if (!failed && String(destination).endsWith('.json') && f.run('rev-parse', 'HEAD') !== originalHead) {
        failed = true
        throw Object.assign(new Error('injected workspace save failure'), { code: 'EIO' })
      }
      return rename(source, destination)
    })
    originalHead = f.run('rev-parse', 'HEAD')
    const id = await f.group('recover persisted state')
    await writeFile(join(f.root, 'a.txt'), 'snapshot\n')
    await f.request('POST', 'stage', { path: 'a.txt', groupId: id })

    const result = await f.request('POST', 'commit', { groupId: id })
    expect(failed).toBe(true)
    expect(result.commit).toMatch(/^[a-f0-9]{40,64}$/)
    expect(result.recoveryPending).toBe(true)
    expect(f.run('rev-parse', 'HEAD')).toBe(result.commit)

    // A retry first resolves the durable journal and returns the already-published commit.
    expect(await f.request('POST', 'commit', { groupId: id })).toMatchObject({ commit: result.commit })
    expect((await f.request('GET')).groups.find((group: any) => group.id === id).paths).toEqual([])
  })

  it('fails closed if a writer replaces the real index while ignoring index.lock', async () => {
    const f = await fixture(), id = await f.group('index conflict')
    await writeFile(join(f.root, 'a.txt'), 'snapshot\n')
    await f.request('POST', 'stage', { path: 'a.txt', groupId: id })
    const realIndex = join(f.root, '.git', 'index'), alternate = join(f.storage, 'external-index')
    await writeFile(alternate, await readFile(realIndex))
    await writeFile(join(f.root, 'index.txt'), 'external staging\n')
    execFileSync('/usr/bin/git', ['add', 'index.txt'], { cwd: f.root, env: { ...process.env, GIT_INDEX_FILE: alternate } })
    const externalIndex = await readFile(alternate), head = f.run('rev-parse', 'HEAD')
    const execute = gitExecutor.executeGit
    vi.spyOn(gitExecutor, 'executeGit').mockImplementation(async (args, options) => {
      const result = await execute(args, options)
      if (args.includes('--no-split-index')) await writeFile(realIndex, externalIndex)
      return result
    })
    await expect(f.request('POST', 'commit', { groupId: id })).rejects.toMatchObject({ status: 409, code: 'INDEX_CONFLICT' })
    expect(f.run('rev-parse', 'HEAD')).toBe(head)
    expect(await readFile(realIndex)).toEqual(externalIndex)
    await expect(readFile(`${realIndex}.lock`)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await f.request('GET')).groups[0].paths).toEqual(['a.txt'])
  })

  it('reconciles a split index without losing unrelated staged entries', async () => {
    const f = await fixture(), id = await f.group('split index')
    await writeFile(join(f.root, 'index.txt'), 'staged unrelated\n'); f.run('add', 'index.txt')
    f.run('update-index', '--split-index')
    const unrelated = f.run('ls-files', '--stage', '--', 'index.txt', 'b.txt')
    await writeFile(join(f.root, 'a.txt'), 'snapshot\n')
    await f.request('POST', 'stage', { path: 'a.txt', groupId: id })
    await f.request('POST', 'commit', { groupId: id })
    expect(f.run('ls-files', '--stage', '--', 'index.txt', 'b.txt')).toBe(unrelated)
    expect(f.run('diff', '--cached', '--name-only')).toBe('index.txt')
  })

  it('moves a path between groups and unstages without changing the Git index', async () => {
    const f = await fixture(), a = await f.group('A'), b = await f.group('B')
    await f.request('POST', 'stage', { path: 'a.txt', groupId: a })
    await f.request('POST', 'stage', { path: 'a.txt', groupId: b })
    const groups = (await f.request('GET')).groups
    expect(groups.find((g: any) => g.id === a).paths).toEqual([])
    expect(groups.find((g: any) => g.id === b).paths).toEqual(['a.txt'])
    await f.request('POST', 'unstage', { path: 'a.txt' })
    expect((await f.request('GET')).groups.every((g: any) => !g.paths.length)).toBe(true)
  })

  it('serializes concurrent group mutations even across service instances', async () => {
    const f = await fixture(), other = new SessionWorkspaceService(f.storage)
    await Promise.all(Array.from({ length: 12 }, (_, i) => i % 2
      ? f.request('POST', 'groups', { name: `group ${i}` })
      : other.request('owner', 'session', f.root, 'POST', ['groups'], null, { name: `group ${i}` })))
    expect((await f.request('GET')).groups).toHaveLength(12)
  })

  it('enforces optimistic file editing, including concurrent requests', async () => {
    const f = await fixture()
    const results = await Promise.allSettled([
      f.request('PUT', 'file', { path: 'a.txt', content: 'one\n', expectedContent: 'a original\n' }),
      f.request('PUT', 'file', { path: 'a.txt', content: 'two\n', expectedContent: 'a original\n' }),
    ])
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.find(r => r.status === 'rejected')).toMatchObject({ reason: { status: 409, code: 'CONTENT_CONFLICT' } })
    await expect(f.request('PUT', 'file', { path: 'a.txt', content: 'bad' })).rejects.toMatchObject({ status: 400 })
  })

  it('denies traversal, secrets, and both final and parent symlinks', async () => {
    const f = await fixture(), id = await f.group('unsafe')
    const outside = join(f.root, '..', 'outside'); await mkdir(outside)
    await writeFile(join(outside, 'secret.txt'), 'outside\n')
    await symlink(outside, join(f.root, 'link-dir'))
    await symlink(join(outside, 'secret.txt'), join(f.root, 'link.txt'))
    await symlink(join(f.root, 'a.txt'), join(f.root, 'inside-link.txt'))
    await writeFile(join(f.root, '.env'), 'SECRET=value\n')
    for (const path of ['../outside/secret.txt', '/etc/passwd', '.git/config', '.env', 'link.txt', 'inside-link.txt', 'link-dir/secret.txt', 'link-dir/missing.txt', 'keys/private.pem']) {
      await expect(f.request('GET', 'file', {}, path)).rejects.toMatchObject({ code: 'PATH_DENIED' })
      await expect(f.request('POST', 'stage', { path, groupId: id })).rejects.toMatchObject({ code: 'PATH_DENIED' })
    }
    expect((await f.request('GET')).files.some((file: any) => file.path.includes('link') || file.path === '.env')).toBe(false)
    expect((await f.request('GET', 'files', {}, '')).entries.some((file: any) => file.path.includes('link') || file.path === '.env' || file.path === '.git')).toBe(false)
  })

  it('treats Git pathspec metacharacters literally and never includes secret files in a requested diff', async () => {
    const f = await fixture()
    await writeFile(join(f.root, '*.txt'), 'literal original\n')
    await writeFile(join(f.root, 'token.txt'), 'sensitive original\n')
    f.run('add', '.'); f.run('commit', '-qm', 'special names')
    await writeFile(join(f.root, '*.txt'), 'literal changed\n')
    await writeFile(join(f.root, 'token.txt'), 'sensitive changed\n')
    const diff = await f.request('GET', 'diff', {}, '*.txt')
    expect(diff.text).toContain('+literal changed')
    expect(diff.text).not.toContain('sensitive')
    await expect(f.request('GET', 'diff', {}, 'token.txt')).rejects.toMatchObject({ code: 'PATH_DENIED' })
  })

  it('commits a binary snapshot without corrupting bytes', async () => {
    const f = await fixture(), id = await f.group('binary')
    const original = Buffer.from([0, 255, 254, 1])
    await writeFile(join(f.root, 'binary.dat'), original)
    f.run('add', 'binary.dat'); f.run('commit', '-qm', 'binary original')
    const snapshot = Buffer.from([0, 253, 128, 1])
    await writeFile(join(f.root, 'binary.dat'), snapshot)
    expect(await f.request('GET', 'diff', {}, 'binary.dat')).toEqual({ text: '', binary: true })
    await f.request('POST', 'stage', { path: 'binary.dat', groupId: id })
    await f.request('POST', 'commit', { groupId: id })
    expect(execFileSync('/usr/bin/git', ['show', 'HEAD:binary.dat'], { cwd: f.root })).toEqual(snapshot)
  })

  it('supports a linked worktree using its stored root without changing the primary branch', async () => {
    const f = await fixture(), worktree = join(f.root, '..', 'linked')
    f.run('worktree', 'add', '-qb', 'review', worktree)
    const primaryHead = f.run('rev-parse', 'HEAD')
    const service = new SessionWorkspaceService(f.storage)
    const request = (method: string, endpoint: string[], input = {}) => service.request('owner', 'linked-session', worktree, method, endpoint, null, input) as Promise<any>
    const group = await request('POST', ['groups'], { name: 'linked' })
    await request('PATCH', ['groups', group.id], { message: 'linked commit' })
    await writeFile(join(worktree, 'a.txt'), 'linked snapshot\n')
    await request('POST', ['stage'], { path: 'a.txt', groupId: group.id })
    const indexPath = f.run('-C', worktree, 'rev-parse', '--git-path', 'index')
    const unrelatedEntries = f.run('-C', worktree, 'ls-files', '--stage', '--', 'b.txt', 'index.txt')
    await request('POST', ['commit'], { groupId: group.id })
    expect(f.run('rev-parse', 'HEAD')).toBe(primaryHead)
    expect(f.run('show', 'review:a.txt')).toBe('linked snapshot')
    expect(f.run('-C', worktree, 'ls-files', '--stage', '--', 'b.txt', 'index.txt')).toBe(unrelatedEntries)
    expect(f.run('-C', worktree, 'status', '--porcelain')).toBe('')
    expect(await readFile(indexPath)).not.toHaveLength(0)
  })

  it('reports binary files and enforces file size limits', async () => {
    const f = await fixture()
    await writeFile(join(f.root, 'binary.dat'), Buffer.from([0, 255, 1]))
    expect(await f.request('GET', 'diff', {}, 'binary.dat')).toEqual({ text: '', binary: true })
    await expect(f.request('GET', 'file', {}, 'binary.dat')).rejects.toMatchObject({ status: 415 })
    await writeFile(join(f.root, 'large.txt'), Buffer.alloc(1024 * 1024 + 1, 65))
    await expect(f.request('GET', 'file', {}, 'large.txt')).rejects.toMatchObject({ status: 413 })
  })

  it('establishes a non-Git baseline without attributing preexisting files to an agent', async () => {
    const f = await fixture(false)
    await writeFile(join(f.root, 'existing.txt'), 'preexisting\n')
    expect(await f.request('GET')).toEqual({ isGit: false, branch: null, files: [], additions: 0, deletions: 0, groups: [] })
    await writeFile(join(f.root, 'existing.txt'), 'changed\n')
    await writeFile(join(f.root, 'new.txt'), 'new\n')
    f.reload()
    expect((await f.request('GET')).files.map((file: any) => file.path)).toEqual(['existing.txt', 'new.txt'])
    const id = await f.group('non-Git')
    await f.request('POST', 'stage', { path: 'new.txt', groupId: id })
    await expect(f.request('POST', 'commit', { groupId: id })).rejects.toMatchObject({ status: 409, code: 'NOT_GIT' })
  })

  it('does not adopt a parent repository when the stored directory is a subdirectory', async () => {
    const f = await fixture(), subdir = join(f.root, 'subdir'); await mkdir(subdir)
    const service = new SessionWorkspaceService(f.storage)
    expect(await service.request('owner', 'nested-session', subdir, 'GET', [], null)).toMatchObject({ isGit: false })
  })
})

describe('session workspace filename search', { timeout: 60_000 }, () => {
  it('searches nested tracked and untracked filenames with deterministic all-token fuzzy ranking', async () => {
    const f = await fixture()
    await mkdir(join(f.root, 'src', 'nested'), { recursive: true })
    await writeFile(join(f.root, 'src', 'nested', 'SessionWorkspace.ts'), 'not searched')
    await writeFile(join(f.root, 'src', 'nested', 'SessionWorkspace.test.ts'), '')
    f.run('add', 'src/nested/SessionWorkspace.ts')
    await writeFile(join(f.root, '.gitignore'), 'ignored/\n*.generated\n')
    await mkdir(join(f.root, 'ignored'))
    await writeFile(join(f.root, 'ignored', 'SessionWorkspace.ts'), '')
    await writeFile(join(f.root, 'SessionWorkspace.generated'), '')
    const expected = { paths: ['src/nested/SessionWorkspace.test.ts', 'src/nested/SessionWorkspace.ts'], truncated: false }
    expect(await f.request('GET', 'search', { query: 'NESTED sws' })).toEqual(expected)
    expect(await f.request('GET', 'search', { query: 'sessionworkspace.ts' })).toEqual({ paths: [expected.paths[1], expected.paths[0]], truncated: false })
    expect(await f.request('GET', 'search', { query: 'workspace nested absent' })).toEqual({ paths: [], truncated: false })
    expect(await f.request('GET', 'search', { query: ' NESTED  sws ' })).toEqual(expected)
    expect(await f.request('GET', 'search', { query: '' })).toEqual({ paths: ['.gitignore', 'a.txt', 'b.txt', 'index.txt', ...expected.paths], truncated: false })
    expect(await filesystem.readdir(f.storage).catch(() => [])).toEqual([])
  })

  it.each([true, false])('omits secrets, symlinks, missing tracked files and snapshot storage (git=%s)', async git => {
    const f = await fixture(git)
    await mkdir(join(f.root, 'nested'))
    await writeFile(join(f.root, 'nested', 'safe.txt'), '')
    for (const name of ['.env', '.env.local', 'credentials.json', 'access-token.txt', 'private.key']) await writeFile(join(f.root, name), '')
    await mkdir(join(f.root, 'secrets'))
    await writeFile(join(f.root, 'secrets', 'safe.txt'), '')
    const outside = join(f.root, '..', 'outside')
    await mkdir(outside)
    await writeFile(join(outside, 'escaped.txt'), '')
    await symlink(outside, join(f.root, 'linked-directory'))
    await symlink(join(outside, 'escaped.txt'), join(f.root, 'linked-file.txt'))
    await symlink(join(f.root, 'nested', 'safe.txt'), join(f.root, 'internal-link.txt'))
    if (git) {
      f.run('add', '.')
      await rm(join(f.root, 'a.txt'))
      await rm(join(f.root, 'nested'), { recursive: true })
      await symlink(outside, join(f.root, 'nested'))
      expect(await f.request('GET', 'search')).toEqual({ paths: ['b.txt', 'index.txt'], truncated: false })
    } else {
      const storage = join(f.root, 'review-state')
      await mkdir(storage)
      await writeFile(join(storage, 'snapshot.json'), '')
      const service = new SessionWorkspaceService(storage)
      expect(await service.request('owner', 'session', f.root, 'GET', ['search'], null)).toEqual({ paths: ['nested/safe.txt'], truncated: false })
    }
  })

  it('skips generated non-Git folders and never reads contents or initializes a baseline', async () => {
    const f = await fixture(false)
    for (const name of ['node_modules', 'dist', 'build', '.git', '.next', 'coverage', '__pycache__']) {
      await mkdir(join(f.root, name))
      await writeFile(join(f.root, name, 'generated.txt'), '')
    }
    await writeFile(join(f.root, 'large.bin'), Buffer.alloc(2 * 1024 * 1024))
    const contents = vi.spyOn(SessionWorkspaceService.prototype as any, 'bytes')
    const baselineWalk = vi.spyOn(SessionWorkspaceService.prototype as any, 'walk')
    expect(await f.request('GET', 'search', { query: 'LARGE' })).toEqual({ paths: ['large.bin'], truncated: false })
    expect(contents).not.toHaveBeenCalled()
    expect(baselineWalk).not.toHaveBeenCalled()
    expect(await filesystem.readdir(f.storage).catch(() => [])).toEqual([])
    expect(await f.request('GET', 'search')).toEqual({ paths: ['large.bin'], truncated: false })
  })

  it.each([true, false])('caps results at 100 and traversal at 20000 entries (git=%s)', async git => {
    const f = await fixture(git)
    if (git) await rm(join(f.root, '.git'), { recursive: true })
    const names = Array.from({ length: 20001 }, (_, i) => `file-${String(i).padStart(5, '0')}.txt`)
    for (let start = 0; start < names.length; start += 500) {
      await Promise.all(names.slice(start, start + 500).map(name => writeFile(join(f.root, name), '')))
    }
    if (git) f.run('init', '-q')
    const result = await f.request('GET', 'search')
    expect(result.paths).toHaveLength(100)
    expect(result.paths).toEqual([...result.paths].sort())
    expect(result.truncated).toBe(true)
    expect(await f.request('GET', 'search', { query: 'not-present' })).toEqual({ paths: [], truncated: true })
  })

  it('reports the result cap independently of traversal truncation', async () => {
    const f = await fixture(false)
    await Promise.all(Array.from({ length: 101 }, (_, i) => writeFile(join(f.root, `${String(i).padStart(3, '0')}.txt`), '')))
    expect(await f.request('GET', 'search')).toEqual({ paths: Array.from({ length: 100 }, (_, i) => `${String(i).padStart(3, '0')}.txt`), truncated: true })
    expect(await f.request('GET', 'search', { query: '100.txt' })).toEqual({ paths: ['100.txt'], truncated: false })
  })

  it('drops partial filenames when bounded Git output is truncated', async () => {
    const f = await fixture()
    const execute = gitExecutor.executeGit
    let stdout = 'a.txt\0b.txt'
    vi.spyOn(gitExecutor, 'executeGit').mockImplementation(async (args, options) => {
      if (args.includes('ls-files')) {
        expect(args).toEqual(expect.arrayContaining(['--cached', '--others', '--exclude-standard', '-z']))
        expect(options.truncateOutput).toBe(true)
        return { stdout, stderr: '', code: 0, truncated: true }
      }
      return execute(args, options)
    })
    expect(await f.request('GET', 'search')).toEqual({ paths: ['a.txt'], truncated: true })
    stdout = 'a.txt'
    expect(await f.request('GET', 'search')).toEqual({ paths: [], truncated: true })
  })

  it('does not search a parent repository or accept malformed queries', async () => {
    const f = await fixture()
    const subdir = join(f.root, 'subdir')
    await mkdir(subdir)
    await writeFile(join(subdir, 'local.txt'), '')
    const service = new SessionWorkspaceService(f.storage)
    expect(await service.request('owner', 'nested-session', subdir, 'GET', ['search'], null)).toEqual({ paths: ['local.txt'], truncated: false })
    for (const query of [123, 'x'.repeat(4097), 'bad\0query']) {
      await expect(f.request('GET', 'search', { query })).rejects.toMatchObject({ status: 400, code: 'INVALID_INPUT' })
    }
  })
})

function routeContext(root: string, owner: string | null = 'owner', stored = true) {
  const url = new URL('http://localhost/api/sessions/session/workspace/files?path=')
  const lookup = async (_client: unknown, userId: string, id: string) => stored && userId === 'owner' && id === 'session' ? { userId: 'owner', directory: root } : null
  return {
    request: new Request(url.href), url, path: ['api', 'sessions', 'session', 'workspace', 'files'],
    correlationId: 'test', authenticatedUser: owner ? { id: owner } : null, internalRequest: false, gatewayCredential: null,
    deps: { applicationDatabase: async () => ({}), ownedSessionRecord: lookup, json: (body: unknown, status = 200) => Response.json(body, { status }), redactedDiagnostic: () => 'redacted' },
  }
}

describe('session workspace route authorization', () => {
  it('passes search queries and defaults to empty search only for the stored workspace owner', async () => {
    const f = await fixture()
    for (const query of ['INDEX', '']) {
      const context = routeContext(f.root)
      context.path[4] = 'search'
      context.url.searchParams.set('root', '/etc')
      context.url.searchParams.set('directory', '/etc')
      if (query) context.url.searchParams.set('query', query)
      const response = await handleSessionsRoute(context as never)
      expect(response?.status).toBe(200)
      expect(await response!.json()).toEqual({ paths: query ? ['index.txt'] : ['a.txt', 'b.txt', 'index.txt'], truncated: false })
    }
    for (const context of [routeContext('/nonexistent', 'intruder'), routeContext('/nonexistent', 'owner', false)]) {
      context.path[4] = 'search'
      expect((await handleSessionsRoute(context as never))?.status).toBe(404)
    }
    for (const override of [{ authenticatedUser: null }, { internalRequest: true }, { gatewayCredential: { id: 'agent' } }]) {
      const context = routeContext('/nonexistent')
      context.path[4] = 'search'
      expect((await handleSessionsRoute({ ...context, ...override } as never))?.status).toBe(403)
    }
  })
  it('rejects a different owner and missing sessions before touching a directory', async () => {
    for (const context of [routeContext('/nonexistent', 'intruder'), routeContext('/nonexistent', 'owner', false)]) {
      expect((await handleSessionsRoute(context as never))?.status).toBe(404)
    }
  })
  it('denies internal/gateway callers instead of creating an agent permission bypass', async () => {
    const f = await fixture()
    for (const override of [{ authenticatedUser: null }, { internalRequest: true }, { gatewayCredential: { id: 'agent' } }]) {
      expect((await handleSessionsRoute({ ...routeContext(f.root), ...override } as never))?.status).toBe(403)
    }
  })
  it('uses the stored session directory, ignoring arbitrary directory/root parameters', async () => {
    const f = await fixture()
    const context = routeContext(f.root)
    context.url.searchParams.set('root', '/etc'); context.url.searchParams.set('directory', '/etc')
    const response = await handleSessionsRoute(context as never)
    expect(response?.status).toBe(200)
    const body = await response!.json() as { entries: Array<{ name: string }> }
    expect(body.entries.map(entry => entry.name)).toContain('a.txt')
  })
})
