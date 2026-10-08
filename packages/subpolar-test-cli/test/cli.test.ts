import { describe, expect, test } from 'bun:test'
import { parseScenario, runCli } from '../src/cli.ts'

const response = (value: unknown, status = 200) => Response.json(value, { status })

describe('@subpolar/test-cli', () => {
  test('parses documented YAML and JSON scenarios', () => {
    expect(parseScenario('title: quick\nproject: 7\nmessages:\n  - hello\n  - world\n')).toEqual({ title: 'quick', project: 7, messages: ['hello', 'world'] })
    expect(parseScenario('{"messages":["hello"]}')).toEqual({ messages: ['hello'] })
    expect(() => parseScenario('unknown: true')).toThrow('Unsupported scenario YAML')
  })

  test('uses the default URL and client routes for project listing', async () => {
    const out: string[] = []
    const requests: Request[] = []
    const code = await runCli(['projects', 'list', '--json'], {
      io: { stdout: (value) => out.push(value), stderr: () => undefined },
      fetch: async (input, init) => {
        const request = new Request(input, init)
        requests.push(request)
        return response({ projects: [{ id: 1, name: 'demo' }] })
      },
    })
    expect(code).toBe(0)
    expect(new URL(requests[0]!.url).href).toBe('http://localhost:4173/api/projects')
    expect(requests[0]!.headers.get('x-request-id')).toMatch(/^subpolar-test-/)
    expect(JSON.parse(out[0]!).data).toEqual([{ id: 1, name: 'demo' }])
  })

  test('passes authorized session configuration into session creation', async () => {
    let body: Record<string, unknown> | undefined
    const code = await runCli(['sessions', 'create', '--title', 'test', '--project', 'p1', '--directory', '/workspace', '--agent', 'helper', '--model', 'openai/gpt', '--thinking', 'medium', '--permission', 'ask', '--worktree', 'wt1'], {
      io: { stdout: () => undefined },
      fetch: async (input, init) => {
        const request = new Request(input, init)
        body = await request.json() as Record<string, unknown>
        return response({ session: { id: 's1', title: 'test', updatedAt: 1 } }, 201)
      },
    })
    expect(code).toBe(0)
    expect(body).toEqual({ title: 'test', project: 'p1', directory: '/workspace', agent: 'helper', model: 'openai/gpt', thinking: 'medium', permission: 'ask', worktreeId: 'wt1' })
  })

  test('lists agents and provider catalog through the shared client', async () => {
    const urls: string[] = []
    const code = await runCli(['agents', 'list', '--json'], { io: { stdout: () => undefined }, fetch: async (input) => { urls.push(String(input)); return response([{ id: 'a1', name: 'helper' }]) } })
    expect(code).toBe(0)
    expect(urls[0]).toContain('/api/agents')
  })

  test('reports run inspection as unavailable when no public route exists', async () => {
    const out: string[] = []
    const code = await runCli(['runs', 'inspect', 'r1', '--json'], { io: { stdout: (value) => out.push(value) }, fetch: async () => { throw new Error('must not fetch') } })
    expect(code).toBe(5)
    expect(JSON.parse(out[0]!).error.code).toBe('UNSUPPORTED')
  })

  test('sends a message with stable request and message IDs', async () => {
    const requests: Request[] = []
    const code = await runCli(['sessions', 'send', 's-1', 'hello there'], {
      io: { stdout: () => undefined },
      fetch: async (input, init) => {
        const request = new Request(input, init); requests.push(request)
        if (request.url.endsWith('/messages')) return response({ messageID: 'm-1', state: 'pending' }, 201)
        return response({ state: 'completed' })
      },
    })
    expect(code).toBe(0)
    const firstBody = await requests[0]!.json() as Record<string, unknown>
    expect(firstBody.messageID).toBe(requests[0]!.headers.get('x-request-id'))
    expect((firstBody.metadata as Record<string, unknown>).requestId).toBe(requests[0]!.headers.get('x-request-id'))
    expect(requests[1]!.headers.get('x-request-id')).toBe(requests[0]!.headers.get('x-request-id'))
  })

  test('maps authentication failures to exit code 4', async () => {
    const code = await runCli(['projects', 'list'], { io: { stderr: () => undefined }, fetch: async () => response({ error: { code: 'UNAUTHENTICATED', message: 'Sign in' } }, 401) })
    expect(code).toBe(4)
  })

  test('maps timed out requests to exit code 3', async () => {
    const code = await runCli(['--timeout', '5', 'projects', 'list'], {
      io: { stderr: () => undefined },
      fetch: async (_input, init) => new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })),
    })
    expect(code).toBe(3)
  })
})
