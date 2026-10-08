import { describe, it, expect } from 'vitest'
import { getSessionListPath, getSwipeBackTarget, getPathWithReturnTo, getReturnToPath } from './navigation'

describe('getSessionListPath', () => {
  it('returns the canonical project path', () => {
    expect(getSessionListPath(42)).toBe('/projects/42')
    expect(getSessionListPath('123')).toBe('/projects/123')
  })

  it('includes non-default project tabs', () => {
    expect(getSessionListPath(42, 'workspaces')).toBe('/projects/42?projectTab=workspaces')
    expect(getSessionListPath(42, 'project')).toBe('/projects/42')
  })
})

describe('return target helpers', () => {
  it('adds encoded returnTo params for internal paths', () => {
    expect(getPathWithReturnTo('/projects/5/automations', '/projects/5/sessions/abc')).toBe(
      '/projects/5/automations?returnTo=%2Fprojects%2F5%2Fsessions%2Fabc',
    )
  })

  it('reads returnTo params and falls back for unsafe values', () => {
    expect(getReturnToPath('?returnTo=%2Fprojects%2F5%2Fsessions%2Fabc', '/projects/5')).toBe(
      '/projects/5/sessions/abc',
    )
    expect(getReturnToPath('?returnTo=https%3A%2F%2Fexample.com', '/projects/5')).toBe('/projects/5')
  })
})

describe('getSwipeBackTarget', () => {
  it('returns the project path for session details and preserves project tabs', () => {
    expect(getSwipeBackTarget('/projects/42/sessions/abc')).toBe('/projects/42')
    expect(getSwipeBackTarget('/projects/42/sessions/abc', '?projectTab=workspaces')).toBe(
      '/projects/42?projectTab=workspaces',
    )
  })

  it('returns the root for project details', () => {
    expect(getSwipeBackTarget('/projects/42')).toBe('/')
  })

  it('returns the project path for project automations', () => {
    expect(getSwipeBackTarget('/projects/42/automations')).toBe('/projects/42')
    expect(getSwipeBackTarget('/projects/42/automations', '?returnTo=%2Fprojects%2F42%2Fsessions%2Fabc')).toBe(
      '/projects/42/sessions/abc',
    )
  })

  it('returns the root for top-level automations', () => {
    expect(getSwipeBackTarget('/automations')).toBe('/')
  })

  it('returns null for root, auth, and unknown paths', () => {
    expect(getSwipeBackTarget('/')).toBeNull()
    expect(getSwipeBackTarget('/login')).toBeNull()
    expect(getSwipeBackTarget('/setup')).toBeNull()
    expect(getSwipeBackTarget('/register')).toBeNull()
    expect(getSwipeBackTarget('/unknown/path')).toBeNull()
  })
})
