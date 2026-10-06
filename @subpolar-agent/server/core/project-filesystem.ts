import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { lstatSync, realpathSync } from 'node:fs'

// Application guard, not an OS sandbox: parent-directory replacement still needs
// worker-level isolation when another process can mutate the workspace.
export function assertToolWorkspacePath(root: string, value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || isAbsolute(value) || /^[a-zA-Z]:|^[~@\\\\]/.test(value)) {
    throw new Error('Tool paths must be relative to the owned workspace')
  }
  const absoluteRoot = resolve(root)
  const candidate = resolve(absoluteRoot, value)
  const child = relative(absoluteRoot, candidate)
  if (child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) throw new Error('Tool path is outside the owned workspace')
  let current = absoluteRoot
  for (const component of ['', ...child.split(sep).filter(Boolean)]) {
    if (component) current = resolve(current, component)
    try {
      const stat = lstatSync(current)
      if (stat.isSymbolicLink()) throw new Error('Symbolic links are not allowed in tool paths')
      if (!stat.isDirectory() && !stat.isFile()) throw new Error('Only regular files and directories are allowed')
      if (stat.isFile() && stat.nlink > 1) throw new Error('Hard-linked files are not allowed in tool paths')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  if (!isPathWithin(absoluteRoot, candidate)) throw new Error('Tool path is outside the owned workspace')
  return candidate
}

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
