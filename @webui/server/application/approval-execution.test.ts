import { describe, expect, it } from 'vitest'
import { discardPendingApprovalInput, retainPendingApprovalInput, takePendingApprovalInput } from './approval-execution'

describe('process-local approval execution payloads', () => {
  it('does not use redacted persisted data and consumes a payload once', () => {
    retainPendingApprovalInput('approval-test', { command: 'echo secret', token: 'secret' })
    expect(takePendingApprovalInput('approval-test')).toEqual({ command: 'echo secret', token: 'secret' })
    expect(takePendingApprovalInput('approval-test')).toBeUndefined()
    discardPendingApprovalInput('approval-test')
    expect(takePendingApprovalInput('approval-test')).toBeUndefined()
  })

  it('refuses payloads that were not retained by this process', () => {
    expect(takePendingApprovalInput('after-restart')).toBeUndefined()
  })
})
