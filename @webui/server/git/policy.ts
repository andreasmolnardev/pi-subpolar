import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { canonicalProjectPath, configuredWorkspaceRoot, isPathWithin } from '../project-filesystem.ts'
import type { ProjectRecord } from '../project-store.ts'
import { GitServiceError } from './contracts.ts'

export type OwnedProjectLookup = (userId: string, projectId: string) => Promise<ProjectRecord | null>

export function safeRelativePath(value: string | undefined): string | undefined {
  if (value === undefined || value === '') return undefined
  if (value.includes('\0') || value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value)) throw new GitServiceError('PATH_DENIED', 'Invalid repository path')
  const normalized = value.replaceAll('\\', '/')
  const parts = normalized.split('/')
  if (parts.some((part) => part === '..' || part === '.')) throw new GitServiceError('PATH_DENIED', 'Invalid repository path')
  if (parts.some((part) => part === '' || part.startsWith('-'))) throw new GitServiceError('PATH_DENIED', 'Invalid repository path')
  return parts.join('/')
}

export function safeRef(value: string | undefined): string | undefined {
  if (value === undefined || value === '') return undefined
  if (!/^[A-Za-z0-9][A-Za-z0-9._/@+-]{0,255}$/.test(value) || value.includes('..') || value.endsWith('/') || value.includes('@{')) throw new GitServiceError('REF_DENIED', 'Invalid Git reference')
  return value
}

export class GitPathPolicy {
  constructor(private readonly lookup: OwnedProjectLookup, private readonly workspaceRoot = configuredWorkspaceRoot()) {}

  async project(userId: string, projectId: string): Promise<{ project: ProjectRecord; root: string }> {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(projectId)) throw new GitServiceError('PROJECT_NOT_FOUND', 'Project not found')
    const project = await this.lookup(userId, projectId)
    if (!project) throw new GitServiceError('PROJECT_NOT_FOUND', 'Project not found')
    const root = canonicalProjectPath(project.path)
    if (!isPathWithin(this.workspaceRoot, root)) throw new GitServiceError('PATH_DENIED', 'Project path is not allowed')
    return { project, root }
  }

  path(root: string, value: string | undefined): string | undefined {
    const relativePath = safeRelativePath(value)
    if (!relativePath) return undefined
    const candidate = resolve(root, relativePath)
    if (!isPathWithin(root, candidate)) throw new GitServiceError('PATH_DENIED', 'Repository path is not allowed')
    try { if (!isPathWithin(root, realpathSync.native(candidate))) throw new GitServiceError('PATH_DENIED', 'Repository path is not allowed') } catch (error) {
      if (error instanceof GitServiceError) throw error
      // A missing diff path is still safe when its nearest existing parent is safe.
      const parent = resolve(candidate, '..')
      if (!isPathWithin(root, canonicalProjectPath(parent))) throw new GitServiceError('PATH_DENIED', 'Repository path is not allowed')
    }
    return relativePath
  }

  worktreePath(root: string, value: string): string {
    const canonical = canonicalProjectPath(value)
    if (!isPathWithin(this.workspaceRoot, canonical) || !isPathWithin(root, canonical)) throw new GitServiceError('PATH_DENIED', 'Worktree is not owned')
    return canonical
  }
}
