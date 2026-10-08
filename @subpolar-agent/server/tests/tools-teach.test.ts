import { describe, expect, it } from 'vitest'
import { proposeTools, registerToolDraft, runSafeCliIntrospection } from '../application/tools/tools-teach.ts'

describe('Settings tools teach', () => {
  it('runs only allowlisted help-style CLI introspection', async () => {
    await expect(runSafeCliIntrospection('git', ['--version'])).resolves.toMatch(/git version/i)
    await expect(runSafeCliIntrospection('git', ['status'])).rejects.toThrow('allowlisted')
    await expect(runSafeCliIntrospection('sh', ['-c'])).rejects.toThrow('supported executable')
    await expect(runSafeCliIntrospection('git; touch /tmp/pwned')).rejects.toThrow('supported executable')
  })

  it('returns disabled, unregistered CLI proposals with bounded safe invocation metadata', async () => {
    const result = await proposeTools({ kind: 'cli', goal: 'show version', command: 'git', fixedArgs: ['--version'] })
    expect(result.drafts).toHaveLength(1)
    expect(result.drafts[0]).toMatchObject({ adapter: 'internal', target: 'cli', operation: 'run', enabled: false, requires_approval: true })
    expect(result.drafts[0].metadata.cli).toMatchObject({ executable: 'git', fixedArgs: [], maxArgs: 12 })
    expect(result.observations.join(' ')).toContain('no tool operation was invoked')
  })

  it('applies bounded CLI command suggestions returned by the internal model', async () => {
    const result = await proposeTools({ kind: 'cli', goal: 'show the current branch', command: 'git', fixedArgs: ['--help'] }, async () => ({ drafts: [{ tool_id: 'git/show_the_current_branch', description: 'Show the current branch', fixedArgs: ['branch', '--show-current'], maxArgs: 0 }] }))
    expect(result.drafts[0]?.metadata.cli).toMatchObject({ executable: 'git', fixedArgs: ['branch', '--show-current'], maxArgs: 0 })
    expect(result.drafts[0]?.input_schema.properties).toMatchObject({ args: { maxItems: 0 } })
    await expect(proposeTools({ kind: 'cli', goal: 'show the current branch', command: 'git' }, async () => ({ drafts: [{ tool_id: 'git/show_the_current_branch', description: 'bad', fixedArgs: ['bad\ncommand'] }] }))).rejects.toThrow('invalid CLI command arguments')
  })

  it('derives OpenAPI drafts from supplied schemas without making a request or exposing secret fields', async () => {
    const result = await proposeTools({
      kind: 'openapi', goal: 'get item', openapi: {
        url: 'https://example.test/api',
        spec: { openapi: '3.0.0', paths: { '/items/{id}': { get: {
          operationId: 'getItem', summary: 'Get an item', parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'api_key', in: 'query', schema: { type: 'string', default: 'should-not-appear' } },
          ], responses: { '200': { description: 'ok' } },
        } } } },
      },
    })
    expect(result.drafts[0]).toMatchObject({ adapter: 'openapi', target: 'https://example.test/api', enabled: false, risk: 'read', metadata: { url: 'https://example.test/api/items/{id}', method: 'GET', parameters: [{ name: 'id', in: 'path', required: true }] } })
    expect(JSON.stringify(result)).not.toContain('should-not-appear')
    expect(result.observations.join(' ')).toContain('no request was sent')
  })

  it('uses the internal draft generator only to select known source-backed operations', async () => {
    const result = await proposeTools({ kind: 'openapi', goal: 'retrieve the item', openapi: { url: 'https://example.test', spec: { openapi: '3.0.0', paths: { '/items': { get: { operationId: 'listItems', summary: 'List items' } }, '/users': { get: { operationId: 'listUsers', summary: 'List users' } } } } } }, async ({ drafts }) => ({ drafts: [{ tool_id: drafts[1].tool_id, description: 'List matching user records' }] }))
    expect(result.drafts).toHaveLength(1)
    expect(result.drafts[0]).toMatchObject({ operation: 'listusers', description: 'List matching user records' })
    await expect(proposeTools({ kind: 'openapi', goal: 'retrieve the item', openapi: { url: 'https://example.test', spec: { openapi: '3.0.0', paths: { '/items': { get: { operationId: 'listItems' } } } } } }, async () => ({ drafts: [{ tool_id: 'invented/tool', description: 'invented' }] }))).rejects.toThrow('unknown or duplicate')
  })

  it('rejects unsafe OpenAPI targets and unsupported CLI commands', async () => {
    await expect(proposeTools({ kind: 'openapi', goal: 'inspect', openapi: { url: 'https://user:pass@example.test', spec: { openapi: '3.0.0', paths: { '/x': { get: {} } } } } })).rejects.toThrow('credentials or secret query parameters')
    await expect(proposeTools({ kind: 'mcp', goal: 'inspect', server: { transport: 'http', url: 'https://example.test/mcp?api_key=secret' } })).rejects.toThrow('credentials or secret query parameters')
    await expect(proposeTools({ kind: 'cli', goal: 'do a thing', command: 'sh' })).rejects.toThrow('supported executable')
  })

  it('routes explicit draft registration through owner-scoped registry validation', async () => {
    const records: Array<Record<string, unknown>> = []
    const collection = () => ({
      getFullList: async () => records,
      getFirstListItem: async () => null,
      create: async (input: Record<string, unknown>) => { const result = { id: 'created', ...input }; records.push(result); return result },
      update: async () => { throw new Error('unexpected update') },
      delete: async () => undefined,
    })
    const client = { collection } as never
    const draft = (await proposeTools({ kind: 'openapi', goal: 'get item', openapi: { url: 'https://example.test', spec: { openapi: '3.0.0', paths: { '/items': { get: { operationId: 'getItems' } } } } } })).drafts[0]
    const result = await registerToolDraft(client, 'user-a', draft) as Record<string, unknown>
    expect(result.tool_id).toBe(draft.tool_id)
    expect(records[0]?.owner_id).toBe('user-a')
    expect(records[0]?.enabled).toBe(true)
    await expect(registerToolDraft(client, 'user-b', { ...draft, adapter: 'internal', target: 'subagent', operation: 'run' })).rejects.toThrow('Only constrained CLI drafts')
  })
})
