
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, realpathSync, readFileSync, writeFileSync, rmSync, existsSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { executeGit } from '../git/executor.ts'
import { WorktreeController, type WorktreeRecord } from '../git/worktree-control.ts'
import { GitPathPolicy } from '../git/policy.ts'
import { GitReadService } from '../git/service.ts'
import { handleProjectsRoute } from '../routes/projects.ts'
import { handleSessionsRoute } from '../routes/sessions.ts'
import { resolveNewSessionRoute, NewSessionRouteError } from '../application/new-session-route.ts'

describe('linked worktree integration', () => {
  let root: string, repo: string, sha: string, previousRoot: string | undefined
  let records: WorktreeRecord[], updates: unknown[]
  const git = async (...args: string[]) => (await executeGit(args, { cwd: repo })).stdout.trim()
  const controller = (fail = false) => new WorktreeController({
    create: async record => { if (fail) throw new Error('persistence unavailable'); records.push(record) },
    update: async (_id, update) => { updates.push(update) },
  }, executeGit, join(root, 'worktrees'), root)
  const input = () => ({ ownerId: 'owner-a', projectId: 'project-a', taskId: 'task-a', repository: repo, baseRef: 'HEAD', expectedSha: sha, branch: 'feature/parallel' })
  beforeEach(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'subpolar-linked-')))
    repo = join(root, 'repo'); mkdirSync(repo)
    records = []; updates = []
    previousRoot = process.env.SUBPOLAR_PROJECTS_ROOT; process.env.SUBPOLAR_PROJECTS_ROOT = root
    await git('init', '-b', 'main'); await git('config', 'user.name', 'Worktree Test'); await git('config', 'user.email', 'test@example.invalid')
    writeFileSync(join(repo, 'file.txt'), 'base\n'); await git('add', '.'); await git('commit', '-m', 'base'); sha = await git('rev-parse', 'HEAD')
  })
  afterEach(() => {
    if (previousRoot === undefined) delete process.env.SUBPOLAR_PROJECTS_ROOT; else process.env.SUBPOLAR_PROJECTS_ROOT = previousRoot
    rmSync(root, { recursive: true, force: true })
  })
  it('creates a clean linked checkout pinned to the inspected SHA without modifying parent staging or tracking', async () => {
    await git('update-ref', 'refs/remotes/company/main', sha)
    await git('config', 'branch.autoSetupMerge', 'always')
    writeFileSync(join(repo, 'file.txt'), 'staged\n'); await git('add', 'file.txt')
    writeFileSync(join(repo, 'file.txt'), 'dirty\n'); writeFileSync(join(repo, 'untracked.txt'), 'private\n')
    const before = await git('status', '--porcelain=v1')
    const record = await controller().create({ ...input(), baseRef: 'refs/remotes/company/main' })
    expect(record.baseRef).toBe('refs/remotes/company/main'); expect(record.baseSha).toBe(sha)
    expect(readFileSync(join(record.path, 'file.txt'), 'utf8')).toBe('base\n')
    expect(existsSync(join(record.path, 'untracked.txt'))).toBe(false)
    expect(await git('status', '--porcelain=v1')).toBe(before)
    expect(await git('symbolic-ref', 'HEAD')).toBe('refs/heads/main')
    expect(await git('for-each-ref', '--format=%(upstream)', 'refs/heads/feature/parallel')).toBe('')
    expect(await git('worktree', 'list', '--porcelain')).toContain(record.path)
    await controller().remove(record); expect(existsSync(record.path)).toBe(false)
  })
  it('rejects a moved source and branch conflicts without resetting an existing branch', async () => {
    writeFileSync(join(repo, 'file.txt'), 'next\n'); await git('add', '.'); await git('commit', '-m', 'next')
    await expect(controller().create(input())).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(records).toHaveLength(0)
    sha = await git('rev-parse', 'HEAD'); await git('branch', 'feature/parallel')
    await expect(controller().create(input())).rejects.toThrow()
    expect(await git('rev-parse', 'feature/parallel')).toBe(sha)
    expect(records).toHaveLength(0)
  })
  it('refuses dirty removal, then removes normally after the user cleans the checkout', async () => {
    const record = await controller().create(input())
    writeFileSync(join(record.path, 'untracked.txt'), 'keep\n')
    writeFileSync(join(record.path, 'file.txt'), 'dirty\n')
    await expect(controller().remove(record)).rejects.toThrow()
    expect(readFileSync(join(record.path, 'untracked.txt'), 'utf8')).toBe('keep\n')
    expect(updates).toContainEqual(expect.objectContaining({ errorCode: 'WORKTREE_REMOVE_FAILED' }))
    expect(readFileSync(join(record.path, 'file.txt'), 'utf8')).toBe('dirty\n')
        rmSync(join(record.path, 'untracked.txt')); writeFileSync(join(record.path, 'file.txt'), 'base\n'); await controller().remove(record)
    expect(updates).toContainEqual(expect.objectContaining({ state: 'removed' }))
  })
  it('cleans a newly created worktree on persistence failure without deleting its branch', async () => {
    await expect(controller(true).create(input())).rejects.toThrow('persistence unavailable')
    expect(await git('worktree', 'list', '--porcelain')).not.toContain('feature/parallel')
    expect(await git('rev-parse', 'feature/parallel')).toBe(sha)
    expect(updates).toContainEqual(expect.objectContaining({ state: 'removed' }))
  })
  it('preserves a checkout dirtied during persistence failure and records the orphan for recovery', async () => {
    const failing = new WorktreeController({
      create: async record => { writeFileSync(join(record.path, 'keep.txt'), 'keep\n'); records.push(record); throw new Error('persistence unavailable') },
      update: async (_id, update) => { updates.push(update) },
    }, executeGit, join(root, 'worktrees'), root)
    await expect(failing.create(input())).rejects.toThrow('persistence unavailable')
    expect(readFileSync(join(records[0]!.path, 'keep.txt'), 'utf8')).toBe('keep\n')
    expect(await git('worktree', 'list', '--porcelain')).toContain(records[0]!.path)
    expect(updates).toContainEqual(expect.objectContaining({ state: 'active', errorCode: 'WORKTREE_PERSISTENCE_FAILED' }))
  })
  it('rejects path escapes and foreign removal scopes', async () => {
    await expect(controller().create({ ...input(), repository: '/outside' })).rejects.toThrow('outside')
    const record = await controller().create(input())
    await expect(controller().remove({ ...record, ownerId: 'owner-b' })).rejects.toThrow('not owned')
    expect(existsSync(record.path)).toBe(true)
  })
  it('rejects removal after an owner/task directory is redirected to another owner inside the workspace', async () => {
    const foreign = await controller().create({ ...input(), ownerId: 'owner-b', taskId: 'task-b' })
    mkdirSync(join(root, 'worktrees', 'owner-a'), { recursive: true })
    symlinkSync(join(root, 'worktrees', 'owner-b', 'task-b'), join(root, 'worktrees', 'owner-a', 'task-a'))
    await expect(controller().remove({ ...foreign, ownerId: 'owner-a', taskId: 'task-a', path: join(root, 'worktrees', 'owner-a', 'task-a', foreign.id) })).rejects.toThrow('not owned')
    expect(existsSync(foreign.path)).toBe(true)
  })
  it('returns only normalized provider identity in worktree sources', async () => {
    await git('remote', 'add', 'origin', 'https://alice:secret@github.com/acme/repo.git')
    const url = new URL('http://localhost/api/sessions/session-a/worktree-sources')
    const response = await handleSessionsRoute({ request: new Request(url.href), url, path: url.pathname.split('/').slice(1), authenticatedUser: { id: 'owner-a' }, gatewayCredential: null, internalRequest: false, deps: {
      applicationDatabase: async () => ({}),
      createProjectSessionRepository: () => ({ getSession: async (owner: string) => owner === 'owner-a' ? { projectId: 'project-a', directory: repo } : null, getProject: async (owner: string, id: string) => owner === 'owner-a' && id === 'project-a' ? { id, name: 'Repo', path: repo } : null }),
      json: (value: unknown, status = 200) => Response.json(value, { status }),
    } } as never)
    expect(response?.status).toBe(200)
    const body = await response!.json()
    expect(body).toMatchObject({ repositoryId: 'project-a', providerRepository: { remote: 'origin', provider: 'github', owner: 'acme', repo: 'repo' } })
    expect(JSON.stringify(body)).not.toMatch(/alice|secret|github\\.com/)
  })

  it('reports full refs, upstream names, SHAs and configured remote names without fetching', async () => {
    await git('remote', 'add', 'company', 'https://example.invalid/repository.git')
    await git('update-ref', 'refs/remotes/company/main', sha)
    await git('branch', '--set-upstream-to=company/main', 'main')
    const project = { id: 'project-a', userId: 'owner-a', name: 'Repo', path: repo, createdAt: 1, updatedAt: 1 }
    const policy = new GitPathPolicy(async owner => owner === 'owner-a' ? project : null, root)
    const result = await new GitReadService(policy).branches('owner-a', 'project-a')
    expect(result.remotes).toEqual(['company'])
    expect(result.branches).toContainEqual(expect.objectContaining({ ref: 'refs/heads/main', target: 'company/main', sha }))
    expect(result.branches).toContainEqual(expect.objectContaining({ ref: 'refs/remotes/company/main', remote: true, sha }))
    await expect(new GitReadService(policy).branches('owner-b', 'project-a')).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' })
  })
  function routeContext(action: string, input: unknown, gatewayCredential: unknown = null, owner = 'owner-a') {
    const url = new URL(`http://localhost/api/projects/project-a/repository/${action}`)
    return { request: new Request(url.href, { method: 'POST' }), url, path: url.pathname.split('/').slice(1), authenticatedUser: { id: owner }, gatewayCredential, internalRequest: false,
      deps: { applicationDatabase: async () => ({}), createProjectSessionRepository: () => ({ getProject: async (user: string) => user === 'owner-a' ? { id: 'project-a', name: 'Repo', path: repo } : null }), body: async () => input, json: (value: unknown, status = 200) => Response.json(value, { status }), redactedDiagnostic: () => 'redacted' },
    } as never
  }
  it('lists owned sibling worktrees without exposing another owner’s checkout', async () => {
    const own = await controller().create(input())
    const foreign = await controller().create({ ...input(), ownerId: 'owner-b', taskId: 'task-b', branch: 'feature/foreign' })
    const project = { id: 'project-a', userId: 'owner-a', name: 'Repo', path: repo, createdAt: 1, updatedAt: 1 }
    const policy = new GitPathPolicy(async owner => owner === 'owner-a' ? project : null, root, {}, async (owner, id, path) => records.some(record => record.ownerId === owner && record.projectId === id && record.path === path && record.state === 'active'))
    const result = await new GitReadService(policy).worktrees('owner-a', 'project-a')
    expect(result.worktrees).toContainEqual(expect.objectContaining({ branch: own.branch, head: sha }))
    expect(result.worktrees).not.toContainEqual(expect.objectContaining({ branch: foreign.branch }))
    expect(result.worktrees.find(record => record.branch === own.branch)?.path).toMatch(/^\.\.\/worktrees\/owner-a\//)
  })
  it('requires explicit user approval and denies gateway capability escalation', async () => {
    const response = await handleProjectsRoute(routeContext('worktrees', { ...input(), approved: false }))
    expect(response?.status).toBe(400); expect(await response?.json()).toMatchObject({ error: { code: 'APPROVAL_REQUIRED' } })
    const gateway = await handleProjectsRoute(routeContext('worktrees', { approved: true }, { id: 'tool-token' }))
    expect(gateway?.status).toBe(403)
    const foreign = await handleProjectsRoute(routeContext('worktrees', { approved: true }, null, 'owner-b'))
    expect(foreign?.status).toBe(404)
    expect(await git('worktree', 'list', '--porcelain')).not.toContain('feature/parallel')
  })
  it('registers the actual linked checkout as an owned repository through the creation route', async () => {
    const projects = [{ id: 'project-a', name: 'Repo', path: repo, hasAgentOverride: true, agentNames: ['master'] }]
    const stored = new Map<string, any>()
    const client = { collection: (name: string) => ({
      create: async (data: any) => { const row = { id: name === 'tasks' ? 'task-route' : 'audit-route', ...data }; stored.set(`${name}/${row.id}`, row); return row },
      update: async (id: string, data: any) => { const row = { ...stored.get(`${name}/${id}`), ...data }; stored.set(`${name}/${id}`, row); return row },
    }) }
    const url = new URL('http://localhost/api/projects/project-a/repository/worktrees')
    const response = await handleProjectsRoute({ request: new Request(url.href, { method: 'POST' }), url, path: url.pathname.split('/').slice(1), authenticatedUser: { id: 'owner-a' }, gatewayCredential: null, internalRequest: false, deps: {
      applicationDatabase: async () => client, body: async () => ({ branch: 'feature/route', sourceRef: 'HEAD', expectedSha: sha, approved: true }),
      createProjectSessionRepository: () => ({ getProject: async (owner: string, id: string) => owner === 'owner-a' ? projects.find(project => project.id === id) : null, listProjects: async () => projects,
        createProject: async (owner: string, data: any) => { expect(owner).toBe('owner-a'); const project = { id: 'linked-repo', ...data }; projects.push(project); return project },
      }), json: (value: unknown, status = 200) => Response.json(value, { status }), redactedDiagnostic: () => 'redacted',
    } } as never)
    expect(response?.status).toBe(201)
    const result = await response!.json() as { repositoryId: string; projectId: number; worktree: WorktreeRecord }
    expect(result.repositoryId).toBe('linked-repo'); expect(result.projectId).toBe(2)
    expect(projects[1]).toMatchObject({ path: result.worktree.path, agentNames: ['master'] })
    expect(readFileSync(join(result.worktree.path, 'file.txt'), 'utf8')).toBe('base\n')
    expect(stored.get('tasks/task-route')).toMatchObject({ worktree_id: result.worktree.id, owner_id: 'owner-a' })
    expect(await git('symbolic-ref', 'HEAD')).toBe('refs/heads/main')
  })
  it('removes the linked project when listing projects fails after worktree registration', async () => {
    const projects = [{ id: 'project-a', name: 'Repo', path: repo }]
    const stored = new Map<string, any>()
    let projectDeleted = false
    const client = { collection: (name: string) => ({
      create: async (data: any) => { const row = { id: name === 'tasks' ? 'task-cleanup' : 'audit-cleanup', ...data }; stored.set(`${name}/${row.id}`, row); return row },
      getOne: async (id: string) => { const row = stored.get(`${name}/${id}`); if (!row) throw new Error('not found'); return row },
      update: async (id: string, data: any) => { const row = { ...stored.get(`${name}/${id}`), ...data }; stored.set(`${name}/${id}`, row); return row },
      delete: async (id: string) => { stored.delete(`${name}/${id}`) },
    }) }
    const url = new URL('http://localhost/api/projects/project-a/repository/worktrees')
    const response = await handleProjectsRoute({ request: new Request(url.href, { method: 'POST' }), url, path: url.pathname.split('/').slice(1), authenticatedUser: { id: 'owner-a' }, gatewayCredential: null, internalRequest: false, deps: {
      applicationDatabase: async () => client, body: async () => ({ branch: 'feature/cleanup', sourceRef: 'HEAD', expectedSha: sha, approved: true }),
      createProjectSessionRepository: () => ({ getProject: async (owner: string, id: string) => owner === 'owner-a' ? projects.find(project => project.id === id) : null,
        createProject: async (_owner: string, data: any) => { const linked = { id: 'linked-cleanup', ...data }; projects.push(linked); return linked },
        listProjects: async () => { throw new Error('project listing unavailable') },
        deleteProject: async (_owner: string, id: string) => { projectDeleted = true; const index = projects.findIndex(project => project.id === id); if (index >= 0) projects.splice(index, 1); return true },
      }), json: (value: unknown, status = 200) => Response.json(value, { status }), redactedDiagnostic: () => 'redacted',
    } } as never)
    expect(response?.status).toBe(400)
    expect(projectDeleted).toBe(true)
    expect(projects).toHaveLength(1)
    expect(await git('worktree', 'list', '--porcelain')).not.toContain('feature/cleanup')
    expect(stored.get('tasks/task-cleanup')).toMatchObject({ state: 'cancelled', error_code: 'WORKTREE_CREATE_FAILED' })
  })
  it('reads current HEAD from the session’s registered linked checkout, not the primary checkout', async () => {
    const record = await controller().create(input())
    writeFileSync(join(record.path, 'file.txt'), 'linked\n')
    await executeGit(['add', '.'], { cwd: record.path }); await executeGit(['commit', '-m', 'linked'], { cwd: record.path })
    const linkedSha = (await executeGit(['rev-parse', 'HEAD'], { cwd: record.path })).stdout.trim()
    const url = new URL('http://localhost/api/sessions/linked-session/worktree-sources')
    let directory = record.path
    const context = { request: new Request(url.href), url, path: url.pathname.split('/').slice(1), authenticatedUser: { id: 'owner-a' }, gatewayCredential: null, internalRequest: false, deps: {
      applicationDatabase: async () => ({}), createProjectSessionRepository: () => ({
        getSession: async (owner: string) => owner === 'owner-a' ? { projectId: 'linked-repo', directory } : null,
        getProject: async (owner: string, id: string) => owner === 'owner-a' && id === 'linked-repo' ? { id, name: 'Linked', path: record.path } : null,
      }), json: (value: unknown, status = 200) => Response.json(value, { status }),
    } }
    const response = await handleSessionsRoute(context as never)
    expect(response?.status).toBe(200)
    expect(await response!.json()).toMatchObject({ repositoryId: 'linked-repo', repository: { head: linkedSha } })
    expect(await git('rev-parse', 'HEAD')).toBe(sha)
    directory = repo
    const mismatch = await handleSessionsRoute(context as never)
    expect(await mismatch!.json()).toMatchObject({ error: { code: 'PATH_DENIED' } })
    const foreign = await handleSessionsRoute({ ...context, authenticatedUser: { id: 'owner-b' } } as never)
    expect(foreign?.status).toBe(404)
  })
  it('fails remote refresh closed even when an arbitrary URL or helper is supplied', async () => {
    const response = await handleProjectsRoute(routeContext('refresh', { remote: 'ext::arbitrary', url: 'http://127.0.0.1' }))
    expect(await response?.json()).toMatchObject({ error: { code: 'UNSUPPORTED' } })
  })
  it('attaches a new session through the owned repository ID even if it is numeric-looking', async () => {
    const record = await controller().create(input())
    const project = { id: '123456789012345', name: 'Linked', path: record.path }
    const calls: unknown[] = []
    const url = new URL('http://localhost/api/sessions')
    let savedSession: any, linkedSession: string | undefined
    const repository = { listProjects: async () => [project], getProject: async (owner: string, id: string) => { calls.push([owner, id]); return id === project.id && owner === 'owner-a' ? project : null }, getSession: async () => savedSession, createSession: async (owner: string, data: any) => { calls.push(data); savedSession = { ...data, userId: owner }; return savedSession } }
    const context = { request: new Request(url.href, { method: 'POST' }), url, path: ['api', 'sessions'], authenticatedUser: { id: 'owner-a' }, gatewayCredential: null, internalRequest: false, deps: {
      body: async () => ({ repositoryId: project.id, worktreeId: record.id, permission: 'ask' }), applicationDatabase: async () => ({ collection: (name: string) => ({ getFirstListItem: async () => name === 'tasks' ? ({ id: 'task-a', worktree_id: record.id, project_id: record.projectId, session_id: linkedSession }) : ({ id: record.id, path: record.path, task_id: 'task-a', project_id: record.projectId }), update: async (_id: string, data: any) => { calls.push(data); linkedSession = data.session_id } }) }),
      createProjectSessionRepository: () => repository, listAgents: async () => [{ id: 'master-id', name: 'master', enabled: true }], generalChatProject: () => ({ id: 0, name: 'General Chat', path: root }), resolveNewSessionRoute, NewSessionRouteError,
      getUserPreferences: async () => null, preferenceModel: () => undefined, modelSelection: () => undefined, validateModelSelection: async () => undefined, mkdirSync, ensureUserMetadata: async () => undefined, sessions: [], saveState: async () => undefined, rpcSession: () => undefined, escapeFilter: (s: string) => s,
      storedSessionResponse: (session: unknown) => session, json: (value: unknown, status = 200) => Response.json(value, { status }),
    } }
    const response = await handleSessionsRoute(context as never)
    expect(response?.status).toBe(201)
    expect(calls).toContainEqual(['owner-a', project.id])
    expect(calls).toContainEqual(expect.objectContaining({ directory: record.path, projectId: project.id, worktreeId: record.id, permissionOverride: 'ask' }))
    expect(calls).toContainEqual(expect.objectContaining({ session_id: expect.any(String) }))
    const retried = await handleSessionsRoute(context as never)
    expect(retried?.status).toBe(200)
    expect(await response!.json()).toMatchObject({ session: { id: savedSession.id, directory: record.path, worktreeId: record.id } })
    expect(calls.filter(call => typeof call === 'object' && call !== null && 'directory' in call)).toHaveLength(1)
  })
  it('rejects attachments to the primary checkout or invalid task linkage before creating a session', async () => {
    const record = await controller().create(input())
    const url = new URL('http://localhost/api/sessions')
    let projectPath = repo, taskWorktree = record.id
    const calls: unknown[] = []
    const context = { request: new Request(url.href, { method: 'POST' }), url, path: ['api', 'sessions'], authenticatedUser: { id: 'owner-a' }, gatewayCredential: null, internalRequest: false, deps: {
      body: async () => ({ repositoryId: 'linked-repo', worktreeId: record.id }),
      applicationDatabase: async () => ({ collection: (name: string) => ({ getFirstListItem: async () => name === 'tasks' ? { worktree_id: taskWorktree, project_id: record.projectId } : { id: record.id, path: record.path, task_id: 'task-a', project_id: record.projectId } }) }),
      createProjectSessionRepository: () => ({ listProjects: async () => [{ id: 'linked-repo', name: 'Linked', path: projectPath }], getProject: async () => ({ id: 'linked-repo', name: 'Linked', path: projectPath }), createSession: async () => { calls.push('created') } }),
      listAgents: async () => [{ id: 'master-id', name: 'master', enabled: true }], generalChatProject: () => ({ id: 0, name: 'General Chat', path: root }), resolveNewSessionRoute, NewSessionRouteError,
      escapeFilter: (s: string) => s, json: (value: unknown, status = 200) => Response.json(value, { status }),
    } }
    expect((await handleSessionsRoute(context as never))?.status).toBe(403)
    projectPath = record.path; taskWorktree = 'foreign-worktree'
    expect((await handleSessionsRoute(context as never))?.status).toBe(403)
    expect(calls).toEqual([])
  })
})
