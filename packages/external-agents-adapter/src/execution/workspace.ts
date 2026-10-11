import { realpathSync, lstatSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { ExternalScope } from '../runtime/contracts.ts'

export function within(root: string, path: string): boolean {
  const child = relative(root, path)
  return child === '' || (!isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`))
}
export function canonicalRoot(path: string): string {
  if (!isAbsolute(path) || path.includes('\0')) throw new Error('An absolute existing workspace is required')
  const result = realpathSync(path)
  if (!lstatSync(result).isDirectory()) throw new Error('Workspace must be a directory')
  return result
}
export function scopedWorkingDirectory(scope: ExternalScope, requested = scope.workspace): string {
  const root = canonicalRoot(scope.workspace)
  const cwd = realpathSync(resolve(root, requested))
  if (!within(root, cwd) || !lstatSync(cwd).isDirectory()) throw new Error('Working directory is outside the authorized workspace')
  return cwd
}
export function immutableScope(scope: ExternalScope): ExternalScope {
  if (![scope.ownerId, scope.sessionId, scope.agentId].every(value => typeof value === 'string' && value.length > 0 && value.length < 257)) throw new Error('An owned session and agent are required')
  return Object.freeze({ ...scope, workspace: canonicalRoot(scope.workspace), ...(scope.allowedToolIds ? { allowedToolIds: Object.freeze([...scope.allowedToolIds]) } : {}) })
}
