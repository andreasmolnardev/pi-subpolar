import { describe, expect, test } from 'bun:test'
import { ContractFake } from './fake-contract'

describe('bounded Phase 16 contract smoke', () => {
  test('covers discovery, auth, project/session setup, tool decisions, idempotency, and audit', () => {
    const fake = new ContractFake()
    expect(fake.health()).toEqual({ status: 'ok', version: 'v1' })
    expect(fake.capabilities().capabilities).toContain('audit')
    expect(fake.authConfig().enabledProviders).toEqual(['credentials'])
    expect(fake.authenticate('e2e@example.test', 'e2e-password-16').userId).toBe('user-e2e')

    const records = fake.createProjectAndSession()
    expect(records.projectId).toStartWith('project-')
    expect(records.sessionId).toStartWith('session-')
    expect(fake.discoverTools().map((tool) => tool.id)).toEqual(['read', 'write', 'dangerous'])

    expect(fake.callTool('dangerous', 'user-e2e', 'deny-1').decision).toBe('deny')
    expect(fake.callTool('write', 'user-e2e', 'approval-1')).toMatchObject({ decision: 'approval', approvalId: 'approval-1' })
    expect(fake.approve('approval-1', 'user-e2e')).toEqual({ decision: 'allow', result: 'fake-result' })
    expect(fake.callTool('read', 'user-e2e', 'allow-1')).toEqual({ decision: 'allow', result: 'fake-result' })
    expect(fake.callTool('read', 'user-e2e', 'allow-1')).toEqual({ decision: 'allow', result: 'fake-result' })

    expect(fake.audit).toEqual([
      { callId: 'deny-1', userId: 'user-e2e', toolId: 'dangerous', decision: 'deny', outcome: 'not-run' },
      { callId: 'approval-1', userId: 'user-e2e', toolId: 'write', decision: 'approval', outcome: 'approved' },
      { callId: 'allow-1', userId: 'user-e2e', toolId: 'read', decision: 'allow', outcome: 'executed' },
    ])
  })

  test('rejects non-deterministic credentials in the fake', () => {
    expect(() => new ContractFake().authenticate('developer@example.com', 'real-password')).toThrow('AUTH_FAILED')
  })
})
