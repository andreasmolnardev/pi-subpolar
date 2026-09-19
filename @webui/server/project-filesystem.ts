import { dirname, relative, resolve, sep } from 'node:path'
import { realpathSync } from 'node:fs'

export function configuredWorkspaceRoot(): string {
  return resolve(process.env.SUBPOLAR_PROJECTS_ROOT ?? `${process.env.HOME ?? '.'}/.subpolar`)
}

function realpathWithMissing(value: string): string {
  const absolute = resolve(value)
  try {
    return realpathSync.native(absolute)
  } catch {
    const parent = dirname(absolute)
    if (parent === absolute) return absolute
    const remainder = parent === sep ? absolute.slice(1) : absolute.slice(parent.length + 1)
    return resolve(realpathWithMissing(parent), remainder)
  }
}

export function canonicalProjectPath(value: string): string {
  return realpathWithMissing(value)
}

export function isPathWithin(root: string, candidate: string): boolean {
  const child = relative(canonicalProjectPath(root), canonicalProjectPath(candidate))
  return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !child.startsWith(sep))
}

export function assertPathWithinWorkspace(value: string, root = configuredWorkspaceRoot()): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('A project path is required')
  const canonicalRoot = canonicalProjectPath(root)
  const canonicalCandidate = canonicalProjectPath(value)
  if (!isPathWithin(canonicalRoot, canonicalCandidate)) throw new Error('Project path must be inside the configured workspace')
  return canonicalCandidate
}
