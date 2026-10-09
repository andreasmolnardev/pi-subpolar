import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'bun:test'

const bridge = readFileSync(new URL('../../bridge-runtime.ts', import.meta.url), 'utf8')
const durableExecution = bridge.slice(bridge.indexOf('async function executeStatelessPrompt('), bridge.indexOf('function redactConfig('))

describe('Durable transcript bridge projection', () => {
  it('reads and owner-scoped persists transcript after execution settles, before engine close', () => {
    const wait = durableExecution.indexOf('await engine.wait(')
    const transcriptRead = durableExecution.indexOf('await engine.readTranscript(ownerId, input.sessionId)')
    const repositoryRead = durableExecution.indexOf('new SessionTranscriptRepository(client)', transcriptRead)
    const close = durableExecution.indexOf('await engine.close()', transcriptRead)

    expect(wait).toBeGreaterThanOrEqual(0)
    expect(transcriptRead).toBeGreaterThan(wait)
    expect(repositoryRead).toBeGreaterThan(transcriptRead)
    expect(durableExecution.slice(transcriptRead, close)).toContain('mergeDurableTranscript')
    expect(durableExecution.slice(transcriptRead, close)).toContain('repository.save(ownerId, input.sessionId')
    expect(durableExecution.slice(transcriptRead, close)).toContain('catch (projectionError)')
    expect(durableExecution.slice(transcriptRead, close)).toContain('redactedDiagnostic(projectionError)')
  })
})
