import { describe, expect, it } from 'vitest'
import { provisionalSessionTitle } from './session-title.ts'

describe('provisionalSessionTitle', () => {
  it('uses the first six words and removes trailing punctuation', () => {
    expect(provisionalSessionTitle('Please help me debug this issue today and tomorrow.'))
      .toBe('Please help me debug this issue')
  })

  it('handles short and whitespace-only requests', () => {
    expect(provisionalSessionTitle('  Fix the build!  ')).toBe('Fix the build')
    expect(provisionalSessionTitle(' \n  ')).toBeUndefined()
  })
})
