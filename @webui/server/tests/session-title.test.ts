import { describe, expect, it, vi } from 'vitest'
import { generateSessionTitle, normalizeSessionTitle } from '../application/runtime/session-title.ts'

describe('generateSessionTitle', () => {
  it('asks the configured model without tools and returns only a normalized title', async () => {
    const completeSimple = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: '```\nFix first-message routing!\n```' }],
    })

    await expect(generateSessionTitle({
      runtime: { completeSimple } as never,
      model: {} as never,
      request: 'Please make first-message routing and titles run before the agent',
    })).resolves.toBe('Fix first-message routing')

    const context = completeSimple.mock.calls[0]?.[1] as Record<string, unknown>
    expect(context).not.toHaveProperty('tools')
    expect((context.messages as Array<Record<string, unknown>>)[0]?.content).toContain('first-message routing')
  })

  it('rejects empty model output', () => {
    expect(normalizeSessionTitle('  ```\n```  ')).toBeUndefined()
    expect(normalizeSessionTitle('  A useful title.  ')).toBe('A useful title')
  })
})
