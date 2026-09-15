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
})
