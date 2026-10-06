import { describe, expect, it } from 'vitest'
import { LIGHT_THEME_VALUES, SEMANTIC_THEME_VARIABLES, themeIsLight } from './themes'

describe('theme foundation', () => {
  it('keeps the existing theme preference values while classifying light themes', () => {
    expect(themeIsLight('light')).toBe(true)
    expect(themeIsLight('dark')).toBe(false)
    expect(themeIsLight('system')).toBe(false)
    expect(LIGHT_THEME_VALUES.has('blueberry_light')).toBe(true)
  })

  it('defines semantic surfaces without replacing existing token names', () => {
    expect(SEMANTIC_THEME_VARIABLES).toContain('--color-surface')
    expect(SEMANTIC_THEME_VARIABLES).toContain('--color-focus')
    expect(SEMANTIC_THEME_VARIABLES).toContain('--color-on-accent')
  })
})
