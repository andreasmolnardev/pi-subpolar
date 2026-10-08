import { describe, expect, it, vi } from 'vitest'
import { prefersReducedMotion } from './reduced-motion'

describe('prefersReducedMotion', () => {
  it('follows the browser preference', () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })))
    expect(prefersReducedMotion()).toBe(true)
    vi.unstubAllGlobals()
  })
})
