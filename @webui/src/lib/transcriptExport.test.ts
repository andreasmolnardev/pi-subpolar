import { describe, expect, it } from 'vitest'
import type { MessageWithParts, Session } from '@/api/types'
import { buildTranscriptExport, exportTranscript, serializeTranscript, sanitizeTranscriptFilename } from './transcriptExport'

const session = { id: 'session/1', title: 'My: private session', time: { created: 1, updated: 2 } } as Session
const messages = [{
  info: { id: 'm1', role: 'user', time: { created: 3 } },
  parts: [{ type: 'text', text: 'Hello', id: 'p1' }],
}, {
  info: { id: 'm2', role: 'assistant', time: { created: 4, completed: 5 } },
  parts: [{ type: 'reasoning', text: 'private chain of thought', id: 'p2' }, { type: 'tool', id: 'p3', callID: 'c1', tool: 'read', state: { status: 'completed', input: { path: 'a', token: 'do not export' }, output: 'contents', title: '', metadata: {}, time: { start: 4, end: 5 } } }],
}] as unknown as MessageWithParts[]

describe('transcript export', () => {
  it('includes messages and tools but excludes reasoning and secrets', () => {
    const value = buildTranscriptExport(session, messages)
    expect(value.messages[0].content).toBe('Hello')
    expect(value.messages[1].content).toBe('')
    expect(value.messages[1].toolCalls[0].result).toBe('contents')
    expect(value.messages[1].toolCalls[0].input).toEqual({ path: 'a', token: '[REDACTED]' })
    expect(serializeTranscript(value, 'markdown')).not.toContain('private chain of thought')
  })

  it('serializes JSON without transport fields and sanitizes filenames', () => {
    const result = exportTranscript(session, messages, 'json')
    expect(result.filename).toBe('My-private-session-session-1.json')
    expect(JSON.parse(result.content)).toEqual(buildTranscriptExport(session, messages))
    expect(sanitizeTranscriptFilename('///')).toBe('session')
  })

  it('uses the selected plain text extension', () => {
    expect(exportTranscript(session, messages, 'text').filename.endsWith('.txt')).toBe(true)
  })

  it('redacts secrets embedded in tool output and errors', () => {
    const value = buildTranscriptExport(session, [{
      info: { id: 'm3', role: 'assistant', time: { created: 6 } },
      parts: [{ type: 'tool', id: 'p4', callID: 'c2', tool: 'run', state: { status: 'error', input: {}, output: 'Authorization: Bearer raw-token', error: 'api_key=raw-key', title: '', metadata: {}, time: { start: 6, end: 7 } } }],
    }] as unknown as MessageWithParts[])
    const serialized = serializeTranscript(value, 'json')
    expect(serialized).not.toContain('raw-token')
    expect(serialized).not.toContain('raw-key')
    expect(serialized).toContain('[REDACTED]')
  })
})
