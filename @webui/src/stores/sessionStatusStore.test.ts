import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSessionStatus } from './sessionStatusStore'

const store = () => useSessionStatus.getState()

beforeEach(() => {
  vi.useFakeTimers()
  useSessionStatus.setState({ statuses: new Map(), statusCache: new Map(), unreadCompleted: new Set() })
})
afterEach(() => {
  for (const id of store().statuses.keys()) store().clearStatus(id)
  vi.runOnlyPendingTimers()
  vi.useRealTimers()
})

describe('session status recovery', () => {
  it('expires unconfirmed optimistic activity even when a snapshot omits it', () => {
    store().setOptimisticActive('session', 100)
    store().replaceStatuses({})
    expect(store().getStatus('session')).toEqual({ type: 'busy' })
    vi.advanceTimersByTime(100)
    expect(store().getStatus('session')).toEqual({ type: 'idle' })
  })

  it.each(['event', 'snapshot'])('cancels optimism when a %s confirms busy', source => {
    store().setOptimisticActive('session', 100)
    if (source === 'event') store().setStatus('session', { type: 'busy' })
    else store().replaceStatuses({ session: { type: 'busy' } })
    vi.advanceTimersByTime(100)
    expect(store().getStatus('session')).toEqual({ type: 'busy' })
    store().replaceStatuses({})
    expect(store().getStatus('session')).toEqual({ type: 'idle' })
  })

  it.each([
    { type: 'busy' as const },
    { type: 'compact' as const },
    { type: 'retry' as const, attempt: 2, message: 'Retrying', next: 500 },
  ])('does not downgrade authoritative $type to expiring optimism', status => {
    store().setStatus('session', status)
    store().setOptimisticActive('session', 100)
    expect(store().getStatus('session')).toEqual(status)
    vi.advanceTimersByTime(100)
    expect(store().getStatus('session')).toEqual(status)
  })

  it('allows explicit idle to clear optimism without marking a run completed', () => {
    store().setOptimisticActive('session', 100)
    store().replaceStatuses({ session: { type: 'idle' } })
    vi.advanceTimersByTime(100)
    expect(store().getStatus('session')).toEqual({ type: 'idle' })
    expect(store().unreadCompleted.size).toBe(0)
  })

  it('refreshes only an unconfirmed optimistic timeout', () => {
    store().setOptimisticActive('session', 100)
    vi.advanceTimersByTime(50)
    store().setOptimisticActive('session', 100)
    vi.advanceTimersByTime(50)
    expect(store().getStatus('session').type).toBe('busy')
    vi.advanceTimersByTime(50)
    expect(store().getStatus('session').type).toBe('idle')
  })
})
