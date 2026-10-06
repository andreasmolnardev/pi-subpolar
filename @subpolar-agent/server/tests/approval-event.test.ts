import { describe, expect, it } from 'vitest'
import { permissionAskedProperties } from '../application/tools/approval-event.ts'

describe('permission.asked event redaction', () => {
  it('redacts approval input before it reaches broadcast metadata', () => {
    const event = permissionAskedProperties({
      id: 'approval-1',
      sessionId: 'session-1',
      toolId: 'bash',
      input: { command: 'curl', apiKey: 'secret-key', nested: { password: 'secret-password' } },
      reason: 'token=secret-token',
    })

    expect(JSON.stringify(event)).not.toContain('secret-key')
    expect(JSON.stringify(event)).not.toContain('secret-password')
    expect(JSON.stringify(event)).not.toContain('secret-token')
    expect(event.metadata).toEqual({
      toolId: 'bash',
      input: { command: 'curl', apiKey: '[REDACTED]', nested: { password: '[REDACTED]' } },
      reason: 'token=[REDACTED]',
    })
  })
})
