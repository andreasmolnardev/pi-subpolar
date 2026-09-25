import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'

const routeModules = [
  'auth',
  'gateway',
  'automations',
  'inbox',
  'notifications',
  'agents',
  'tasks',
  'browser',
  'providers',
  'runtime',
  'projects',
  'legacy',
  'tools',
  'settings',
  'sessions',
  'extensions',
].map((name) => readFileSync(join(import.meta.dir, 'routes', `${name}.ts`), 'utf8'))
const bridge = [
  readFileSync(join(import.meta.dir, '..', 'bridge.ts'), 'utf8'),
  readFileSync(join(import.meta.dir, '..', 'bridge-runtime.ts'), 'utf8'),
  readFileSync(join(import.meta.dir, 'bridge-request-handler.ts'), 'utf8'),
  ...routeModules,
].join('\n')
const piSession = readFileSync(join(import.meta.dir, 'pi-sdk-session.ts'), 'utf8')

function section(start: string, end: string, source = bridge): string {
  const begin = source.indexOf(start)
  const finish = source.indexOf(end, begin)
  expect(begin).toBeGreaterThanOrEqual(0)
  expect(finish).toBeGreaterThan(begin)
  return source.slice(begin, finish).replaceAll('deps.', '')
}

describe('bridge model delivery ordering', () => {
  it('does not persist a requested model until set_model succeeds', () => {
    const messagePost = section("path.length === 4 && path[3] === 'messages' && request.method === 'POST'", "path.length === 4 && path[3] === 'runs' && request.method === 'POST'")
    const run = section("path.length === 4 && path[3] === 'runs' && request.method === 'POST'", "path.length === 4 && path[3] === 'state' && request.method === 'GET'")

    expect(messagePost).not.toContain('model: record.model')
    expect(messagePost).toContain('profile: context.agentName')
    expect(run.indexOf("await sendRpc(id, { type: 'set_model'"))
      .toBeLessThan(run.indexOf('await persistSessionModel('))
    expect(run).toContain('await store.interruptMessageDelivery(claimedDelivery)')
  })

  it('fails closed when subagent parent capabilities are omitted or empty', () => {
    const runner = section('configureSubagentToolRunner(async (rawInput, context) => {', 'return subagentController!.run({')
    expect(runner).toContain('context.capabilities?.length ? context.capabilities : declaredParentCapabilities')
    expect(runner).toContain(": ['read']")
    expect(runner).not.toContain("context.capabilities ?? ['subagent/run', 'read', 'write', 'bash']")
    expect(runner).toContain('configuredParent.policies.subagent === true')
    expect(runner).toContain('configuredParent.policies.builtin[capability] === true')
  })

  it('keeps queue routes behind the owned session lookup and separates steer from follow-up', () => {
    const sessionRoutes = section("if (path[1] === 'sessions' && path.length >= 3)", "if (path[1] === 'extensions'")
    expect(sessionRoutes.indexOf('const ownedRecord =')).toBeLessThan(sessionRoutes.indexOf("path[3] === 'steer'"))
    expect(sessionRoutes).toContain("type: 'steer'")
    expect(bridge).toContain('store.claimQueueEntry')
    expect(sessionRoutes).toContain("await store.updateQueueEntry(ownerId, id, clientId, 'steering')")
    expect(sessionRoutes).toContain("'follow_up'")
    expect(sessionRoutes).toContain("clientId === 'clear'")
  })

  it('uses the automation repository for serialized cancellation and rejects ownership PATCH fields', () => {
    const automationRoutes = section("if (path[1] === 'automations' && authenticatedUser)", "if (path[1] === 'inbox' && authenticatedUser)")
    expect(automationRoutes).toContain("serializationScope: 'process'")
    expect(automationRoutes).toContain('automations.cancelRun')
    expect(automationRoutes).toContain('automationWorkerFor(client).execute')
    expect(automationRoutes).toContain('automationWorkerFor(client).executeDue()')
    expect(automationRoutes).toContain('Unsupported automation field')
    expect(automationRoutes).not.toContain("automation_runs').update")
    expect(bridge).toContain('automationWorkerFor(client).executeDue()')
  })

  it('dispatches path-specific run cancellation without reading a request body', () => {
    const automationRoutes = section("if (path[1] === 'automations' && authenticatedUser)", "if (path[1] === 'inbox' && authenticatedUser)")
    const cancelRoute = section("path.length === 4 && path[3] === 'cancel'", "path.length === 4 && path[3] === 'history'")

    expect(cancelRoute).toContain("path.length === 6 && path[3] === 'runs' && path[5] === 'cancel'")
    expect(cancelRoute).toContain("path.length === 6 ? decodeURIComponent(path[4]) : (await body(request)).run_id")
    expect(cancelRoute.indexOf('const runId =')).toBeLessThan(cancelRoute.indexOf('const run = await client.collection'))
    expect(cancelRoute).toContain('run.owner_id !== authenticatedUser.id')
    expect(automationRoutes.match(/path\.length === 6 && path\[3\] === 'runs' && path\[5\] === 'cancel'/g)).toHaveLength(1)
  })

  it('validates trigger keys before creating an automation run', () => {
    const automationRoutes = section("if (path[1] === 'automations' && authenticatedUser)", "if (path[1] === 'inbox' && authenticatedUser)")
    expect(automationRoutes).toContain("const key = input.trigger_key === undefined ? `manual:${Date.now()}` : validateTriggerKey(input.trigger_key)")
    expect(automationRoutes).toContain('validateTriggerKey(input.trigger_key)')
    expect(bridge).toContain("const TRIGGER_KEY_ERROR = 'Invalid trigger_key'")
    expect(automationRoutes).toContain("'INVALID_TRIGGER_KEY'")
    expect(bridge).toContain('value.length > 128')
    expect(bridge).toContain('SECRET_LIKE_TRIGGER_KEY')
  })
})

describe('session pagination route', () => {
  it('bounds and stabilizes the session page before returning legacy sessions', () => {
    const route = section("if (path[1] === 'sessions' && path.length === 2 && request.method === 'GET')", "if (path[1] === 'sessions' && path.length === 2 && request.method === 'POST')")
    expect(bridge).toContain('SESSION_PAGE_MAX_LIMIT')
    expect(route).toContain('updatedAt: last.updatedAt')
    expect(route).toContain('a.id.localeCompare(b.id)')
    expect(route).toContain('hasNext: Boolean(nextCursor)')
    expect(route).toContain('repository.listSessions(authenticatedUser!.id')
    expect(route).toContain('session.title')
  })

  it('rejects malformed cursors before querying session records', () => {
    const route = section("if (path[1] === 'sessions' && path.length === 2 && request.method === 'GET')", "if (path[1] === 'sessions' && path.length === 2 && request.method === 'POST')")
    expect(route.indexOf("if (requestedCursor && !cursor) return json")).toBeLessThan(route.indexOf('repository.listSessions'))
    expect(route).toContain("const project = cursor?.project ?? url.searchParams.get('project')")
  })

  it('normalizes and validates owner-scoped session tags on create and patch', () => {
    const routes = section("if (path[1] === 'sessions' && path.length === 2 && request.method === 'POST')", "if (path[1] === 'sessions' && path.length >= 3)")
    expect(routes).toContain('normalizeSessionTags(input.tags)')
    expect(routes).toContain('InvalidSessionTagsError')
    expect(routes).toContain('tags,')

    const sessionRoutes = section("if (path[1] === 'sessions' && path.length >= 3)", "if (path[1] === 'extensions'")
    expect(sessionRoutes).toContain('getSessionById(id)')
    expect(sessionRoutes).toContain('normalizeSessionTags(input.tags)')
    expect(sessionRoutes.indexOf('updateSession(ownerId, id')).toBeLessThan(sessionRoutes.indexOf('record.tags = updated.tags'))
  })
})

describe('durable skill routes', () => {
  it('does not write skill CRUD data to the filesystem', () => {
    const routes = section("if (path[1] === 'settings' && path[2] === 'skills' && authenticatedUser)", "if (path[1] === 'sessions'")
    expect(routes).toContain('createOwnerBoundSkillStore')
    expect(routes).toContain('SkillConflictError')
    expect(routes).not.toContain('writeFileSync')
    expect(routes).not.toContain('mkdirSync')
  })

  it('injects an owner-bound durable skill repository and redacted audit sink into Pi runtime loading', () => {
    const initialization = section('private async initialize(): Promise<void> {', 'private async openOrCreateSession(): Promise<SessionManager>', piSession)
    const host = section('const piSdkSessionHost:', 'function createPiSession')
    expect(initialization).toContain('host.loadRuntime(client, userId, context)')
    expect(host).toContain('createOwnerBoundSkillStore(client, userId)')
    expect(host).toContain('createSkillContextAudit(client)')
    expect(host).toContain('skillRepository:')
    expect(host).toContain('skillAudit:')
    expect(host).toContain('context.session?.project')
    expect(initialization).not.toContain('readSkills')
  })
})
