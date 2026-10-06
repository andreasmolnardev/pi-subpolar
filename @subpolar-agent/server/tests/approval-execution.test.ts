import { describe, expect, it } from 'vitest'
import { discardPendingApprovalInput, hasPendingApprovalWaiter, notifyApprovalResolution, retainPendingApprovalInput, takePendingApprovalInput, waitForApprovalResolution } from '../application/tools/approval-execution.ts'

describe('process-local approval execution payloads', () => {
  it('does not use redacted persisted data and consumes a payload once', () => {
    retainPendingApprovalInput('approval-test', { command: 'echo secret', token: 'secret' })
    expect(takePendingApprovalInput('approval-test')).toEqual({ command: 'echo secret', token: 'secret' })
    expect(takePendingApprovalInput('approval-test')).toBeUndefined()
    discardPendingApprovalInput('approval-test')
    expect(takePendingApprovalInput('approval-test')).toBeUndefined()
  })

  it('wakes one waiting execution when the durable approval is resolved', async () => {
    const waiting = waitForApprovalResolution('approval-wait', Date.now() + 10_000)
    expect(hasPendingApprovalWaiter('approval-wait')).toBe(true)
    expect(notifyApprovalResolution('approval-wait', 'approved')).toBe(true)
    await expect(waiting).resolves.toBe('approved')
    expect(hasPendingApprovalWaiter('approval-wait')).toBe(false)
    expect(notifyApprovalResolution('approval-wait', 'rejected')).toBe(false)
  })

  it('refuses payloads that were not retained by this process', () => {
    expect(takePendingApprovalInput('after-restart')).toBeUndefined()
  })
})
