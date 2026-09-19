import { describe, expect, it } from 'vitest'
import { shouldBlockSessionCreation } from './session-submit'

describe('session creation submit guard', () => {
  it('blocks a second submit while createSession is pending', () => {
    expect(shouldBlockSessionCreation(true, false)).toBe(true)
  })

  it('also blocks the synchronous race before mutation state updates', () => {
    expect(shouldBlockSessionCreation(false, true)).toBe(true)
  })
})
