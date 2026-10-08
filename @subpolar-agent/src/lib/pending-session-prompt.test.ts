import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearPendingSessionPrompt,
  loadPendingSessionPrompt,
  savePendingSessionPrompt,
} from './pending-session-prompt'

describe('pending session prompt handoff', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('persists an interrupted handoff without changing its prompt data', () => {
    const prompt = {
      prompt: 'Continue this request',
      messageID: 'optimistic_user_original',
      model: 'anthropic/claude-sonnet-4',
      agent: 'master',
      permission: 'default',
      status: 'interrupted' as const,
    }

    savePendingSessionPrompt('session-1', prompt)

    expect(loadPendingSessionPrompt('session-1')).toEqual(prompt)
  })

  it('clears the handoff only when explicitly requested', () => {
    savePendingSessionPrompt('session-2', {
      prompt: 'Do not lose this',
      messageID: 'optimistic_user_pending',
      status: 'interrupted',
    })

    expect(loadPendingSessionPrompt('session-2')).toBeDefined()

    clearPendingSessionPrompt('session-2')

    expect(loadPendingSessionPrompt('session-2')).toBeUndefined()
  })

  it('round-trips an in-flight handoff without changing its message ID', () => {
    const prompt = {
      prompt: 'Keep this request in flight',
      messageID: 'optimistic_user_in_flight',
      status: 'in-flight' as const,
    }

    savePendingSessionPrompt('session-3', prompt)

    expect(loadPendingSessionPrompt('session-3')).toEqual(prompt)
  })
})
