import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile, link } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { canonicalProjectPath, assertToolWorkspacePath } from '../core/project-filesystem.ts'
import { invokeExternalTool, executeCliTool, type ToolDefinition } from '../application/tools/tools.ts'

const tool = (operation: string, overrides: Partial<ToolDefinition> = {}): ToolDefinition => ({
  id: operation, tool_id: operation, namespace: 'pi', description: operation, adapter: 'internal', target: 'pi', operation,
  input_schema: {}, output_schema: {}, risk: 'read', requires_approval: false, enabled: true, metadata: {}, ...overrides,
})
const cli = tool('run', { target: 'cli', metadata: { cli: { executable: 'bun', fixedArgs: ['--version'], maxArgs: 0 } } })

describe('multi-user tool execution defaults', () => {
  let root: string
  let cwd: string
  let previousRoot: string | undefined
  let previousTrusted: string | undefined
  let client: any
  let context: { userId: string; agentName: string; sessionId: string; cwd: string; projectId: string }
  beforeEach(async () => {
    previousRoot = process.env.SUBPOLAR_PROJECTS_ROOT
    previousTrusted = process.env.SUBPOLAR_TRUSTED_HOST_EXECUTION
    delete process.env.SUBPOLAR_TRUSTED_HOST_EXECUTION
    root = canonicalProjectPath(await mkdtemp(join(tmpdir(), 'tool-execution-')))
    process.env.SUBPOLAR_PROJECTS_ROOT = root
    cwd = join(root, 'alice')
    await mkdir(cwd)
    await mkdir(join(root, 'bob'))
    await writeFile(join(root, 'bob', 'secret'), 'BOB PRIVATE')
    const rows: Record<string, any[]> = {
      projects: [
        { id: 'alice-project', user_id: 'alice', name: 'Alice', path: cwd, created_at: 1, updated_at: 1 },
        { id: 'bob-project', user_id: 'bob', name: 'Bob', path: join(root, 'bob'), created_at: 1, updated_at: 1 },
      ],
      sessions: [{ id: 'row', user_id: 'alice', session_id: 'session', project_id: 'alice-project', project_name: 'Alice', directory: cwd, title: 'Test', created_at: 1, updated_at: 1 }],
    }
    client = { collection: (name: string) => ({
      getFullList: async () => rows[name] ?? [],
      getFirstListItem: async (filter: string) => {
        const clauses = [...filter.matchAll(/([a-z_]+) = "([^"]*)"/g)]
                const record = (rows[name] ?? []).find(row => clauses.every(([, key, value]) => String(row[key]) === value))
        if (!record) throw { status: 404 }
        return record
      },
    }) }
    context = { userId: 'alice', agentName: 'master', sessionId: 'session', cwd, projectId: 'alice-project' }
  })
  afterEach(async () => {
    if (previousRoot === undefined) delete process.env.SUBPOLAR_PROJECTS_ROOT
    else process.env.SUBPOLAR_PROJECTS_ROOT = previousRoot
    if (previousTrusted === undefined) delete process.env.SUBPOLAR_TRUSTED_HOST_EXECUTION
    else process.env.SUBPOLAR_TRUSTED_HOST_EXECUTION = previousTrusted
    await rm(root, { recursive: true, force: true })
  })
  const invoke = (client: any, context: any, operation: string, input: unknown) => invokeExternalTool(client, tool(operation), input, context.cwd, 'call', context)

  it('retains relative read/write/edit/list in the exact owned cwd', async () => {
    await invoke(client, context, 'write', { path: 'nested/file.txt', content: 'before' })
    await invoke(client, context, 'edit', { path: 'nested/file.txt', edits: [{ oldText: 'before', newText: 'after' }] })
    expect(await readFile(join(cwd, 'nested/file.txt'), 'utf8')).toBe('after')
    expect(JSON.stringify(await invoke(client, context, 'read', { path: 'nested/file.txt' }))).toContain('after')
    expect(JSON.stringify(await invoke(client, context, 'ls', {}))).toContain('nested/')
  })

  it('denies absolute, traversal, home, SDK at-prefix and sibling paths for every file action', async () => {
    for (const operation of ['read', 'write', 'edit', 'ls']) {
      for (const path of [join(cwd, 'file'), '../bob/secret', '../../outside', '~/secret', '@/etc/passwd', '/etc/passwd']) {
        await expect(invoke(client, context, operation, { path, content: 'bad', edits: [] })).rejects.toThrow()
      }
    }
    expect(await readFile(join(root, 'bob/secret'), 'utf8')).toBe('BOB PRIVATE')
  })

  it('denies existing, internal, dangling and parent symlinks and hard links', async () => {
    await symlink(join(root, 'bob'), join(cwd, 'escape'))
    await symlink(join(cwd, 'missing'), join(cwd, 'dangling'))
    await writeFile(join(cwd, 'own'), 'own')
    await symlink(join(cwd, 'own'), join(cwd, 'internal'))
    await link(join(root, 'bob/secret'), join(cwd, 'hardlink'))
    for (const path of ['escape/secret', 'escape/new', 'dangling', 'internal', 'hardlink']) {
      await expect(invoke(client, context, 'read', { path })).rejects.toThrow()
      await expect(invoke(client, context, 'write', { path, content: 'bad' })).rejects.toThrow()
    }
    expect(JSON.stringify(await invoke(client, context, 'ls', {}))).not.toContain('escape')
    expect(() => assertToolWorkspacePath(cwd, '../bob/secret')).toThrow()
  })

  it('rejects missing ownership, foreign owner/project and non-exact cwd', async () => {
    await expect(invokeExternalTool(client, tool('ls'), {}, cwd, 'call')).rejects.toThrow('owned session')
    for (const altered of [{ userId: 'bob' }, { sessionId: 'missing' }, { projectId: 'bob-project' }, { cwd: root }, { cwd: join(cwd, 'nested') }]) {
      await expect(invoke(client, { ...context, ...altered }, 'ls', {})).rejects.toThrow()
    }
  })

  it('never falls back to process cwd or a global General Chat workspace', async () => {
    const generalClient = { collection: (name: string) => ({
      getFirstListItem: async () => name === 'sessions' ? { id: 'row', user_id: 'alice', session_id: 'session', project_name: 'General Chat', title: 'Test', created_at: 1, updated_at: 1 } : null,
      getFullList: async () => [],
    }) } as never
    await expect(invoke(generalClient, { ...context, projectId: undefined }, 'ls', {})).rejects.toThrow('exactly match')
  })

  it('fails closed before shell, stdin/local program and MCP stdio startup despite caller capabilities', async () => {
    const marker = join(cwd, 'executed')
    for (const operation of ['bash', 'grep', 'find']) {
      await expect(invoke(client, context, operation, { command: `touch ${marker}`, pattern: '.' })).rejects.toThrow('isolated tenant worker')
    }
    await expect(executeCliTool(cli, { args: [] }, cwd)).rejects.toThrow('host execution is disabled')
    await expect(invokeExternalTool(client, cli, { args: [] }, cwd, 'call', { ...context, capabilities: ['trusted-sandbox', 'host-execution'] })).rejects.toThrow('host execution is disabled')
    for (const metadata of [{}, { transport: 'stdio' }, { mcp: { transport: 'stdio', command: 'bun', args: ['-e', `Bun.write(${JSON.stringify(marker)}, 'bad')`] } }]) {
      const mcp = tool('run', { adapter: 'mcp', target: 'bun', namespace: 'local', metadata })
      await expect(invokeExternalTool(client, mcp, {}, cwd, 'call', context)).rejects.toThrow('stdio')
    }
    await expect(readFile(marker)).rejects.toThrow()
  })

  it('rejects browser transfers and HTTP/MCP server-environment credential references', async () => {
    for (const operation of ['download', 'upload', 'evaluate']) {
      await expect(invokeExternalTool(client, tool(operation, { target: 'browser' }), { path: '../bob/secret' }, cwd, 'call', context)).rejects.toThrow('disabled')
    }
    for (const adapter of ['http', 'mcp'] as const) {
      await expect(invokeExternalTool(client, tool('lookup', { adapter, target: 'https://1.1.1.1', metadata: { headers: { Authorization: { env: 'PB_ADMIN_TOKEN' } } } }), {}, cwd, 'call', context)).rejects.toThrow('environment secrets')
    }
  })

  it('keeps registered HTTP requests under network policy', async () => {
    await expect(invokeExternalTool(client, tool('lookup', { adapter: 'http', target: 'http://127.0.0.1/private' }), {}, cwd, 'call', context)).rejects.toThrow('private host')
  })

  it('verifies default denial and trusted CLI environment in real Bun subprocesses', async () => {
    const probe = join(cwd, 'probe.ts')
    await writeFile(probe, 'console.log(JSON.stringify(process.env))')
    const runner = `import { executeCliTool } from ${JSON.stringify(new URL('../application/tools/tools.ts', import.meta.url).href)};
      try { const result = await executeCliTool(${JSON.stringify({ ...cli, metadata: { cli: { executable: 'bun', fixedArgs: [probe], maxArgs: 0 } } })}, { args: [] }, ${JSON.stringify(cwd)}); console.log(result.stdout); }
      catch (error) { console.error(error.message); process.exit(1); }`
    const run = async (trusted: string) => {
      const child = Bun.spawn([process.execPath, '-e', runner], {
        cwd, stdout: 'pipe', stderr: 'pipe', timeout: 20000,
        env: { ...process.env, SUBPOLAR_TRUSTED_HOST_EXECUTION: trusted, PB_ADMIN_TOKEN: 'private-pb', OPENAI_API_KEY: 'private-provider', SUBPOLAR_INTERNAL_SECRET: 'private-internal' },
      })
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
      return { stdout, stderr, code }
    }
    const denied = await run('false')
    expect(denied.code).toBe(1)
    expect(denied.stderr).toContain('host execution is disabled')
    const trusted = await run('true')
    expect(trusted.code).toBe(0)
    const env = JSON.parse(trusted.stdout.trim())
    expect(env.HOME).toBe(cwd)
    for (const key of ['PB_ADMIN_TOKEN', 'OPENAI_API_KEY', 'SUBPOLAR_INTERNAL_SECRET', 'SUBPOLAR_TRUSTED_HOST_EXECUTION']) expect(env[key]).toBeUndefined()
  }, 30000)

  it('keeps MCP stdio disabled even with the operator host CLI opt-out', async () => {
    process.env.SUBPOLAR_TRUSTED_HOST_EXECUTION = 'true'
    await expect(invokeExternalTool(client, tool('run', { adapter: 'mcp', target: 'bun' }), {}, cwd, 'call', context)).rejects.toThrow('stdio')
  })
})
