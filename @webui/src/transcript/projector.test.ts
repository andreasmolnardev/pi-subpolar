import { describe, expect, it } from 'vitest'
import { activeBranch, projectEntries } from '../../transcript/projector'

const entry = (id: string, parentId: string | undefined, message: any) => ({ id, parentId, type: 'message', message })

describe('Pi transcript projector', () => {
  it('selects only the active ancestry', () => {
    const entries = [entry('a', undefined, { role: 'user', content: 'a' }), entry('b', 'a', { role: 'assistant', content: [{ type: 'text', text: 'b' }] }), entry('x', 'a', { role: 'user', content: 'x' }), entry('c', 'b', { role: 'user', content: 'c' })]
    expect(activeBranch(entries, 'c').map((x) => x.id)).toEqual(['a', 'b', 'c'])
  })
  it('preserves typed thinking and text blocks', () => {
    const entries = [
      entry('u', undefined, { role: 'user', content: 'summarize' }),
      entry('a', 'u', { role: 'assistant', timestamp: 1, content: [
        { type: 'thinking', thinking: 'Inspecting git status diff\nSummarizing unstaged changes and status' },
        { type: 'text', text: 'Testing the result gives this summary.' }
      ] }),
    ]
    const parts = projectEntries(entries, 'a', 's')[1].parts
    expect(parts[0].type).toBe('reasoning')
    expect(parts[1].type).toBe('text')
  })

  it('preserves ordered reasoning, tools and text and folds results', () => {
    const entries = [
      entry('u', undefined, { role: 'user', content: 'go' }),
      entry('a', 'u', { role: 'assistant', timestamp: 1, content: [
        { type: 'thinking', thinking: 'one' }, { type: 'toolCall', id: 'A', name: 'read', arguments: { path: 'x' } },
        { type: 'thinking', thinking: 'two' }, { type: 'toolCall', id: 'B', name: 'read', arguments: {} }, { type: 'text', text: 'done' },
      ] }),
      entry('r', 'a', { role: 'toolResult', toolCallId: 'A', content: [{ type: 'text', text: 'ok' }], isError: false }),
    ]
    const message = projectEntries(entries, 'r', 's')[1]
    expect(message.parts.map((p) => p.type)).toEqual(['reasoning', 'tool', 'reasoning', 'tool', 'text', 'step-finish'])
    expect(message.parts[1].state.status).toBe('completed')
    expect(message.parts[3].state.status).toBe('pending')
  })

  it('redacts tool inputs, results, metadata, and errors without changing tool shape', () => {
    const entries = [
      entry('u', undefined, { role: 'user', content: 'run' }),
      entry('a', 'u', { role: 'assistant', timestamp: 1, content: [
        { type: 'toolCall', id: 'A', name: 'request', arguments: { url: 'https://example.test', apiKey: 'input-secret' } },
      ] }),
      entry('r', 'a', {
        role: 'toolResult',
        toolCallId: 'A',
        content: [{ type: 'text', text: '{"token":"result-secret"}' }],
        details: { password: 'details-secret' },
        isError: true,
      }),
    ]

    const tool = projectEntries(entries, 'r', 's')[1]?.parts[0]
    expect(tool).toMatchObject({ type: 'tool', callID: 'A', tool: 'request', state: { status: 'error' } })
    expect(JSON.stringify(tool)).not.toContain('secret')
    expect(tool?.state.input).toEqual({ url: 'https://example.test', apiKey: '[REDACTED]' })
    expect(tool?.state.error).toBe('{"token":"[REDACTED]"}')
    expect(tool?.state.metadata).toEqual({ password: '[REDACTED]' })
  })

  it('redacts historical user, assistant, and reasoning text while preserving the projection shape', () => {
    const entries = [
      entry('u', undefined, { role: 'user', content: [{ type: 'text', text: 'apiKey=user-secret' }] }),
      entry('a', 'u', { role: 'assistant', timestamp: 1, content: [
        { type: 'thinking', thinking: 'token=reasoning-secret' },
        { type: 'text', text: 'Bearer assistant-secret' },
      ] }),
    ]

    const messages = projectEntries(entries, 'a', 's')
    expect(messages).toHaveLength(2)
    expect(messages[0]).toMatchObject({ info: { role: 'user', content: 'apiKey=[REDACTED]' }, parts: [{ type: 'text', text: 'apiKey=[REDACTED]' }] })
    expect(messages[1]?.parts[0]).toMatchObject({ type: 'reasoning', text: 'token=[REDACTED]' })
    expect(messages[1]?.parts[1]).toMatchObject({ type: 'text', text: 'Bearer [REDACTED]' })
    expect(JSON.stringify(messages)).not.toContain('secret')
  })
})
