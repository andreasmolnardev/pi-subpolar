import { describe, expect, test } from 'bun:test'
import { runCli } from '../src/cli.ts'

const response = (value: unknown, status = 200) => Response.json(value, { status })

describe('@subpolar/test-cli', () => {
  test('lists projects through the client using the default URL and request ID', async () => {
    const out: string[] = []; const requests: Request[] = []
    const code = await runCli(['projects', 'list', '--json'], {
      io: { stdout: (value) => out.push(value) },
      fetch: async (input, init) => {
        const request = new Request(input, init); requests.push(request)
        return response({ projects: [{ id: 1, name: 'demo' }] })
      },
    })
    expect(code).toBe(0)
    expect(requests[0]!.url).toBe('http://localhost:4173/api/projects')
    expect(requests[0]!.headers.get('x-request-id')).toMatch(/^subpolar-cli-/)
    expect(JSON.parse(out[0]!).data).toEqual([{ id: 1, name: 'demo' }])
  })

  test('resolves a named environment and passes the user token', async () => {
    const priorUrl = process.env.SUBPOLAR_ENV_DEV_URL; const priorToken = process.env.SUBPOLAR_ENV_DEV_TOKEN
    process.env.SUBPOLAR_ENV_DEV_URL = 'http://localhost:9999'
    process.env.SUBPOLAR_ENV_DEV_TOKEN = 'user-token'
    let request: Request | undefined
    try {
      const code = await runCli(['--env', 'dev', 'projects', 'list'], {
        io: { stdout: () => undefined }, fetch: async (input, init) => { request = new Request(input, init); return response({ projects: [] }) },
      })
      expect(code).toBe(0)
      expect(request?.url).toBe('http://localhost:9999/api/projects')
      expect(request?.headers.get('authorization')).toBe('Bearer user-token')
    } finally {
      if (priorUrl === undefined) delete process.env.SUBPOLAR_ENV_DEV_URL; else process.env.SUBPOLAR_ENV_DEV_URL = priorUrl
      if (priorToken === undefined) delete process.env.SUBPOLAR_ENV_DEV_TOKEN; else process.env.SUBPOLAR_ENV_DEV_TOKEN = priorToken
    }
  })

  test('creates, updates, and deletes projects through owner-scoped client routes', async () => {
    const requests: Request[] = []
    const responses = [
      response({ id: 1, name: 'demo' }, 201),
      response({ id: 1, name: 'renamed' }),
      response({ ok: true }),
    ]
    for (const args of [
      ['projects', 'create', 'demo', '--directory', '/workspace', '--agents', 'master,helper'],
      ['projects', 'update', '1', '--name', 'renamed', '--agents', 'master'],
      ['projects', 'delete', '1'],
    ]) {
      const result = await runCli([...args, '--json'], {
        io: { stdout: () => undefined }, fetch: async (input, init) => { requests.push(new Request(input, init)); return responses.shift()! },
      })
      expect(result).toBe(0)
    }
    expect(requests.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual([
      'POST /api/projects', 'PATCH /api/projects/1', 'DELETE /api/projects/1',
    ])
    expect(await requests[0]!.json()).toEqual({ name: 'demo', directory: '/workspace', agentNames: ['master', 'helper'] })
    expect(await requests[1]!.json()).toEqual({ name: 'renamed', agentNames: ['master'] })
  })

  test('creates a session with the requested interactive configuration', async () => {
    let body: Record<string, unknown> | undefined
    const code = await runCli(['sessions', 'create', '--title', 'debug', '--project', 'p1', '--directory', '/workspace', '--agent', 'helper', '--model', 'openai/gpt', '--thinking', 'medium', '--permission', 'ask', '--worktree', 'wt1'], {
      io: { stdout: () => undefined }, fetch: async (input, init) => {
        body = await new Request(input, init).json() as Record<string, unknown>
        return response({ session: { id: 's1', title: 'debug', updatedAt: 1 } }, 201)
      },
    })
    expect(code).toBe(0)
    expect(body).toEqual({ title: 'debug', project: 'p1', directory: '/workspace', agent: 'helper', model: 'openai/gpt', thinking: 'medium', permission: 'ask', worktreeId: 'wt1' })
  })

  test('sends with stable request and message IDs, and follows typed SSE events', async () => {
    const out: string[] = []; const requests: Request[] = []
    let streamSignal: AbortSignal | undefined
    const code = await runCli(['sessions', 'send', 's-1', 'hello there', '--follow', '--limit', '1', '--json'], {
      io: { stdout: (value) => out.push(value) },
      fetch: async (input, init) => {
        const request = new Request(input, init); requests.push(request)
        if (request.url.endsWith('/messages')) return response({ messageID: 'm-1', state: 'pending' }, 201)
        if (request.url.endsWith('/runs')) return response({ runId: 'r-1', state: 'running' })
        if (request.url.includes('/api/sse/stream')) { streamSignal = init?.signal ?? undefined; return new Response('id: 2\nevent: tool_call\ndata: {"name":"lookup"}\n\n', { headers: { 'content-type': 'text/event-stream' } }) }
        throw new Error(`Unexpected request ${request.url}`)
      },
    })
    expect(code).toBe(0)
    const messageRequest = requests.find((request) => request.url.endsWith('/messages'))!
    const requestId = messageRequest.headers.get('x-request-id')
    const messageBody = await messageRequest.json() as Record<string, unknown>
    expect(messageBody.messageID).toBe(requestId)
    expect((messageBody.metadata as Record<string, unknown>).requestId).toBe(requestId)
    expect(requests.every((request) => request.headers.get('x-request-id') === requestId)).toBe(true)
    expect(streamSignal?.aborted).toBe(true)
    expect(requests.findIndex((request) => request.url.includes('/api/sse/stream'))).toBeLessThan(requests.findIndex((request) => request.url.endsWith('/messages')))
    expect(JSON.parse(out[0]!)).toMatchObject({ event: 'stream', type: 'tool_call', id: '2', data: { name: 'lookup' } })
    expect(JSON.parse(out[1]!)).toMatchObject({ event: 'result', ok: true })
  })

  test('preserves option-like prompt text after the argument delimiter', async () => {
    let messageBody: Record<string, unknown> | undefined
    const code = await runCli(['sessions', 'send', 's1', '--', 'do not interpret', '--token', 'as credentials'], {
      io: { stdout: () => undefined }, fetch: async (input, init) => {
        const request = new Request(input, init)
        if (request.url.endsWith('/messages')) messageBody = await request.json() as Record<string, unknown>
        return response(request.url.endsWith('/messages') ? { messageID: 'm1', state: 'pending' } : { state: 'running' })
      },
    })
    expect(code).toBe(0)
    expect(messageBody?.content).toBe('do not interpret --token as credentials')
  })

  test('keeps the request timeout from truncating a live event stream', async () => {
    const out: string[] = []
    const code = await runCli(['sessions', 'events', 's1', '--limit', '1', '--timeout', '5', '--json'], {
      io: { stdout: (value) => out.push(value) },
      fetch: async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          setTimeout(() => {
            controller.enqueue(new TextEncoder().encode(['id: 7', 'event: status', 'data: {"state":"running"}', '', ''].join('\n')))
            controller.close()
          }, 20)
        },
      }), { headers: { 'content-type': 'text/event-stream' } }),
    })
    expect(code).toBe(0)
    expect(out.join('')).toContain('"type":"status"')
  })

  test('inspects sessions and filters errors using client operations', async () => {
    const urls: string[] = []
    const code = await runCli(['sessions', 'errors', 's1', '--json'], {
      io: { stdout: () => undefined }, fetch: async (input) => {
        const url = String(input); urls.push(url)
        if (url.endsWith('/messages')) return response({ messages: [{ role: 'assistant' }, { type: 'error', error: 'failed' }] })
        throw new Error(`Unexpected request ${url}`)
      },
    })
    expect(code).toBe(0)
    expect(urls[0]).toContain('/api/sessions/s1/messages')
  })

  test('inspects a specific session tool call through the shared client', async () => {
    let url = ''
    const code = await runCli(['sessions', 'tool-call', 's1', 'call/1', '--json'], {
      io: { stdout: () => undefined },
      fetch: async (input) => { url = String(input); return response({ callID: 'call/1', tool: 'web.search', error: null, output: 'results' }) },
    })
    expect(code).toBe(0)
    expect(url).toContain('/api/sessions/s1/tool-calls/call%2F1')
  })

  test('lists and decides approvals through client methods', async () => {
    const requests: Request[] = []
    const code = await runCli(['approvals', 'decision', 'a1', '--session', 's1', '--response', 'approve', '--json'], {
      io: { stdout: () => undefined }, fetch: async (input, init) => { requests.push(new Request(input, init)); return response({ approved: true }) },
    })
    expect(code).toBe(0)
    expect(requests[0]!.url).toContain('/api/session/s1/permissions/a1')
    expect(await requests[0]!.json()).toEqual({ response: 'approve' })
  })

  test('lists tools through the client and does not guess API routes', async () => {
    const out: string[] = []; let url = ''
    const code = await runCli(['tools', 'list', '--json'], {
      io: { stdout: (value) => out.push(value) }, fetch: async (input) => {
        url = String(input)
        return response({ tools: [{ tool_id: 'shell', name: 'Shell' }] })
      },
    })
    expect(code).toBe(0)
    expect(url).toContain('/api/settings/subpolar-tools')
    expect(JSON.parse(out[0]!).data).toEqual([{ tool_id: 'shell', name: 'Shell' }])
  })

  test('inspects runs through the owner-scoped client route', async () => {
    let url = ''
    const code = await runCli(['runs', 'inspect', 'run-1', '--json'], {
      io: { stdout: () => undefined }, fetch: async (input) => { url = String(input); return response({ run: { id: 'run-1', state: 'completed' } }) },
    })
    expect(code).toBe(0)
    expect(url).toContain('/api/runs/run-1')
  })

  test('updates session model and creates worktrees through the client', async () => {
    const requests: Request[] = []
    const code = await runCli(['sessions', 'update', 's1', '--model', 'openai/gpt-6', '--json'], {
      io: { stdout: () => undefined }, fetch: async (input, init) => {
        const request = new Request(input, init); requests.push(request)
        return response({ session: { id: 's1', title: 'debug', model: 'openai/gpt-6', updatedAt: 2 } })
      },
    })
    expect(code).toBe(0)
    expect(requests[0]!.url).toContain('/api/sessions/s1')
    expect(await requests[0]!.json()).toEqual({ model: 'openai/gpt-6' })

    const worktreeCode = await runCli(['worktrees', 'create', 'project-1', '--branch', 'debug', '--source-ref', 'main', '--expected-sha', 'abc123'], {
      io: { stdout: () => undefined }, fetch: async (input, init) => {
        const request = new Request(input, init); requests.push(request)
        return response({ worktree: { id: 'wt1', branch: 'debug' } }, 201)
      },
    })
    expect(worktreeCode).toBe(0)
    expect(requests[1]!.url).toContain('/api/projects/project-1/repository/worktrees')
    expect(await requests[1]!.json()).toEqual({ approved: true, branch: 'debug', sourceRef: 'main', expectedSha: 'abc123' })
  })

  test('reads project repository status through the shared client operation', async () => {
    const out: string[] = []; let request: Request | undefined
    const code = await runCli(['repository', 'status', 'project/one', '--json'], {
      io: { stdout: (value) => out.push(value) },
      fetch: async (input, init) => {
        request = new Request(input, init)
        return response({ repository: { root: '/workspace/project', gitDir: '/workspace/project/.git', bare: false, head: 'abc123' }, status: { branch: 'main', ahead: 0, behind: 0, entries: [], omitted: [], truncated: false }, requestId: 'req-1' })
      },
    })
    expect(code).toBe(0)
    expect(request?.method).toBe('GET')
    expect(request?.url).toContain('/api/projects/project%2Fone/repository/status')
    expect(JSON.parse(out[0]!).data.status.branch).toBe('main')
  })

  test('updates agent tool policies through the client', async () => {
    let request: Request | undefined
    const code = await runCli(['tools', 'policies', 'set', 'master', '--policy=shell=deny', '--policy=read=allow'], {
      io: { stdout: () => undefined }, fetch: async (input, init) => { request = new Request(input, init); return response({ policies: [] }) },
    })
    expect(code).toBe(0)
    expect(request?.url).toContain('/api/settings/agents/master/tool-policies')
    expect(await request!.json()).toEqual({ policies: [{ toolId: 'shell', effect: 'deny' }, { toolId: 'read', effect: 'allow' }] })
  })

  test('inspects and updates settings through the client', async () => {
    const requests: Request[] = []
    const code = await runCli(['settings', 'update', '--theme', 'dark', '--enabled', 'true', '--json'], {
      io: { stdout: () => undefined }, fetch: async (input, init) => {
        const request = new Request(input, init); requests.push(request)
        return response({ preferences: { theme: 'dark', enabled: true } })
      },
    })
    expect(code).toBe(0)
    expect(requests[0]!.url).toContain('/api/settings')
    expect(await requests[0]!.json()).toEqual({ preferences: { theme: 'dark', enabled: true } })
  })

  test('maps authentication failures and timeouts to useful exits', async () => {
    const authCode = await runCli(['projects', 'list'], { io: { stderr: () => undefined }, fetch: async () => response({ error: { code: 'UNAUTHENTICATED', message: 'Sign in' } }, 401) })
    expect(authCode).toBe(4)
    const timeoutCode = await runCli(['--timeout', '5', 'projects', 'list'], {
      io: { stderr: () => undefined },
      fetch: async (_input, init) => new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })),
    })
    expect(timeoutCode).toBe(3)
  })

  test('rejects incomplete interactive commands as usage errors', async () => {
    const out: string[] = []
    const code = await runCli(['sessions', 'send', '--json'], { io: { stdout: (value) => out.push(value) }, fetch: async () => { throw new Error('must not fetch') } })
    expect(code).toBe(2)
    expect(JSON.parse(out[0]!).error.code).toBe('USAGE')
  })
})
