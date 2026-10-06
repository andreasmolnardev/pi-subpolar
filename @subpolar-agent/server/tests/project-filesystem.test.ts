import { mkdirSync, mkdtempSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { assertPathWithinWorkspace, canonicalProjectPath, isPathWithin } from '../core/project-filesystem.ts'

describe('project filesystem containment', () => {
  it('rejects traversal and symlink escapes', () => {
    const root = mkdtempSync(join(tmpdir(), 'subpolar-workspace-'))
    const outside = mkdtempSync(join(tmpdir(), 'subpolar-outside-'))
    mkdirSync(join(root, 'inside'))
    symlinkSync(outside, join(root, 'escape'))
    expect(assertPathWithinWorkspace(join(root, 'inside', 'file.txt'), root)).toContain(join(root, 'inside'))
    expect(() => assertPathWithinWorkspace(join(root, '..', 'subpolar-outside'), root)).toThrow()
    expect(() => assertPathWithinWorkspace(join(root, 'escape', 'file.txt'), root)).toThrow()
  })

  it('canonicalizes existing symlinks before containment checks', () => {
    const root = mkdtempSync(join(tmpdir(), 'subpolar-root-'))
    const outside = mkdtempSync(join(tmpdir(), 'subpolar-target-'))
    symlinkSync(outside, join(root, 'linked'))
    expect(canonicalProjectPath(join(root, 'linked'))).toBe(canonicalProjectPath(outside))
    expect(isPathWithin(root, join(root, 'linked'))).toBe(false)
  })
})
