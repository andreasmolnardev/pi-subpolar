import { existsSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import PocketBase, { type RecordModel } from 'pocketbase'
import { assertPathWithinWorkspace, isPathWithin } from './project-filesystem.ts'

/** The two collections owned by this repository. */
export const PROJECTS_COLLECTION = 'projects'
export const SESSIONS_COLLECTION = 'sessions'
export const GENERAL_CHAT_NAME = 'General Chat'

export type PermissionOverride = 'ask' | 'none' | 'allow_all'

/** The shape used by the existing bridge for project definitions. */
export type ProjectDefinition = {
  name: string
  path: string
}

/** A project record returned by PocketBase. */
export type ProjectRecord = ProjectDefinition & {
  id: string
  userId: string
  createdAt: number
  updatedAt: number
}

/** The shape used by the existing bridge for session metadata. */
export type SessionRecord = {
  /** The Pi session id, not PocketBase's record id. */
  id: string
  project: string
  title: string
  createdAt: number
  updatedAt: number
  archived?: boolean
  profile?: string
  model?: string
  directory?: string
  userId: string
  permissionOverride?: PermissionOverride
  /** Empty for General Chat or an orphaned legacy project. */
  projectId?: string
}

/** A session record with its PocketBase record id retained for diagnostics/updating. */
export type StoredSessionRecord = SessionRecord & {
  recordId: string
}

/** A context that has been checked against both the session and project owner. */
export type SessionContext = {
  session: StoredSessionRecord
  project: ProjectRecord | null
  /** General Chat has no row in the projects collection. */
  isGeneralChat: boolean
}

export type CreateProjectInput = ProjectDefinition
export type UpdateProjectInput = Partial<ProjectDefinition>

export type CreateSessionInput = {
  /** Supply the id found in Pi's JSONL header when creating metadata for a transcript. */
  id?: string
  projectId?: string | null
  project?: string
  title?: string
  createdAt?: number
  updatedAt?: number
  archived?: boolean
  profile?: string
  model?: string
  directory?: string
  permissionOverride?: PermissionOverride
  /** Migration-only escape hatch for a session whose project definition was absent. */
  allowOrphanProject?: boolean
}

export type UpdateSessionInput = Partial<Omit<CreateSessionInput, 'id'>>

export class ProjectPathConflictError extends Error {
  readonly code = 'PROJECT_PATH_CONFLICT'

  constructor() {
    super('Project path is already owned by another user')
    this.name = 'ProjectPathConflictError'
  }
}

export type ListSessionsOptions = {
  projectId?: string
  project?: string
  includeArchived?: boolean
}

export type LegacyProjectDefinition = ProjectDefinition
export type LegacySessionRecord = Omit<SessionRecord, 'userId'> & { userId?: string }

export type MigrationIssue = {
  kind: 'project' | 'session'
  key: string
  reason: string
}

export type MigrationResult<T> = {
  migrated: T[]
  skipped: MigrationIssue[]
}

export type LegacyMetadata = {
  projects?: readonly unknown[]
  sessions?: readonly unknown[]
}

/**
 * Collection declarations are exported for deployment tooling and tests. Existing
 * collections are only extended with missing fields; incompatible fields are never
 * silently changed.
 */
export const PROJECT_SESSION_SCHEMA = {
  projects: {
    fields: [
      { name: 'user_id', type: 'text', required: true },
      { name: 'name', type: 'text', required: true },
      { name: 'path', type: 'text', required: true },
      { name: 'created_at', type: 'number', required: true },
      { name: 'updated_at', type: 'number', required: true },
    ],
    indexes: [
      'CREATE UNIQUE INDEX idx_projects_user_name ON projects (user_id, name)',
    ],
  },
  sessions: {
    fields: [
      { name: 'user_id', type: 'text', required: true },
      // This is deliberately separate from PocketBase's short record id.
      { name: 'session_id', type: 'text', required: true },
      // Empty means General Chat or a legacy session whose project was unavailable.
      { name: 'project_id', type: 'text' },
      { name: 'project_name', type: 'text', required: true },
      { name: 'title', type: 'text', required: true },
      { name: 'created_at', type: 'number', required: true },
      { name: 'updated_at', type: 'number', required: true },
      { name: 'archived', type: 'bool' },
      { name: 'profile', type: 'text' },
      { name: 'model', type: 'text' },
      { name: 'directory', type: 'text' },
      { name: 'permission_override', type: 'select', values: ['ask', 'none', 'allow_all'], maxSelect: 1 },
    ],
    indexes: [
      'CREATE UNIQUE INDEX idx_sessions_user_session ON sessions (user_id, session_id)',
      'CREATE INDEX idx_sessions_user_updated ON sessions (user_id, updated_at)',
      'CREATE INDEX idx_sessions_user_project ON sessions (user_id, project_id)',
    ],
  },
} as const

type PocketBaseField = Record<string, unknown>
type CollectionRecord = RecordModel & Record<string, unknown>
type CollectionManager = {
  getOne: (idOrName: string) => Promise<CollectionRecord>
  create: (data: Record<string, unknown>) => Promise<CollectionRecord>
  update: (id: string, data: Record<string, unknown>) => Promise<CollectionRecord>
}

type RepositoryCollection = {
  getFirstListItem: (filter: string, options?: Record<string, unknown>) => Promise<CollectionRecord>
  getFullList: (options?: Record<string, unknown>) => Promise<CollectionRecord[]>
  create: (data: Record<string, unknown>) => Promise<CollectionRecord>
  update: (id: string, data: Record<string, unknown>) => Promise<CollectionRecord>
  delete: (id: string) => Promise<boolean>
}

function collection(client: PocketBase, name: string): RepositoryCollection {
  return client.collection(name) as unknown as RepositoryCollection
}

function collectionManager(client: PocketBase): CollectionManager {
  return client.collections as unknown as CollectionManager
}

function escapeFilterValue(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
}

/** Escape a value for a PocketBase equality filter. Field names are never caller supplied. */
export function pocketBaseEquals(field: string, value: string): string {
  return `${field} = "${escapeFilterValue(value)}"`
}

function ownerFilter(userId: string): string {
  return pocketBaseEquals('user_id', userId)
}

function ownedRecordFilter(userId: string, field: string, value: string): string {
  return `${ownerFilter(userId)} && ${pocketBaseEquals(field, value)}`
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'status' in error && (error as { status?: unknown }).status === 404
}

async function firstOrNull<T>(operation: () => Promise<T>): Promise<T | null> {
  try {
    return await operation()
  } catch (error) {
    if (isNotFound(error)) return null
    throw error
  }
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`PocketBase ${field} is missing or invalid`)
  return value
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function numberField(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`PocketBase ${field} is missing or invalid`)
  return value
}

function projectFromRecord(value: CollectionRecord): ProjectRecord {
  const path = assertPathWithinWorkspace(requiredString(value.path, 'project path'))
  return {
    id: requiredString(value.id, 'project id'),
    userId: requiredString(value.user_id, 'project user_id'),
    name: requiredString(value.name, 'project name'),
    path,
    createdAt: numberField(value.created_at, 'project created_at'),
    updatedAt: numberField(value.updated_at, 'project updated_at'),
  }
}

function sessionFromRecord(value: CollectionRecord): StoredSessionRecord {
  const permission = optionalString(value.permission_override)
  if (permission !== undefined && permission !== 'ask' && permission !== 'none' && permission !== 'allow_all') {
    throw new Error('PocketBase session permission_override is invalid')
  }

  return {
    recordId: requiredString(value.id, 'session record id'),
    id: requiredString(value.session_id, 'session session_id'),
    userId: requiredString(value.user_id, 'session user_id'),
    project: requiredString(value.project_name, 'session project_name'),
    title: requiredString(value.title, 'session title'),
    createdAt: numberField(value.created_at, 'session created_at'),
    updatedAt: numberField(value.updated_at, 'session updated_at'),
    ...(value.archived === true ? { archived: true } : {}),
    ...(optionalString(value.profile) ? { profile: optionalString(value.profile) } : {}),
    ...(optionalString(value.model) ? { model: optionalString(value.model) } : {}),
    ...(optionalString(value.directory) ? { directory: optionalString(value.directory) } : {}),
    ...(permission ? { permissionOverride: permission } : {}),
    ...(optionalString(value.project_id) ? { projectId: optionalString(value.project_id) } : {}),
  }
}

function normalizeProjectInput(input: CreateProjectInput): CreateProjectInput {
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  const path = typeof input.path === 'string' ? input.path.trim() : ''
  if (!name) throw new Error('Project name is required')
  if (!path) throw new Error('Project path is required')
  if (name.toLocaleLowerCase() === GENERAL_CHAT_NAME.toLocaleLowerCase()) throw new Error('General Chat is reserved')
  return { name, path: assertPathWithinWorkspace(path) }
}

function normalizePermission(value: PermissionOverride | undefined): PermissionOverride | undefined {
  if (value === undefined) return undefined
  if (value !== 'ask' && value !== 'none' && value !== 'allow_all') throw new Error('Invalid permission override')
  return value
}

function timestamp(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) ? value : fallback
}

function projectData(userId: string, input: CreateProjectInput, now: number): Record<string, unknown> {
  const project = normalizeProjectInput(input)
  return { user_id: userId, name: project.name, path: project.path, created_at: now, updated_at: now }
}

function sessionData(userId: string, input: CreateSessionInput, now: number): Record<string, unknown> {
  const id = input.id?.trim() || randomUUID()
  const requestedProject = input.project?.trim() || GENERAL_CHAT_NAME
  const project = requestedProject.toLocaleLowerCase() === GENERAL_CHAT_NAME.toLocaleLowerCase() ? GENERAL_CHAT_NAME : requestedProject
  const title = input.title?.trim() || 'Untitled session'
  if (!id) throw new Error('Session id is required')
  if (!project) throw new Error('Session project is required')
  if (!title) throw new Error('Session title is required')
  const permission = normalizePermission(input.permissionOverride)
  return {
    user_id: userId,
    session_id: id,
    project_id: input.projectId?.trim() || '',
    project_name: project,
    title,
    created_at: timestamp(input.createdAt, now),
    updated_at: timestamp(input.updatedAt, now),
    archived: input.archived === true,
    profile: input.profile?.trim() || '',
    model: input.model?.trim() || '',
    directory: input.directory?.trim() ? resolve(input.directory) : '',
    permission_override: permission ?? '',
  }
}

function updateData(input: UpdateProjectInput | UpdateSessionInput): Record<string, unknown> {
  const data: Record<string, unknown> = {}
  if ('name' in input && input.name !== undefined) {
    const name = typeof input.name === 'string' ? input.name.trim() : ''
    if (!name || name.toLocaleLowerCase() === GENERAL_CHAT_NAME.toLocaleLowerCase()) throw new Error('Invalid project name')
    data.name = name
  }
  if ('path' in input && input.path !== undefined) {
    const path = typeof input.path === 'string' ? input.path.trim() : ''
    if (!path) throw new Error('Project path is required')
    data.path = assertPathWithinWorkspace(path)
  }
  return data
}

function sessionUpdateData(input: UpdateSessionInput): Record<string, unknown> {
  const data: Record<string, unknown> = {}
  if (input.projectId !== undefined) {
    data.project_id = input.projectId?.trim() || ''
    if (!input.projectId?.trim() && input.project === undefined) data.project_name = GENERAL_CHAT_NAME
  }
  if (input.project !== undefined) {
    const project = input.project.trim()
    if (!project) throw new Error('Session project is required')
    data.project_name = project
  }
  if (input.title !== undefined) {
    const title = input.title.trim()
    if (!title) throw new Error('Session title is required')
    data.title = title
  }
  if (input.createdAt !== undefined) data.created_at = timestamp(input.createdAt, Date.now())
  if (input.updatedAt !== undefined) data.updated_at = timestamp(input.updatedAt, Date.now())
  if (input.archived !== undefined) data.archived = input.archived
  if (input.profile !== undefined) data.profile = input.profile.trim()
  if (input.model !== undefined) data.model = input.model.trim()
  if (input.directory !== undefined) data.directory = input.directory.trim() ? resolve(input.directory) : ''
  if (input.permissionOverride !== undefined) data.permission_override = normalizePermission(input.permissionOverride) ?? ''
  return data
}

async function ensureCollection(
  client: PocketBase,
  name: string,
  fields: readonly PocketBaseField[],
  indexes: readonly string[],
): Promise<void> {
  const manager = collectionManager(client)
  const existing = await firstOrNull(() => manager.getOne(name))
  if (!existing) {
    try {
      await manager.create({ name, type: 'base', fields: [...fields], indexes: [...indexes] })
    } catch (error) {
      // Another bridge process may have created it between getOne and create.
      const raced = await firstOrNull(() => manager.getOne(name))
      if (!raced) throw error
      await extendCollection(manager, raced, fields, indexes)
    }
    return
  }
  await extendCollection(manager, existing, fields, indexes)
}

async function extendCollection(manager: CollectionManager, existing: CollectionRecord, fields: readonly PocketBaseField[], indexes: readonly string[]): Promise<void> {
  const currentFields = Array.isArray(existing.fields) ? existing.fields.filter((field): field is PocketBaseField => typeof field === 'object' && field !== null) : []
  const known = new Set(currentFields.map((field) => String(field.name)))
  const missing = fields.filter((field) => !known.has(String(field.name)))
  const currentIndexes = Array.isArray(existing.indexes) ? existing.indexes.filter((index): index is string => typeof index === 'string') : []
  const missingIndexes = indexes.filter((index) => !currentIndexes.includes(index))
  if (missing.length > 0 || missingIndexes.length > 0) {
    await manager.update(existing.id, {
      ...(missing.length > 0 ? { fields: [...currentFields, ...missing] } : {}),
      ...(missingIndexes.length > 0 ? { indexes: [...currentIndexes, ...missingIndexes] } : {}),
    })
  }
}

/** Ensure only the project/session collections, without changing other application collections. */
export async function ensureProjectSessionCollections(client: PocketBase): Promise<void> {
  await ensureCollection(client, PROJECTS_COLLECTION, PROJECT_SESSION_SCHEMA.projects.fields, PROJECT_SESSION_SCHEMA.projects.indexes)
  await ensureCollection(client, SESSIONS_COLLECTION, PROJECT_SESSION_SCHEMA.sessions.fields, PROJECT_SESSION_SCHEMA.sessions.indexes)
}

export class ProjectSessionRepository {
  constructor(readonly client: PocketBase) {}

  async ensureCollections(): Promise<void> {
    await ensureProjectSessionCollections(this.client)
  }

  async createProject(userId: string, input: CreateProjectInput): Promise<ProjectRecord> {
    assertOwner(userId)
    const now = Date.now()
    const project = normalizeProjectInput(input)
    await this.assertProjectPathAvailable(userId, project.path)
    return projectFromRecord(await collection(this.client, PROJECTS_COLLECTION).create(projectData(userId, project, now)))
  }

  /** Reject paths that overlap a project owned by a different user. */
  async assertProjectPathAvailable(userId: string, path: string, excludedProjectId?: string): Promise<void> {
    assertOwner(userId)
    const candidate = assertPathWithinWorkspace(path)
    const records = await collection(this.client, PROJECTS_COLLECTION).getFullList()
    for (const record of records) {
      const owner = String(record.user_id ?? '')
      if (!owner || owner === userId || String(record.id ?? '') === excludedProjectId) continue
      const other = assertPathWithinWorkspace(requiredString(record.path, 'project path'))
      if (isPathWithin(other, candidate) || isPathWithin(candidate, other)) throw new ProjectPathConflictError()
    }
  }

  async getProject(userId: string, projectId: string): Promise<ProjectRecord | null> {
    assertOwner(userId)
    const record = await firstOrNull(() => collection(this.client, PROJECTS_COLLECTION).getFirstListItem(ownedRecordFilter(userId, 'id', projectId)))
    return record ? projectFromRecord(record) : null
  }

  async listProjects(userId: string): Promise<ProjectRecord[]> {
    assertOwner(userId)
    const records = await collection(this.client, PROJECTS_COLLECTION).getFullList({ filter: ownerFilter(userId), sort: 'name' })
    return records.map(projectFromRecord)
  }

  async findProjectByName(userId: string, name: string): Promise<ProjectRecord | null> {
    assertOwner(userId)
    const normalized = name.trim()
    if (!normalized) return null
    const record = await firstOrNull(() => collection(this.client, PROJECTS_COLLECTION).getFirstListItem(ownedRecordFilter(userId, 'name', normalized)))
    return record ? projectFromRecord(record) : null
  }

  async updateProject(userId: string, projectId: string, input: UpdateProjectInput): Promise<ProjectRecord | null> {
    const existing = await this.getProject(userId, projectId)
    if (!existing) return null
    const data = updateData(input)
    if (typeof data.path === 'string') await this.assertProjectPathAvailable(userId, data.path, existing.id)
    data.updated_at = Date.now()
    const updated = await collection(this.client, PROJECTS_COLLECTION).update(existing.id, data)
    return projectFromRecord(updated)
  }

  async deleteProject(userId: string, projectId: string): Promise<boolean> {
    const existing = await this.getProject(userId, projectId)
    if (!existing) return false
    await collection(this.client, PROJECTS_COLLECTION).delete(existing.id)
    // Session metadata and the Pi JSONL transcript are intentionally retained.
    return true
  }

  async createSession(userId: string, input: CreateSessionInput): Promise<StoredSessionRecord> {
    assertOwner(userId)
    const now = Date.now()
    const data = sessionData(userId, input, now)
    const projectId = typeof data.project_id === 'string' ? data.project_id : ''
    if (projectId) {
      const project = await this.getProject(userId, projectId)
      if (!project) throw new Error('Project not found')
      data.project_name = project.name
    } else if (String(data.project_name).toLocaleLowerCase() !== GENERAL_CHAT_NAME.toLocaleLowerCase()) {
      const project = await this.findProjectByName(userId, String(data.project_name))
      if (!project && !input.allowOrphanProject) throw new Error('Project not found')
      if (project) {
        data.project_id = project.id
        data.project_name = project.name
      }
    }
    if (typeof data.directory === 'string' && data.directory) {
      const directory = assertPathWithinWorkspace(data.directory)
      if (String(data.project_name).toLocaleLowerCase() !== GENERAL_CHAT_NAME.toLocaleLowerCase()) {
        const project = await this.findProjectByName(userId, String(data.project_name))
        if (project && !isPathWithin(project.path, directory)) throw new Error('Session directory is outside its project')
      }
      data.directory = directory
    }
    return sessionFromRecord(await collection(this.client, SESSIONS_COLLECTION).create(data))
  }

  async getSession(userId: string, sessionId: string): Promise<StoredSessionRecord | null> {
    assertOwner(userId)
    if (!sessionId.trim()) return null
    const record = await firstOrNull(() => collection(this.client, SESSIONS_COLLECTION).getFirstListItem(ownedRecordFilter(userId, 'session_id', sessionId)))
    return record ? sessionFromRecord(record) : null
  }

  /** Look up the durable owner before accepting a caller-supplied identity. */
  async getSessionById(sessionId: string): Promise<StoredSessionRecord | null> {
    if (!sessionId.trim()) return null
    const record = await firstOrNull(() => collection(this.client, SESSIONS_COLLECTION).getFirstListItem(pocketBaseEquals('session_id', sessionId)))
    return record ? sessionFromRecord(record) : null
  }

  async listSessions(userId: string, options: ListSessionsOptions = {}): Promise<StoredSessionRecord[]> {
    assertOwner(userId)
    const filters = [ownerFilter(userId)]
    if (options.projectId) filters.push(pocketBaseEquals('project_id', options.projectId))
    if (options.project) filters.push(pocketBaseEquals('project_name', options.project === '0' ? GENERAL_CHAT_NAME : options.project))
    if (options.includeArchived === false) filters.push('archived = false')
    const records = await collection(this.client, SESSIONS_COLLECTION).getFullList({ filter: filters.join(' && '), sort: '-updated_at' })
    return records.map(sessionFromRecord)
  }

  async updateSession(userId: string, sessionId: string, input: UpdateSessionInput): Promise<StoredSessionRecord | null> {
    const existing = await this.getSession(userId, sessionId)
    if (!existing) return null
    const data = sessionUpdateData(input)
    if (input.projectId !== undefined && input.projectId) {
      const project = await this.getProject(userId, input.projectId)
      if (!project) throw new Error('Project not found')
      data.project_name = project.name
    } else if (input.project !== undefined) {
      const project = input.project.toLocaleLowerCase() === GENERAL_CHAT_NAME.toLocaleLowerCase()
        ? null
        : await this.findProjectByName(userId, input.project)
      if (input.project.toLocaleLowerCase() !== GENERAL_CHAT_NAME.toLocaleLowerCase() && !project && !input.allowOrphanProject) throw new Error('Project not found')
      data.project_id = project?.id ?? ''
      data.project_name = project?.name ?? input.project.trim()
    }
    if (typeof data.directory === 'string' && data.directory) {
      const projectName = String(data.project_name ?? existing.project)
      const directory = assertPathWithinWorkspace(data.directory)
      if (projectName.toLocaleLowerCase() !== GENERAL_CHAT_NAME.toLocaleLowerCase()) {
        const project = await this.findProjectByName(userId, projectName)
        if (project && !isPathWithin(project.path, directory)) throw new Error('Session directory is outside its project')
      }
      data.directory = directory
    }
    data.updated_at = input.updatedAt === undefined ? Date.now() : data.updated_at
    const updated = await collection(this.client, SESSIONS_COLLECTION).update(existing.recordId, data)
    return sessionFromRecord(updated)
  }

  async deleteSession(userId: string, sessionId: string): Promise<boolean> {
    const existing = await this.getSession(userId, sessionId)
    if (!existing) return false
    await collection(this.client, SESSIONS_COLLECTION).delete(existing.recordId)
    // Deleting metadata must never delete Pi's transcript.
    return true
  }

  /**
   * Resolve a session only through owner-scoped queries, then verify its project
   * through the same owner. This prevents a session id or project id from being
   * used to cross an ownership boundary.
   */
  async getSessionContext(userId: string, sessionId: string): Promise<SessionContext | null> {
    const session = await this.getSession(userId, sessionId)
    if (!session) return null
    if (!session.projectId) {
      if (session.project.toLocaleLowerCase() !== GENERAL_CHAT_NAME.toLocaleLowerCase()) return null
      if (session.directory) {
        try { assertPathWithinWorkspace(session.directory) } catch { return null }
      }
      return { session, project: null, isGeneralChat: true }
    }
    const project = await this.getProject(userId, session.projectId)
    if (!project) return null
    if (session.directory) {
      try {
        if (!isPathWithin(project.path, assertPathWithinWorkspace(session.directory))) return null
      } catch { return null }
    }
    return { session, project, isGeneralChat: false }
  }

  async migrateLegacyProjects(userId: string, definitions: readonly LegacyProjectDefinition[]): Promise<MigrationResult<ProjectRecord>> {
    assertOwner(userId)
    const migrated: ProjectRecord[] = []
    const skipped: MigrationIssue[] = []
    for (const definition of definitions) {
      try {
        const input = normalizeProjectInput(definition)
        const existing = await firstOrNull(() => collection(this.client, PROJECTS_COLLECTION).getFirstListItem(ownedRecordFilter(userId, 'name', input.name)))
        if (existing) {
          await this.assertProjectPathAvailable(userId, input.path, String(existing.id))
          const updated = await collection(this.client, PROJECTS_COLLECTION).update(existing.id, { path: input.path, updated_at: Date.now() })
          migrated.push(projectFromRecord(updated))
        } else {
          migrated.push(await this.createProject(userId, input))
        }
      } catch (error) {
        skipped.push({ kind: 'project', key: definition?.name ?? '', reason: errorMessage(error) })
      }
    }
    return { migrated, skipped }
  }

  async migrateLegacySessions(userId: string, records: readonly LegacySessionRecord[]): Promise<MigrationResult<StoredSessionRecord>> {
    assertOwner(userId)
    const migrated: StoredSessionRecord[] = []
    const skipped: MigrationIssue[] = []
    for (const legacy of records) {
      const key = typeof legacy?.id === 'string' ? legacy.id : ''
      try {
        const input = legacySessionInput(legacy)
        const project = input.project && input.project.toLocaleLowerCase() !== GENERAL_CHAT_NAME.toLocaleLowerCase()
          ? await this.findProjectByName(userId, input.project)
          : null
        const resolvedInput = project ? { ...input, projectId: project.id } : input
        const existing = await this.getSession(userId, input.id ?? '')
        if (existing) {
          const merged = mergeLegacySession(existing, resolvedInput)
          const updated = await this.updateSession(userId, existing.id, merged)
          if (!updated) throw new Error('Session disappeared during migration')
          migrated.push(updated)
        } else {
          migrated.push(await this.createSession(userId, resolvedInput))
        }
      } catch (error) {
        skipped.push({ kind: 'session', key, reason: errorMessage(error) })
      }
    }
    return { migrated, skipped }
  }

  /** Migrate both metadata sets; no transcript paths are opened or modified. */
  async migrateLegacyMetadata(userId: string, metadata: LegacyMetadata): Promise<{ projects: MigrationResult<ProjectRecord>; sessions: MigrationResult<StoredSessionRecord> }> {
    const projects = await this.migrateLegacyProjects(userId, parseLegacyProjects(metadata.projects ?? []))
    const sessions = await this.migrateLegacySessions(userId, parseLegacySessions(metadata.sessions ?? []))
    return { projects, sessions }
  }
}

export function createProjectSessionRepository(client: PocketBase): ProjectSessionRepository {
  return new ProjectSessionRepository(client)
}

export async function migrateLegacyProjects(client: PocketBase, userId: string, definitions: readonly LegacyProjectDefinition[]): Promise<MigrationResult<ProjectRecord>> {
  return new ProjectSessionRepository(client).migrateLegacyProjects(userId, definitions)
}

export async function migrateLegacySessions(client: PocketBase, userId: string, records: readonly LegacySessionRecord[]): Promise<MigrationResult<StoredSessionRecord>> {
  return new ProjectSessionRepository(client).migrateLegacySessions(userId, records)
}

export async function migrateLegacyMetadata(client: PocketBase, userId: string, metadata: LegacyMetadata): Promise<{ projects: MigrationResult<ProjectRecord>; sessions: MigrationResult<StoredSessionRecord> }> {
  return new ProjectSessionRepository(client).migrateLegacyMetadata(userId, metadata)
}

export async function getSessionContext(client: PocketBase, userId: string, sessionId: string): Promise<SessionContext | null> {
  return new ProjectSessionRepository(client).getSessionContext(userId, sessionId)
}

function assertOwner(userId: string): void {
  if (typeof userId !== 'string' || userId.trim() === '' || userId !== userId.trim()) throw new Error('A PocketBase user id is required')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function parseProject(value: unknown): LegacyProjectDefinition | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const item = value as Record<string, unknown>
  return typeof item.name === 'string' && typeof item.path === 'string' ? { name: item.name, path: item.path } : null
}

function parseSession(value: unknown): LegacySessionRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const item = value as Record<string, unknown>
  if (typeof item.id !== 'string' || typeof item.project !== 'string' || typeof item.title !== 'string' || typeof item.createdAt !== 'number' || typeof item.updatedAt !== 'number') return null
  const permissionOverride = item.permissionOverride === 'ask' || item.permissionOverride === 'none' || item.permissionOverride === 'allow_all' ? item.permissionOverride : undefined
  return {
    id: item.id,
    project: item.project,
    title: item.title,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    ...(item.archived === true ? { archived: true } : {}),
    ...(typeof item.profile === 'string' ? { profile: item.profile } : {}),
    ...(typeof item.model === 'string' ? { model: item.model } : {}),
    ...(typeof item.directory === 'string' ? { directory: item.directory } : {}),
    ...(typeof item.userId === 'string' ? { userId: item.userId } : {}),
    ...(permissionOverride ? { permissionOverride } : {}),
  }
}

/** Parse the legacy `.subpolar/projects.json` / project definition array. */
export function parseLegacyProjects(value: unknown): LegacyProjectDefinition[] {
  if (Array.isArray(value)) return value.flatMap((item) => {
    const project = parseProject(item)
    return project ? [project] : []
  })
  if (!value || typeof value !== 'object') return []
  const source = (value as { projects?: unknown }).projects
  if (Array.isArray(source)) return parseLegacyProjects(source)
  const entries = source && typeof source === 'object' && !Array.isArray(source) ? source : value
  return Object.entries(entries as Record<string, unknown>).flatMap(([name, item]) => {
    const path = typeof item === 'string' ? item : item && typeof item === 'object' ? (item as { path?: unknown }).path : undefined
    return typeof path === 'string' ? [{ name, path }] : []
  })
}

/** Parse legacy `.sessions.json`; invalid entries are ignored like the bridge loader. */
export function parseLegacySessions(value: unknown): LegacySessionRecord[] {
  return Array.isArray(value) ? value.flatMap((item) => {
    const session = parseSession(item)
    return session ? [session] : []
  }) : []
}

/** Read a legacy JSON metadata file without touching any Pi session transcript. */
export function readLegacyJsonFile(filePath: string): unknown {
  if (!existsSync(filePath)) return undefined
  try {
    return JSON.parse(readFileSync(filePath, 'utf8')) as unknown
  } catch {
    return undefined
  }
}

export function readLegacyProjectsFile(filePath: string): LegacyProjectDefinition[] {
  return parseLegacyProjects(readLegacyJsonFile(filePath))
}

export function readLegacySessionsFile(filePath: string): LegacySessionRecord[] {
  return parseLegacySessions(readLegacyJsonFile(filePath))
}

function legacySessionInput(legacy: LegacySessionRecord): CreateSessionInput {
  if (!legacy || typeof legacy.id !== 'string' || !legacy.id.trim()) throw new Error('Legacy session id is required')
  if (typeof legacy.project !== 'string' || !legacy.project.trim()) throw new Error('Legacy session project is required')
  // Project ids are not present in the old SQLite/JSON shape. Resolution by name
  // happens below, after the project collection has been migrated.
  return {
    id: legacy.id,
    project: legacy.project,
    title: legacy.title,
    createdAt: legacy.createdAt,
    updatedAt: legacy.updatedAt,
    archived: legacy.archived,
    profile: legacy.profile,
    model: legacy.model,
    directory: legacy.directory,
    permissionOverride: legacy.permissionOverride,
    allowOrphanProject: true,
  }
}

function mergeLegacySession(existing: StoredSessionRecord, incoming: CreateSessionInput): UpdateSessionInput {
  return {
    projectId: incoming.projectId ?? existing.projectId,
    project: incoming.project ?? existing.project,
    title: existing.title === 'Untitled session' && incoming.title ? incoming.title : existing.title,
    createdAt: Math.min(existing.createdAt, incoming.createdAt ?? existing.createdAt),
    updatedAt: Math.max(existing.updatedAt, incoming.updatedAt ?? existing.updatedAt),
    ...(incoming.archived !== undefined ? { archived: incoming.archived } : existing.archived !== undefined ? { archived: existing.archived } : {}),
    ...(incoming.profile || existing.profile ? { profile: incoming.profile ?? existing.profile } : {}),
    ...(incoming.model || existing.model ? { model: incoming.model ?? existing.model } : {}),
    ...(incoming.directory || existing.directory ? { directory: incoming.directory ?? existing.directory } : {}),
    ...(incoming.permissionOverride || existing.permissionOverride ? { permissionOverride: incoming.permissionOverride ?? existing.permissionOverride } : {}),
    ...(incoming.allowOrphanProject ? { allowOrphanProject: true } : {}),
  }
}
