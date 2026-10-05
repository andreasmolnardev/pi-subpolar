import { constants } from 'node:fs'
import { lstat, link, mkdir, open, readFile, readdir, realpath, rename, rm, writeFile, mkdtemp } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { join, isAbsolute, relative, resolve } from 'node:path'
import { homedir } from 'node:os'
import { executeGit, GitExecutionError } from '../git/executor.ts'
import { safeRelativePath } from '../git/policy.ts'

const MAX_BYTES = 1024 * 1024
const MAX_FILES = 1000
const MAX_SEARCH_ENTRIES = 20000
const MAX_SEARCH_RESULTS = 100
const GENERATED = new Set(['node_modules', 'dist', 'build', '.git', '.next', '.nuxt', '.cache', 'coverage', 'vendor', 'target', '__pycache__', '.venv', 'venv'])
const MAX_STATE = 16 * MAX_BYTES
const SECRET = /^(?:\.git|\.env(?:\..*)?|\.ssh|\.aws|\.gnupg|\.netrc|\.npmrc|\.pypirc|auth\.json|secrets?|credentials?(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|.*\.(?:pem|key|p12|pfx))$/i
// Same secret-name boundaries as the operations artifact policy.
const SECRET_NAME = /(^|[._-])(env|secret|secrets|token|password|passwd|credential|credentials|cookie|private[._-]?key|session[._-]?key)([._-]|$)/i

type Snapshot = { content: string | null; base: string | null; mode: string }
type Group = { id: string; name: string; message: string; snapshots: Record<string, Snapshot> }
type PendingCommit = { groupId: string; commit: string; parent: string | null; indexDigest: string }
type State = { version: 1; root: string; groups: Group[]; baseline?: Record<string, string>; pendingCommit?: PendingCommit; completedCommit?: { groupId: string; commit: string } }
export class WorkspaceError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message) }
}
function fail(status: number, code: string, message: string): never { throw new WorkspaceError(status, code, message) }
function missing(error: unknown) { return (error as NodeJS.ErrnoException)?.code === 'ENOENT' }
function allowed(path: string) { return !path.split('/').some(part => SECRET.test(part) || SECRET_NAME.test(part)) }
function text(value: unknown, label: string, max = 4096): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) fail(400, 'INVALID_INPUT', `Invalid ${label}`)
  return value
}
function binary(value: Buffer) { return value.includes(0) || !Buffer.from(value.toString('utf8')).equals(value) }
function lines(value: string) { return value ? value.split('\n').length - (value.endsWith('\n') ? 1 : 0) : 0 }

/**
 * Owner/session keyed durable snapshots; no agent-tool entry point.
 * Commits use only a group's snapshots, then advance selected index entries that
 * were clean against old HEAD. All preexisting staged entries (including selected
 * paths) and unrelated index entries are retained. Later worktree edits stay
 * unstaged. Git's index.lock covers the index read, preparation and publication;
 * an existing lock fails closed without moving HEAD. No blanket reset is used.
 * Workspace GET/diff compare HEAD to the worktree, excluding index-only changes.
 */
export class SessionWorkspaceService {
  constructor(
      private readonly storage = process.env.SUBPOLAR_WORKSPACE_REVIEW_DIR ?? join(homedir(), '.subpolar', 'workspace-review'),
      private readonly publishIndex: typeof rename = rename,
      private readonly persistState: typeof rename = rename,
    ) {}

  private key(value: string) { return createHash('sha256').update(value).digest('hex') }
  private async lock<T>(key: string, run: () => Promise<T>): Promise<T> {
    await mkdir(this.storage, { recursive: true, mode: 0o700 })
    const lock = join(this.storage, `${this.key(key)}.lock`)
    const end = Date.now() + 5000
    for (;;) {
      try { await mkdir(lock, { mode: 0o700 }); break } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        if (Date.now() >= end) fail(409, 'WORKSPACE_BUSY', 'Workspace is busy; retry later')
        await new Promise(resolve => setTimeout(resolve, 25))
      }
    }
    try { return await run() } finally { await rm(lock, { recursive: true, force: true }) }
  }

  private async path(root: string, input: unknown, directory = false): Promise<string> {
    if (directory && input === '') {
      if (root === await realpath(this.storage).catch(() => resolve(this.storage))) fail(403, 'PATH_DENIED', 'Snapshot storage is not accessible')
      return root
    }
    if (typeof input !== 'string' || !input || input.length > 4096) fail(400, 'INVALID_PATH', 'A relative path is required')
    if (input.includes('\\')) fail(403, 'PATH_DENIED', 'Paths must use forward slashes')
    let path: string
    try { path = safeRelativePath(input)! } catch { return fail(403, 'PATH_DENIED', 'Path is not allowed') }
    if (!allowed(path)) fail(403, 'PATH_DENIED', 'Path is not allowed')
    const storageRelative = relative(await realpath(this.storage).catch(() => resolve(this.storage)), join(root, path))
    if (!storageRelative || (storageRelative !== '..' && !storageRelative.startsWith('../') && !isAbsolute(storageRelative))) fail(403, 'PATH_DENIED', 'Snapshot storage is not accessible')
    const parts = path.split('/')
    let current = root
    for (const part of parts) {
      current = join(current, part)
      try {
        if ((await lstat(current)).isSymbolicLink()) fail(403, 'PATH_DENIED', 'Symbolic links are not allowed')
      } catch (error) { if (!missing(error)) throw error }
    }
    return current
  }

  private async bytes(root: string, path: string): Promise<Buffer | null> {
    const target = await this.path(root, path)
    let file
    try {
      file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW)
      const stat = await file.stat()
      if (!stat.isFile()) fail(403, 'PATH_DENIED', 'Only regular files are supported')
      if (stat.size > MAX_BYTES) fail(413, 'LIMIT_EXCEEDED', 'File exceeds 1 MiB')
      const data = await file.readFile()
      if (data.length > MAX_BYTES) fail(413, 'LIMIT_EXCEEDED', 'File exceeds 1 MiB')
      return data
    } catch (error) { if (missing(error)) return null; throw error } finally { await file?.close() }
  }

  private async git(root: string, args: string[], indexFile?: string) {
    return (await executeGit(['--no-pager', '--literal-pathspecs', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], { cwd: root, maxOutputBytes: MAX_BYTES, indexFile })).stdout
  }
  private async head(root: string): Promise<string | null> {
    try { return (await this.git(root, ['rev-parse', '--verify', 'HEAD'])).trim() } catch (error) {
      if (error instanceof GitExecutionError && error.exitCode === 128) return null
      throw error
    }
  }
  private async treeEntry(root: string, head: string | null, path: string): Promise<{ mode: string; oid: string } | null> {
    if (!head) return null
    const entry = await this.git(root, ['ls-tree', '-z', head, '--', path])
    if (!entry) return null
    const [mode, type, oid] = entry.split('\t')[0]!.split(' ')
    if (type !== 'blob' || mode === '120000') fail(403, 'PATH_DENIED', 'Only regular Git files are supported')
    return { mode: mode!, oid: oid! }
  }
  private async blob(root: string, head: string | null, path: string): Promise<string | null> {
    return (await this.treeEntry(root, head, path))?.oid ?? null
  }
  private async walk(root: string, prefix = ''): Promise<string[]> {
    const result: string[] = []
    let visited = 0
    const visit = async (directory: string) => {
      for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
        if (++visited > 10000) fail(413, 'LIMIT_EXCEEDED', 'Workspace scan exceeds 10000 entries')
        const path = directory ? `${directory}/${entry.name}` : entry.name
        if (!allowed(path) || entry.isSymbolicLink()) continue
        try { await this.path(root, path) } catch (error) { if (error instanceof WorkspaceError && error.code === 'PATH_DENIED') continue; throw error }
        if (entry.isDirectory()) await visit(path)
        else if (entry.isFile()) result.push(path)
        if (result.length > MAX_FILES) fail(413, 'LIMIT_EXCEEDED', 'Workspace exceeds 1000 files')
      }
    }
    await visit(prefix)
    return result.sort()
  }
  private async isGitRoot(root: string): Promise<boolean> {
    try {
      const top = (await this.git(root, ['rev-parse', '--show-toplevel'])).trim()
      // A session inside a parent repository must never gain access to that repository.
      return await realpath(top) === root
    } catch (error) {
      if (error instanceof GitExecutionError && error.exitCode === 128) return false
      throw error
    }
  }

  private async search(root: string, query: unknown): Promise<{ paths: string[]; truncated: boolean }> {
    if (typeof query !== 'string' || query.length > 4096 || query.includes('\0')) fail(400, 'INVALID_INPUT', 'Invalid search query')
    const tokens = query.toLowerCase().trim().split(/\s+/).filter(Boolean)
    const matches: Array<{ path: string; score: number }> = []
    let visited = 0, truncated = false
    const consider = async (path: string) => {
      if (!allowed(path)) return
      let target: string
      try {
        target = await this.path(root, path)
        if (!(await lstat(target)).isFile()) return
      } catch (error) {
        if (missing(error) || (error as NodeJS.ErrnoException).code === 'ENOTDIR' || (error instanceof WorkspaceError && error.code === 'PATH_DENIED')) return
        throw error
      }
      const lower = path.toLowerCase(), name = lower.slice(lower.lastIndexOf('/') + 1)
      let score = 0
      for (const token of tokens) {
        if (name === token) continue
        if (name.startsWith(token)) { score += 1; continue }
        if (name.includes(token)) { score += 2; continue }
        if (lower.includes(token)) { score += 3; continue }
        let position = -1, first = -1
        for (const character of token) {
          position = lower.indexOf(character, position + 1)
          if (position < 0) return
          if (first < 0) first = position
        }
        score += 4 + (position - first + 1 - token.length) / (lower.length + 1)
      }
      matches.push({ path, score })
    }
    if (await this.isGitRoot(root)) {
      const result = await executeGit(['--no-pager', '--literal-pathspecs', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, maxOutputBytes: MAX_STATE, truncateOutput: true })
      truncated = Boolean(result.truncated)
      // Only complete NUL-delimited paths are safe when Git output is cut short.
      const end = result.stdout.lastIndexOf('\0')
      const paths = (end < 0 ? '' : result.stdout.slice(0, end)).split('\0').filter(Boolean)
      for (const path of new Set(paths)) {
        if (visited === MAX_SEARCH_ENTRIES) { truncated = true; break }
        visited++
        await consider(path)
      }
    } else {
      const visit = async (directory: string): Promise<void> => {
        const entries = await readdir(join(root, directory), { withFileTypes: true })
        entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
        for (const entry of entries) {
          if (visited === MAX_SEARCH_ENTRIES) { truncated = true; return }
          visited++
          const path = directory ? `${directory}/${entry.name}` : entry.name
          if (!allowed(path) || entry.isSymbolicLink()) continue
          if (entry.isDirectory()) {
            if (GENERATED.has(entry.name.toLowerCase())) continue
            try { await this.path(root, path) } catch (error) {
              if (error instanceof WorkspaceError && error.code === 'PATH_DENIED') continue
              throw error
            }
            await visit(path)
          } else if (entry.isFile()) await consider(path)
          if (truncated) return
        }
      }
      await visit('')
    }
    matches.sort((a, b) => a.score - b.score || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    return { paths: matches.slice(0, MAX_SEARCH_RESULTS).map(match => match.path), truncated: truncated || matches.length > MAX_SEARCH_RESULTS }
  }

  private publicGroups(state: State) { return state.groups.map(({ id, name, message, snapshots }) => ({ id, name, message, paths: Object.keys(snapshots).sort() })) }

  async request(owner: string, session: string, directory: string, method: string, endpoint: string[], path: string | null, input: Record<string, unknown> = {}): Promise<unknown> {
    text(owner, 'owner', 300); text(session, 'session', 300)
    if (!directory || !isAbsolute(directory)) fail(404, 'WORKSPACE_NOT_FOUND', 'Session workspace is unavailable')
    const root = await realpath(directory)
    const storage = await realpath(this.storage).catch(() => resolve(this.storage))
    const insideStorage = relative(storage, root)
    if (!insideStorage || (insideStorage !== '..' && !insideStorage.startsWith('../') && !isAbsolute(insideStorage))) fail(403, 'PATH_DENIED', 'Snapshot storage is not a workspace')
    // Filename search must not read file contents or initialize a non-Git baseline.
    if (method === 'GET' && endpoint.length === 1 && endpoint[0] === 'search') return this.search(root, input.query ?? '')
    // Serialize across sessions sharing a root as well as across server processes.
    return this.lock(`root:${root}`, () => this.lock(JSON.stringify(['session', owner, session]), async () => {
      const statePath = join(this.storage, `${this.key(JSON.stringify([owner, session]))}.json`)
      let state: State
      try {
        // Legacy delimiter keys are unambiguous only when neither component
        // contains a colon. Retain existing snapshots without accepting collisions.
        const stored = await readFile(statePath).catch(error => {
          if (!missing(error) || owner.includes(':') || session.includes(':')) throw error
          return readFile(join(this.storage, `${this.key(`${owner}:${session}`)}.json`))
        })
        if (stored.length > MAX_STATE) fail(413, 'LIMIT_EXCEEDED', 'Snapshot storage limit exceeded')
        state = JSON.parse(stored.toString())
        if (state.baseline) state.baseline = Object.assign(Object.create(null), state.baseline)
        for (const group of state.groups) group.snapshots = Object.assign(Object.create(null), group.snapshots)
        if (state.root !== root) fail(409, 'WORKSPACE_CHANGED', 'Session directory changed; snapshots belong to the previous workspace')
      } catch (error) { if (!missing(error)) throw error; state = { version: 1, root, groups: [] } }
      const save = async () => {
        const data = JSON.stringify(state)
        if (Buffer.byteLength(data) > MAX_STATE) fail(413, 'LIMIT_EXCEEDED', 'Snapshot storage limit exceeded')
        const temp = `${statePath}.${randomUUID()}`
        try { await writeFile(temp, data, { mode: 0o600, flag: 'wx' }); await this.persistState(temp, statePath) } finally { await rm(temp, { force: true }) }
      }
      const isGit = await this.isGitRoot(root)
      const head = isGit ? await this.head(root) : null
      const headRef = async () => {
        try { return (await this.git(root, ['symbolic-ref', 'HEAD'])).trim() } catch (error) {
          if (error instanceof GitExecutionError && error.exitCode === 1) return 'HEAD'
          throw error
        }
      }
      const commitRef = isGit ? await headRef() : null
      if (state.pendingCommit) {
        const pending = state.pendingCommit
        if (!/^[a-f0-9]{64}$/.test(pending.indexDigest)) fail(500, 'COMMIT_RECOVERY_REQUIRED', `Commit recovery for ${pending.commit} has no valid prepared-index digest; inspect the repository before retrying`)
        const realIndex = resolve(root, (await this.git(root, ['rev-parse', '--git-path', 'index'])).trim())
        const indexLock = `${realIndex}.lock`
        let lockBytes: Buffer | null
        try { lockBytes = await readFile(indexLock) } catch (error) { if (missing(error)) lockBytes = null; else throw error }
        if (head === pending.commit) {
          if (lockBytes) {
            const digest = createHash('sha256').update(lockBytes).digest('hex')
            if (digest !== pending.indexDigest) fail(500, 'COMMIT_RECOVERY_REQUIRED', `Commit recovery for ${pending.commit} found an unrecognized index lock; inspect the repository before retrying`)
            try { await this.publishIndex(indexLock, realIndex) } catch { fail(500, 'COMMIT_RECOVERY_REQUIRED', `Commit ${pending.commit} is published but its verified index lock could not be published; retry recovery`) }
          } else {
            let indexBytes: Buffer | null
            try { indexBytes = await readFile(realIndex) } catch (error) { if (missing(error)) indexBytes = null; else throw error }
            if (!indexBytes || createHash('sha256').update(indexBytes).digest('hex') !== pending.indexDigest) fail(500, 'COMMIT_RECOVERY_REQUIRED', `Commit recovery for ${pending.commit} found an unexpected index; inspect the repository before retrying`)
          }
          const committedGroup = state.groups.find(item => item.id === pending.groupId)
          if (committedGroup) committedGroup.snapshots = Object.create(null)
          state.completedCommit = { groupId: pending.groupId, commit: pending.commit }
        } else if (head === pending.parent) {
          if (lockBytes) {
            const digest = createHash('sha256').update(lockBytes).digest('hex')
            if (digest !== pending.indexDigest) fail(500, 'COMMIT_RECOVERY_REQUIRED', `Commit recovery for ${pending.commit} found an unrecognized index lock; inspect the repository before retrying`)
            await rm(indexLock)
          }
        } else {
          if (lockBytes) {
            const digest = createHash('sha256').update(lockBytes).digest('hex')
            if (digest !== pending.indexDigest) fail(500, 'COMMIT_RECOVERY_REQUIRED', `Commit recovery for ${pending.commit} found an unrecognized index lock; inspect the repository before retrying`)
            await rm(indexLock)
          }
          fail(500, 'COMMIT_RECOVERY_REQUIRED', `Commit recovery for ${pending.commit} found unexpected HEAD ${head ?? '(unborn)'}; inspect the repository before retrying`)
        }
        delete state.pendingCommit
        await save()
      }
      if (!isGit && !state.baseline) {
        state.baseline = Object.create(null)
        let baselineBytes = 0
        for (const file of await this.walk(root)) {
          const data = await this.bytes(root, file)
          if (data) {
            baselineBytes += data.length
            if (baselineBytes > MAX_STATE / 2) fail(413, 'LIMIT_EXCEEDED', 'Non-Git baseline exceeds 8 MiB')
            state.baseline![file] = data.toString('base64')
          }
        }
        await save()
      }
      const baseBytes = async (file: string): Promise<Buffer | null> => {
        if (!isGit) return state.baseline?.[file] === undefined ? null : Buffer.from(state.baseline[file]!, 'base64')
        const oid = await this.blob(root, head, file)
        if (!oid) return null

        const size = Number((await this.git(root, ['cat-file', '-s', oid])).trim())
        if (size > MAX_BYTES) fail(413, 'LIMIT_EXCEEDED', 'Git file exceeds 1 MiB')
        const result = await executeGit(['--no-pager', 'cat-file', 'blob', oid], { cwd: root, maxOutputBytes: MAX_BYTES, rawOutput: true })
        return result.stdoutBytes ?? Buffer.from(result.stdout)
      }
      // GET describes HEAD-to-worktree changes, never the real index's staging state.
      const changes = async (file: string, allowMissing = false) => {
        const current = await this.bytes(root, file)
        const before = await baseBytes(file)
        if (!current && !before) {
          if (allowMissing) return null
          fail(404, 'FILE_NOT_FOUND', 'File not found')
        }
        const beforeMode = isGit ? (await this.treeEntry(root, head, file))?.mode : undefined
        const currentMode = current ? ((await lstat(join(root, file))).mode & 0o111 ? '100755' : '100644') : undefined
        const changed = !current || !before || !current.equals(before) || (isGit && beforeMode !== currentMode)
        let additions = lines(current?.toString() ?? ''), deletions = lines(before?.toString() ?? '')
        let isBinary = binary(current ?? Buffer.alloc(0)) || binary(before ?? Buffer.alloc(0))
        let patch = ''
        if (!changed) { additions = 0; deletions = 0 }
        else if (isGit && before) {
          const temp = await mkdtemp(join(this.storage, 'diff-'))
          const index = join(temp, 'index')
          try {
            await this.git(root, ['read-tree', head!], index)
            const stats = await this.git(root, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--numstat', head!, '--', file], index)
            const [a, d] = stats.split('\t')
            isBinary ||= a === '-'
            additions = a === '-' ? 0 : Number(a || 0); deletions = d === '-' ? 0 : Number(d || 0)
            if (!isBinary) patch = await this.git(root, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', head!, '--', file], index)
          } finally { await rm(temp, { recursive: true, force: true }) }
        } else if (!isBinary) {
          patch = `--- ${before ? `a/${file}` : '/dev/null'}\n+++ ${current ? `b/${file}` : '/dev/null'}\n@@ -${deletions ? 1 : 0},${deletions} +${additions ? 1 : 0},${additions} @@\n`
          for (const [data, sign] of [[before, '-'], [current, '+']] as const) {
            if (!data?.length) continue
            const value = data.toString(); patch += value.replace(/\n$/, '').split('\n').map(line => `${sign}${line}\n`).join('')
            if (!value.endsWith('\n')) patch += '\\ No newline at end of file\n'
          }
        }
        if (Buffer.byteLength(patch) > MAX_BYTES) fail(413, 'LIMIT_EXCEEDED', 'Diff exceeds 1 MiB')
        return { changed, path: file, status: !before ? 'added' : !current ? 'deleted' : 'modified', additions: isBinary ? 0 : additions, deletions: isBinary ? 0 : deletions, ...(isBinary ? { binary: true } : {}), text: isBinary ? '' : patch }
      }
      const operation = endpoint.join('/')
      if (method === 'GET' && !operation) {
        let candidates: string[]
        if (isGit) {
          const tracked = head ? await this.git(root, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', '-z', head, '--']) : await this.git(root, ['ls-files', '-z', '--cached'])
          const untracked = await this.git(root, ['ls-files', '-z', '--others', '--exclude-standard'])
          candidates = [...new Set(`${tracked}${untracked}`.split('\0').filter(Boolean))]
        } else candidates = [...new Set([...await this.walk(root), ...Object.keys(state.baseline!)])]
        if (candidates.length > 10000) fail(413, 'LIMIT_EXCEEDED', 'Workspace candidate scan exceeds 10000 entries')
        const files = []
        for (const file of candidates.sort()) {
          if (!allowed(file)) continue
          try {
            const result = await changes(file, true)
            if (!result?.changed) continue
            const { text: _text, changed: _changed, ...change } = result; files.push(change)
                        if (files.length > MAX_FILES) fail(413, 'LIMIT_EXCEEDED', 'Workspace exceeds 1000 changed files')
          } catch (error) { if (error instanceof WorkspaceError && error.code === 'PATH_DENIED') continue; throw error }
        }
        let branch: string | null = null
        if (isGit) { try { branch = (await this.git(root, ['symbolic-ref', '--short', 'HEAD'])).trim() } catch (error) { if (!(error instanceof GitExecutionError)) throw error } }
        return { isGit, branch, files, additions: files.reduce((n, f) => n + f.additions, 0), deletions: files.reduce((n, f) => n + f.deletions, 0), groups: this.publicGroups(state) }
      }
      if (method === 'GET' && operation === 'files') {
        const target = await this.path(root, path ?? '', true)
        const entries = []
        for (const entry of await readdir(target, { withFileTypes: true })) {
          const file = path ? `${path}/${entry.name}` : entry.name
          if (!allowed(file) || entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) continue
          try { await this.path(root, file) } catch (error) { if (error instanceof WorkspaceError && error.code === 'PATH_DENIED') continue; throw error }
          entries.push({ name: entry.name, path: file, directory: entry.isDirectory() })
          if (entries.length > MAX_FILES) fail(413, 'LIMIT_EXCEEDED', 'Directory exceeds 1000 entries')
        }
        return { entries: entries.sort((a, b) => a.path.localeCompare(b.path)) }
      }
      if (method === 'GET' && (operation === 'file' || operation === 'diff')) {
        await this.path(root, path)
        if (operation === 'diff') { const result = (await changes(path!))!; return { text: result.text, ...(result.binary ? { binary: true } : {}) } }
        const data = await this.bytes(root, path!)
        if (!data) fail(404, 'FILE_NOT_FOUND', 'File not found')
        if (binary(data)) fail(415, 'BINARY_FILE', 'Binary files cannot be edited')
        return { content: data.toString() }
      }
      if (method === 'PUT' && operation === 'file') {
        const file = text(input.path, 'path')
        const target = await this.path(root, file)
        if (typeof input.content !== 'string' || typeof input.expectedContent !== 'string') fail(400, 'INVALID_INPUT', 'content and expectedContent must be strings')
        if (Buffer.byteLength(input.content) > MAX_BYTES) fail(413, 'LIMIT_EXCEEDED', 'File exceeds 1 MiB')
        const old = await this.bytes(root, file)
        if (!old) fail(404, 'FILE_NOT_FOUND', 'File not found')
        if (binary(old)) fail(415, 'BINARY_FILE', 'Binary files cannot be edited')
        if (old.toString() !== input.expectedContent) fail(409, 'CONTENT_CONFLICT', 'File changed since it was read')
        const handle = await open(target, constants.O_RDWR | constants.O_NOFOLLOW)
        try {
          if (!(await handle.readFile()).equals(old)) fail(409, 'CONTENT_CONFLICT', 'File changed since it was read')
          await handle.write(Buffer.from(input.content), 0, Buffer.byteLength(input.content), 0)
          await handle.truncate(Buffer.byteLength(input.content))
        } finally { await handle.close() }
        return { content: input.content }
      }
      if (method === 'POST' && operation === 'groups') {
        if (state.groups.length >= 100) fail(413, 'LIMIT_EXCEEDED', 'Too many groups')
        const group: Group = { id: randomUUID(), name: text(input.name, 'group name', 200), message: '', snapshots: Object.create(null) }
        state.groups.push(group); await save()
        return this.publicGroups(state).find(item => item.id === group.id)
      }
      if (method === 'PATCH' && endpoint.length === 2 && endpoint[0] === 'groups') {
        const group = state.groups.find(item => item.id === endpoint[1])
        if (!group) fail(404, 'GROUP_NOT_FOUND', 'Group not found')
        if (input.name !== undefined) group.name = text(input.name, 'group name', 200)
        if (input.message !== undefined) {
          if (typeof input.message !== 'string' || input.message.length > 4096 || input.message.includes('\0')) fail(400, 'INVALID_INPUT', 'Invalid commit message')
          group.message = input.message
        }
        await save(); return this.publicGroups(state).find(item => item.id === group.id)
      }
      if (method === 'POST' && operation === 'unstage') {
        const file = text(input.path, 'path'); await this.path(root, file)
        for (const group of state.groups) {
          if (group.snapshots[file] && state.completedCommit?.groupId === group.id) delete state.completedCommit
          delete group.snapshots[file]
        }
        await save(); return { groups: this.publicGroups(state) }
      }
      if (method === 'POST' && operation === 'stage') {
        const file = text(input.path, 'path'); await this.path(root, file)
        const group = state.groups.find(item => item.id === input.groupId)
        if (!group) fail(404, 'GROUP_NOT_FOUND', 'Group not found')
        const data = await this.bytes(root, file)
        const base = isGit ? await this.blob(root, head, file) : state.baseline?.[file] ?? null
        if (!data && !base) fail(404, 'FILE_NOT_FOUND', 'File not found')
        const mode = data && (await lstat(join(root, file))).mode & 0o111 ? '100755' : '100644'
        for (const item of state.groups) {
          if (item.snapshots[file] && state.completedCommit?.groupId === item.id) delete state.completedCommit
          delete item.snapshots[file]
        }
        group.snapshots[file] = { content: data?.toString('base64') ?? null, base, mode }
        await save(); return { groups: this.publicGroups(state) }
      }
      if (method === 'POST' && operation === 'commit') {
        if (!isGit) fail(409, 'NOT_GIT', 'Commits require a Git workspace')
        const group = state.groups.find(item => item.id === input.groupId)
        if (!group) fail(404, 'GROUP_NOT_FOUND', 'Group not found')
        const paths = Object.keys(group.snapshots)
        if (!paths.length) {
          if (state.completedCommit?.groupId === group.id) return { commit: state.completedCommit.commit, groups: this.publicGroups(state) }
          fail(409, 'EMPTY_GROUP', 'Group has no staged snapshots')
        }
        const message = text(group.message, 'commit message')
        for (const file of paths) {
          await this.path(root, file)
          if (await this.blob(root, head, file) !== group.snapshots[file]!.base) fail(409, 'SNAPSHOT_CONFLICT', `HEAD changed for ${file}; restage the file`)
        }
        const temp = await mkdtemp(join(this.storage, 'commit-'))
        const index = join(temp, 'index')
        try {
          await this.git(root, head ? ['read-tree', head] : ['read-tree', '--empty'], index)
          for (const file of paths) {
            const snapshot = group.snapshots[file]!
            if (snapshot.content === null) await this.git(root, ['update-index', '--force-remove', '--', file], index)
            else {
              const blobFile = join(temp, 'blob')
              await writeFile(blobFile, Buffer.from(snapshot.content, 'base64'), { mode: 0o600 })
              const oid = (await this.git(root, ['hash-object', '-w', '--no-filters', '--', blobFile])).trim()
              await this.git(root, ['update-index', '--add', '--cacheinfo', snapshot.mode, oid, file], index)
            }
          }
          const tree = (await this.git(root, ['write-tree'], index)).trim()
          if (head && tree === (await this.git(root, ['rev-parse', `${head}^{tree}`])).trim()) fail(409, 'EMPTY_GROUP', 'Snapshots contain no changes')
          const commit = (await this.git(root, ['commit-tree', tree, ...(head ? ['-p', head] : []), '-m', message])).trim()
          const realIndex = resolve(root, (await this.git(root, ['rev-parse', '--git-path', 'index'])).trim())
          const indexLock = `${realIndex}.lock`
          const lockTemp = `${indexLock}.${randomUUID()}.tmp`
          let ownsIndexLock = false
          let preparedIndexDigest = ''
          try {
            const readIndex = async () => {
              try { return await readFile(realIndex) } catch (error) { if (missing(error)) return null; throw error }
            }
            const originalIndex = await readIndex()
            if (originalIndex && originalIndex.length > MAX_STATE) fail(413, 'LIMIT_EXCEEDED', 'Git index exceeds 16 MiB')
            const reconciledIndex = join(temp, 'reconciled-index')
            if (originalIndex) await writeFile(reconciledIndex, originalIndex, { mode: 0o600 })
            else await this.git(root, ['read-tree', '--empty'], reconciledIndex)
            // Clean means the complete index entry (mode, object ID, stage) equals old
            // HEAD, or both are absent. Staged additions/deletions, mode edits, intent
            // to add and unmerged entries are preserved, even on selected paths.
            // Copying the original index preserves unrelated entries and their flags.
            for (const file of paths) {
              const oldEntry = await this.treeEntry(root, head, file)
              const entries = await this.git(root, ['ls-files', '--stage', '-z', '--', file], reconciledIndex)
              const expected = oldEntry ? `${oldEntry.mode} ${oldEntry.oid} 0\t${file}\0` : ''
              if (entries !== expected) continue
              const committedEntry = await this.treeEntry(root, tree, file)
              if (committedEntry) await this.git(root, ['update-index', '--add', '--cacheinfo', committedEntry.mode, committedEntry.oid, file], reconciledIndex)
              else await this.git(root, ['update-index', '--force-remove', '--', file], reconciledIndex)
            }
            // Materialize split indexes before publishing a self-contained index.
            await this.git(root, ['update-index', '--no-split-index'], reconciledIndex)
            const preparedIndexBytes = await readFile(reconciledIndex)
            preparedIndexDigest = createHash('sha256').update(preparedIndexBytes).digest('hex')
            const pendingCommit: PendingCommit = { groupId: group.id, commit, parent: head, indexDigest: preparedIndexDigest }
            state.pendingCommit = pendingCommit
            // Durable intent precedes creation of Git's lock path. A crash before
            // lock publication can therefore be recovered without guessing ownership.
            await save()

            const preparedLock = await open(lockTemp, 'wx', 0o600)
            try { await preparedLock.writeFile(preparedIndexBytes); await preparedLock.sync() } finally { await preparedLock.close() }
            try { await link(lockTemp, indexLock); ownsIndexLock = true } catch (error) {
              if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
                delete state.pendingCommit
                await save()
                fail(409, 'INDEX_BUSY', 'Git index is locked; retry after the other Git operation finishes')
              }
              throw error
            }
            await rm(lockTemp, { force: true })
            const latestIndex = await readIndex()
            if (originalIndex ? !latestIndex?.equals(originalIndex) : latestIndex !== null) fail(409, 'INDEX_CONFLICT', 'Git index changed before commit publication; retry')
            if (await headRef() !== commitRef) {
              delete state.pendingCommit
              await save()
              fail(409, 'HEAD_CONFLICT', 'Checked-out branch changed during commit; retry')
            }
            const refOptions = commitRef === 'HEAD' ? ['--no-deref'] : []
            try { await this.git(root, ['update-ref', ...refOptions, '-m', 'session workspace group commit', commitRef!, commit, head ?? '0'.repeat(commit.length)]) } catch (error) {
              if (error instanceof GitExecutionError) {
                const observedHead = await this.head(root)
                if (observedHead === commit) {
                  // The ref command's result was ambiguous (for example, timeout),
                  // but the intended commit is now published; finish the index step.
                } else if (error.kind === 'failed' || observedHead === head) {
                  // update-ref failed atomically, or the ref is still its old value,
                  // so this intent never published.
                  delete state.pendingCommit
                  await save()
                  fail(409, 'HEAD_CONFLICT', 'HEAD changed during commit; retry')
                } else {
                  fail(500, 'COMMIT_RECOVERY_REQUIRED', `Commit ${commit} has an ambiguous ref outcome at HEAD ${observedHead ?? '(unborn)'}; inspect the repository before retrying`)
                }
              } else throw error
            }
            try {
              await this.publishIndex(indexLock, realIndex)
              ownsIndexLock = false
            } catch {
              // HEAD and index cannot be published atomically. On a publication
              // failure, roll back only if HEAD still points to our new commit.
              try {
                await this.git(root, head
                  ? ['update-ref', ...refOptions, commitRef!, head, commit]
                  : ['update-ref', ...refOptions, '-d', commitRef!, commit])
              } catch { fail(500, 'COMMIT_RECOVERY_REQUIRED', `Commit ${commit} was created but index publication failed and HEAD changed; inspect the repository before retrying`) }
              fail(500, 'INDEX_PUBLISH_FAILED', 'Index publication failed; HEAD was restored and snapshots were retained')
            }
          } finally {
            await rm(lockTemp, { force: true })
            if (ownsIndexLock) await rm(indexLock, { force: true })
          }
          group.snapshots = Object.create(null)
          state.completedCommit = { groupId: group.id, commit }
          delete state.pendingCommit
          try {
            await save()
            return { commit, groups: this.publicGroups(state) }
          } catch {
            // The ref and index are already published. The durable intent is still
            // present on disk, so the next request can finish clearing the group.
            state.pendingCommit = { groupId: group.id, commit, parent: head, indexDigest: preparedIndexDigest }
            return { commit, groups: this.publicGroups(state), recoveryPending: true }
          }
        } finally { await rm(temp, { recursive: true, force: true }) }
      }
      return fail(404, 'NOT_FOUND', 'Workspace endpoint not found')
    }))
  }
}
export const sessionWorkspaceService = new SessionWorkspaceService()
