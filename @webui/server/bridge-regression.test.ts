import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'

const bridge = readFileSync(join(import.meta.dir, '..', 'bridge.ts'), 'utf8')

function section(start: string, end: string): string {
  const begin = bridge.indexOf(start)
  const finish = bridge.indexOf(end, begin)
  expect(begin).toBeGreaterThanOrEqual(0)
  expect(finish).toBeGreaterThan(begin)
  return bridge.slice(begin, finish)
}

describe('bridge model delivery ordering', () => {
  it('does not persist a requested model until set_model succeeds', () => {
    const messagePost = section("path.length === 4 && path[3] === 'messages' && request.method === 'POST'", "path.length === 4 && path[3] === 'runs' && request.method === 'POST'")
    const run = section("path.length === 4 && path[3] === 'runs' && request.method === 'POST'", "path.length === 4 && path[3] === 'state' && request.method === 'GET'")

    expect(messagePost).not.toContain('model: record.model')
    expect(messagePost).toContain('profile: context.agentName')
    expect(run.indexOf("await sendRpc(id, { type: 'set_model'"))
      .toBeLessThan(run.indexOf('await persistSessionModel('))
    expect(run).toContain('interruptMessageDelivery(claimedDelivery)')
  })

  it('keeps queue routes behind the owned session lookup and separates steer from follow-up', () => {
    const sessionRoutes = section("if (path[1] === 'sessions' && path.length >= 3)", "if (path[1] === 'extensions'")
    expect(sessionRoutes.indexOf('const ownedRecord =')).toBeLessThan(sessionRoutes.indexOf("path[3] === 'steer'"))
    expect(sessionRoutes).toContain("type: 'steer'")
    expect(bridge).toContain('claimQueueEntry(database')
    expect(sessionRoutes).toContain("updateQueueEntry(database, ownerId, id, clientId, 'steering')")
    expect(sessionRoutes).toContain("'follow_up'")
    expect(sessionRoutes).toContain("clientId === 'clear'")
  })
})
