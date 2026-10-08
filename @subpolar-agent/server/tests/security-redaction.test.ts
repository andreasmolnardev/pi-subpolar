import { describe, expect, it } from 'vitest'
import { redactSensitive, redactSensitiveText } from '../core/security-redaction.ts'

describe('security redaction', () => {
  it('redacts sensitive object fields and error text', () => {
    const value = redactSensitive({ command: 'curl', apiKey: 'secret-key', nested: { password: 'secret-password' }, visible: 'ok' })
    expect(JSON.stringify(value)).not.toContain('secret-key')
    expect(JSON.stringify(value)).not.toContain('secret-password')
    expect(value).toMatchObject({ visible: 'ok' })
    expect(redactSensitiveText('Authorization: Bearer top-secret')).not.toContain('top-secret')
    expect(redactSensitiveText('{"apiKey":"json-secret","visible":"ok"}')).toBe('{"apiKey":"[REDACTED]","visible":"ok"}')
  })

  it('preserves event structure while redacting tool payloads and errors', () => {
    const event = redactSensitive({
      type: 'tool_execution_end',
      toolCallId: 'call-1',
      result: { output: '{"access_token":"event-secret"}', details: { password: 'detail-secret' } },
      error: 'Authorization: Bearer error-secret',
    }) as Record<string, unknown>

    expect(event.type).toBe('tool_execution_end')
    expect(event.toolCallId).toBe('call-1')
    expect(event).toHaveProperty('result')
    expect(event).toHaveProperty('error')
    expect(JSON.stringify(event)).not.toContain('secret')
  })
})
