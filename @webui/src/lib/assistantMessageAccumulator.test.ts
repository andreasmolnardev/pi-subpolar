import { describe, expect, it } from 'vitest'
import { AssistantMessageAccumulator } from './assistantMessageAccumulator'

describe('AssistantMessageAccumulator', () => {
  it('preserves typed interleaved blocks and accumulates deltas', () => {
    const a = new AssistantMessageAccumulator({ role: 'assistant', content: [] })
    a.apply({ type: 'thinking_start', contentIndex: 1 })
    a.apply({ type: 'thinking_delta', contentIndex: 1, delta: 'think' })
    a.apply({ type: 'thinking_delta', contentIndex: 1, delta: 'ing' })
    a.apply({ type: 'text_start', contentIndex: 0 })
    a.apply({ type: 'text_delta', contentIndex: 0, delta: 'answer' })
    a.apply({ type: 'toolcall_start', contentIndex: 2, toolCall: { id: 'c', name: 'read' } })
    a.apply({ type: 'toolcall_delta', contentIndex: 2, delta: '{"path":"x"}' })
    expect(a.value().content).toEqual([
      { type: 'text', text: 'answer' },
      { type: 'thinking', thinking: 'thinking' },
      { type: 'toolCall', id: 'c', name: 'read', arguments: '{"path":"x"}' },
    ])
  })

  it('creates a block when a delta arrives without a start', () => {
    const a = new AssistantMessageAccumulator()
    a.apply({ type: 'thinking_delta', contentIndex: 3, delta: 'late' })
    expect(a.value().content).toEqual([{ type: 'thinking', thinking: 'late' }])
  })

  it('reconciles with the authoritative final message', () => {
    const a = new AssistantMessageAccumulator()
    a.apply({ type: 'text_delta', contentIndex: 0, delta: 'stale' })
    a.finalize({ role: 'assistant', content: [{ type: 'thinking', thinking: 'final' }, { type: 'text', text: 'done' }] })
    expect(a.value().content).toEqual([{ type: 'thinking', thinking: 'final' }, { type: 'text', text: 'done' }])
  })
})
