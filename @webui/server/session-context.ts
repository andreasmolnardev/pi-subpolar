import { isAbsolute, relative, resolve, sep, dirname } from 'node:path'
import { realpath } from 'node:fs/promises'

export type PermissionOverride = 'ask' | 'none' | 'allow_all'

export type SessionRecord = {
  id: string
  project: string
  title: string
  createdAt: number
  updatedAt: number
  archived?: boolean
  profile?: string
  model?: string
  directory?: string
  userId?: string
  permissionOverride?: PermissionOverride
}

export type ProjectRecord = {
  name: string
  path: string
}

export type AgentRecord = {
  id: string
  user_id: string
  name: string
  enabled?: boolean
  [key: string]: unknown
}

export type TrustedIdentity = string | {
  id?: unknown
  userId?: unknown
  user_id?: unknown
}

export type SessionContextRequest = {
  /** The authenticated identity. This must come from the server auth layer. */
  identity: TrustedIdentity
  /** Optional values are request hints and are never used as the source of identity. */
  userId?: unknown
  sessionId?: unknown
  project?: unknown
  projectName?: unknown
  projectDirectory?: unknown
  projectPath?: unknown
  cwd?: unknown
  directory?: unknown
  agent?: unknown
  agentName?: unknown
  agentId?: unknown
  permission?: unknown
  permissionOverride?: unknown
}

export type SessionContextStore = {
  getSession: (sessionId: string) => SessionRecord | null | undefined | Promise<SessionRecord | null | undefined>
  getProject: (projectName: string) => ProjectRecord | null | undefined | Promise<ProjectRecord | null | undefined>
}

export type AgentContextStore = {
  getAgent: (userId: string, nameOrId: string) => AgentRecord | null | undefined | Promise<AgentRecord | null | undefined>
}

export type PermissionContext = {
  override: PermissionOverride
  sessionOverride?: PermissionOverride
  requestedOverride?: PermissionOverride
  source: 'session' | 'request' | 'default'
}

export type ResolvedSessionContext = {
  identity: { userId: string }
  sessionId?: string
  session: SessionRecord | null
  project: ProjectRecord
  projectDirectory: string
  cwd: string
  agent: AgentRecord
  agentId: string
  agentName: string
  permission: PermissionContext
  permissionOverride: PermissionOverride
}

export type SessionContextErrorCode =
  | 'INVALID_IDENTITY'
  | 'IDENTITY_MISMATCH'
  | 'INVALID_REQUEST'
  | 'SESSION_NOT_FOUND'
  | 'SESSION_NOT_OWNED'
  | 'SESSION_PROJECT_MISMATCH'
  | 'SESSION_CWD_MISMATCH'
  | 'PROJECT_NOT_FOUND'
  | 'PROJECT_DIRECTORY_MISMATCH'
  | 'INVALID_PROJECT_DIRECTORY'
  | 'INVALID_SESSION_DIRECTORY'
  | 'AGENT_NOT_FOUND'
  | 'AGENT_NOT_OWNED'
  | 'AGENT_DISABLED'
  | 'INVALID_AGENT'
  | 'SESSION_AGENT_MISMATCH'
  | 'PERMISSION_MISMATCH'
  | 'INVALID_PERMISSION'

export class SessionContextError extends Error {
  readonly name = 'SessionContextError'

  constructor(
    readonly code: SessionContextErrorCode,
    message: string,
  ) {
    super(message)
  }
}

export type SessionContextDependencies = {
  sessions: SessionContextStore
  agents: AgentContextStore
  /** Defaults to path.resolve. Use realpath/realpathSync-backed logic when symlinks must be collapsed. */
  canonicalizePath?: (value: string) => string | Promise<string>
  /** Override only when the application has a deliberate, safe workspace layout (for example General Chat). */
  isAllowedCwd?: (projectDirectory: string, cwd: string, session: SessionRecord | null) => boolean | Promise<boolean>
  defaultAgentName?: string
  defaultPermissionOverride?: PermissionOverride
}

const DEFAULT_AGENT_NAME = 'master'
const DEFAULT_PERMISSION_OVERRIDE: PermissionOverride = 'ask'

export function createSessionContextResolver(dependencies: SessionContextDependencies): SessionContextResolver {
  return new SessionContextResolver(dependencies)
}

export class SessionContextResolver {
  private readonly canonicalizePath: (value: string) => string | Promise<string>
  private readonly isAllowedCwd: (projectDirectory: string, cwd: string, session: SessionRecord | null) => boolean | Promise<boolean>
  private readonly defaultAgentName: string
  private readonly defaultPermissionOverride: PermissionOverride

  constructor(private readonly dependencies: SessionContextDependencies) {
    this.canonicalizePath = dependencies.canonicalizePath ?? realpathAwarePath
    this.isAllowedCwd = dependencies.isAllowedCwd ?? ((projectDirectory, cwd) => isWithin(projectDirectory, cwd))
    this.defaultAgentName = nonBlank(dependencies.defaultAgentName) ?? DEFAULT_AGENT_NAME
    this.defaultPermissionOverride = dependencies.defaultPermissionOverride ?? DEFAULT_PERMISSION_OVERRIDE
  }

  async resolve(request: SessionContextRequest): Promise<ResolvedSessionContext> {
    const userId = identityUserId(request.identity)
    const hintedUserId = optionalRequestString(request.userId, 'userId')
    if (hintedUserId !== undefined && hintedUserId !== userId) {
      throw new SessionContextError('IDENTITY_MISMATCH', 'Request userId does not match the authenticated identity')
    }

    const sessionId = optionalRequestString(request.sessionId, 'sessionId')
    const session = sessionId === undefined ? null : await this.dependencies.sessions.getSession(sessionId) ?? null
    if (sessionId !== undefined && !session) {
      throw new SessionContextError('SESSION_NOT_FOUND', 'Session was not found')
    }
    if (session && (session.id !== sessionId || !nonBlank(session.project) || !nonBlank(session.userId)
      || (session.profile !== undefined && !nonBlank(session.profile))
      || (session.directory !== undefined && typeof session.directory !== 'string'))) {
      throw new SessionContextError('SESSION_NOT_FOUND', 'Session was not found')
    }
    if (session && session.userId !== userId) {
      throw new SessionContextError('SESSION_NOT_OWNED', 'Session was not found')
    }
    if (session && session.permissionOverride !== undefined && !isPermission(session.permissionOverride)) {
      throw new SessionContextError('INVALID_PERMISSION', 'Session permission override is invalid')
    }

    const requestedProject = oneStringAlias(request, ['project', 'projectName'], 'project')
    if (session && requestedProject !== undefined && requestedProject !== session.project) {
      throw new SessionContextError('SESSION_PROJECT_MISMATCH', 'Requested project does not match the session')
    }
    const projectName = session?.project ?? requestedProject
    if (!projectName) {
      throw new SessionContextError('INVALID_REQUEST', 'A project is required when sessionId is not supplied')
    }

    const storedProject = await this.dependencies.sessions.getProject(projectName) ?? null
    if (!storedProject || storedProject.name !== projectName || !nonBlank(storedProject.path)) {
      throw new SessionContextError('PROJECT_NOT_FOUND', 'Project was not found')
    }
    const projectDirectory = await this.path(storedProject.path, 'INVALID_PROJECT_DIRECTORY')

    const requestedProjectDirectory = oneStringAlias(request, ['projectDirectory', 'projectPath'], 'projectDirectory')
    if (requestedProjectDirectory !== undefined) {
      const canonicalRequestedProjectDirectory = await this.path(requestedProjectDirectory, 'INVALID_PROJECT_DIRECTORY')
      if (canonicalRequestedProjectDirectory !== projectDirectory) {
        throw new SessionContextError('PROJECT_DIRECTORY_MISMATCH', 'Requested project directory does not match the project')
      }
    }

    const requestedCwd = oneStringAlias(request, ['cwd', 'directory'], 'cwd')
    const storedCwd = session?.directory
    const cwd = await this.path(storedCwd ?? requestedCwd ?? projectDirectory, 'INVALID_SESSION_DIRECTORY')
    if (session && requestedCwd !== undefined) {
      const canonicalRequestedCwd = await this.path(requestedCwd, 'INVALID_SESSION_DIRECTORY')
      if (canonicalRequestedCwd !== cwd) {
        throw new SessionContextError('SESSION_CWD_MISMATCH', 'Requested cwd does not match the session')
      }
    }
    if (!await this.isAllowedCwd(projectDirectory, cwd, session)) {
      throw new SessionContextError('INVALID_SESSION_DIRECTORY', 'Session cwd is outside the project directory')
    }

    const requestedAgent = oneStringAlias(request, ['agent', 'agentName', 'agentId'], 'agent')
    const agentSelector = session?.profile ?? requestedAgent ?? this.defaultAgentName
    const agent = await this.dependencies.agents.getAgent(userId, agentSelector) ?? null
    if (!agent) {
      throw new SessionContextError('AGENT_NOT_FOUND', 'Agent was not found')
    }
    if (agent.user_id !== userId) {
      throw new SessionContextError('AGENT_NOT_OWNED', 'Agent was not found')
    }
    if (!nonBlank(agent.id) || !nonBlank(agent.name)) {
      throw new SessionContextError('INVALID_AGENT', 'Agent record is invalid')
    }
    if (agent.enabled === false) {
      throw new SessionContextError('AGENT_DISABLED', 'Agent is disabled')
    }
    if (session?.profile && requestedAgent !== undefined && !matchesAgentSelector(requestedAgent, session.profile, agent)) {
      throw new SessionContextError('SESSION_AGENT_MISMATCH', 'Requested agent does not match the session')
    }
    if (session && session.profile && !matchesAgentSelector(session.profile, agent.name, agent)) {
      throw new SessionContextError('SESSION_AGENT_MISMATCH', 'Session agent does not match the resolved agent')
    }

    const requestedPermission = permissionAlias(request)
    const sessionPermission = session?.permissionOverride
    if (sessionPermission !== undefined && requestedPermission !== undefined && requestedPermission !== sessionPermission) {
      throw new SessionContextError('PERMISSION_MISMATCH', 'Requested permission does not match the session')
    }
    const effectivePermission = sessionPermission ?? requestedPermission ?? this.defaultPermissionOverride
    const permission: PermissionContext = {
      override: effectivePermission,
      ...(sessionPermission ? { sessionOverride: sessionPermission } : {}),
      ...(requestedPermission ? { requestedOverride: requestedPermission } : {}),
      source: sessionPermission ? 'session' : requestedPermission ? 'request' : 'default',
    }

    return {
      identity: { userId },
      ...(sessionId ? { sessionId } : {}),
      session,
      project: { ...storedProject, path: projectDirectory },
      projectDirectory,
      cwd,
      agent,
      agentId: agent.id,
      agentName: agent.name,
      permission,
      permissionOverride: effectivePermission,
    }
  }

  private async path(value: string, invalidCode: 'INVALID_PROJECT_DIRECTORY' | 'INVALID_SESSION_DIRECTORY'): Promise<string> {
    try {
      const canonical = await this.canonicalizePath(value)
      if (typeof canonical !== 'string' || !isAbsolute(canonical)) throw new Error('Path must be absolute')
      return resolve(canonical)
    } catch {
      throw new SessionContextError(invalidCode, 'Context contains an invalid directory')
    }
  }
}

async function realpathAwarePath(value: string): Promise<string> {
  const absolute = resolve(value)
  try {
    return await realpath(absolute)
  } catch {
    const parent = dirname(absolute)
    if (parent === absolute) return absolute
    const remainder = parent === sep ? absolute.slice(1) : absolute.slice(parent.length + 1)
    return resolve(await realpathAwarePath(parent), remainder)
  }
}

export async function resolveSessionContext(
  request: SessionContextRequest,
  dependencies: SessionContextDependencies,
): Promise<ResolvedSessionContext> {
  return createSessionContextResolver(dependencies).resolve(request)
}

export type SqliteContextDatabase = {
  query: (sql: string) => { get: (...parameters: string[]) => unknown }
}

/** Adapts the bridge's local SQLite schema without making the resolver depend on Bun's SQLite types. */
export function createSqliteSessionContextStore(database: SqliteContextDatabase): SessionContextStore {
  return {
    getSession(sessionId) {
      const row = database.query('SELECT id, project, title, created_at, updated_at, archived, profile, model, directory, user_id, permission_override FROM sessions WHERE id = ? LIMIT 1').get(sessionId)
      return sessionFromRow(row)
    },
    getProject(projectName) {
      const row = database.query('SELECT name, path FROM projects WHERE name = ? LIMIT 1').get(projectName)
      return projectFromRow(row)
    },
  }
}

function sessionFromRow(value: unknown): SessionRecord | null {
  if (!isObject(value)) return null
  const id = nonBlank(value.id)
  const project = nonBlank(value.project)
  const title = typeof value.title === 'string' ? value.title : undefined
  const createdAt = finiteNumber(value.created_at)
  const updatedAt = finiteNumber(value.updated_at)
  if (!id || !project || title === undefined || createdAt === undefined || updatedAt === undefined) return null
  if (value.permission_override !== null && value.permission_override !== undefined && !isPermission(value.permission_override)) return null
  return {
    id,
    project,
    title,
    createdAt,
    updatedAt,
    ...(value.archived === true || value.archived === 1 ? { archived: true } : {}),
    ...(nonBlank(value.profile) ? { profile: String(value.profile) } : {}),
    ...(typeof value.model === 'string' ? { model: value.model } : {}),
    ...(typeof value.directory === 'string' ? { directory: value.directory } : {}),
    ...(nonBlank(value.user_id) ? { userId: String(value.user_id) } : {}),
    ...(isPermission(value.permission_override) ? { permissionOverride: value.permission_override } : {}),
  }
}

function projectFromRow(value: unknown): ProjectRecord | null {
  if (!isObject(value) || !nonBlank(value.name) || !nonBlank(value.path)) return null
  return { name: String(value.name), path: String(value.path) }
}

function identityUserId(identity: TrustedIdentity): string {
  if (typeof identity === 'string') {
    const userId = nonBlank(identity)
    if (userId) return userId
  } else if (isObject(identity)) {
    const supplied = [identity.userId, identity.id, identity.user_id].filter((value) => value !== undefined && value !== null)
    if (supplied.some((value) => typeof value !== 'string' || !nonBlank(value))) {
      throw new SessionContextError('INVALID_IDENTITY', 'Authenticated identity contains an invalid user ID')
    }
    const candidates = supplied as string[]
    if (candidates.length > 0 && candidates.every((candidate) => candidate === candidates[0])) return candidates[0]
    if (candidates.length > 0) throw new SessionContextError('INVALID_IDENTITY', 'Authenticated identity contains conflicting user IDs')
  }
  throw new SessionContextError('INVALID_IDENTITY', 'An authenticated identity is required')
}

function optionalRequestString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || !nonBlank(value)) {
    throw new SessionContextError('INVALID_REQUEST', `${field} must be a non-empty string`)
  }
  return value
}

function oneStringAlias(request: SessionContextRequest, fields: string[], label: string): string | undefined {
  let selected: string | undefined
  for (const field of fields) {
    const value = optionalRequestString(request[field as keyof SessionContextRequest], field)
    if (value === undefined) continue
    if (selected !== undefined && selected !== value) {
      throw new SessionContextError('INVALID_REQUEST', `Conflicting ${label} values were supplied`)
    }
    selected = value
  }
  return selected
}

function permissionAlias(request: SessionContextRequest): PermissionOverride | undefined {
  const values = ['permission', 'permissionOverride'].map((field) => request[field as keyof SessionContextRequest]).filter((value) => value !== undefined && value !== null)
  if (values.length === 0) return undefined
  if (values.some((value) => !isPermission(value))) {
    throw new SessionContextError('INVALID_PERMISSION', 'Permission override is invalid')
  }
  const permissions = values as PermissionOverride[]
  if (permissions.some((value) => value !== permissions[0])) {
    throw new SessionContextError('PERMISSION_MISMATCH', 'Conflicting permission overrides were supplied')
  }
  return permissions[0]
}

function matchesAgentSelector(selector: string, expected: string, agent: AgentRecord): boolean {
  return selector === expected || selector === agent.id || selector === agent.name
}

function isPermission(value: unknown): value is PermissionOverride {
  return value === 'ask' || value === 'none' || value === 'allow_all'
}

function nonBlank(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isWithin(root: string, candidate: string): boolean {
  const child = relative(root, candidate)
  return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child))
}
