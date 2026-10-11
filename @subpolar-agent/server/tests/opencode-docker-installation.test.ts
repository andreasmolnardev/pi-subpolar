import { describe, expect, it } from 'bun:test'
import { OpenCodeDockerInstallation } from '../application/runtime/opencode-docker-installation.ts'
import { handleSettingsRoute } from '../routes/settings.ts'

const running = JSON.stringify({ State: 'running' })

describe('OpenCode Docker installation manager', () => {
  it('builds and starts only the pinned Compose runtime and reports its persistent installation', async () => {
    const calls: string[][] = []
    const manager = new OpenCodeDockerInstallation(async (args) => {
      calls.push([...args])
      if (args.includes('ps')) return { stdout: `${running}\n`, stderr: '' }
      if (args.includes('exec')) return { stdout: 'opencode v2.0.26\n09632275534db1df1c158329fdc4e9fd7fe5d9dbc79cff090314553ec00757f1  /var/lib/subpolar/opencode/opencode\n', stderr: '' }
      return { stdout: '', stderr: '' }
    }, async () => undefined)

    const status = await manager.install()

    expect(status).toMatchObject({ installed: true, running: true, version: 'opencode v2.0.26', persistentVolume: 'opencode_installation' })
    expect(calls[0]?.slice(-2)).toEqual(['build', 'opencode-v2'])
    expect(calls[1]?.slice(-3)).toEqual(['up', '-d', 'opencode-v2'])
    expect(calls[2]).toContain('--format')
    expect(calls.every((args) => args.some((arg) => arg.endsWith('deployment/external-agent-runtime/compose.yaml')))).toBe(true)
  })

  it('requires the isolated container checks and real ACP lifecycle verifier', async () => {
    let verifiedAcp = false
    const manager = new OpenCodeDockerInstallation(async (args) => {
      if (args.includes('ps')) return { stdout: `${running}\n`, stderr: '' }
      if (args.includes('sha256sum')) return { stdout: 'hash  binary\n', stderr: '' }
      if (args.includes('sh')) return { stdout: 'opencode v2.0.26\n09632275534db1df1c158329fdc4e9fd7fe5d9dbc79cff090314553ec00757f1  binary\n', stderr: '' }
      return { stdout: 'opencode v2.0.26\n', stderr: '' }
    }, async () => { verifiedAcp = true })

    const result = await manager.check()
    expect(result).toMatchObject({ installed: true, verified: true, acp: 'initialize/session-new/session-close' })
    expect(verifiedAcp).toBe(true)
  })

  it('fails closed when the persistent binary is missing or has the wrong version', async () => {
    const manager = new OpenCodeDockerInstallation(async (args) => args.includes('ps')
      ? { stdout: `${running}\n`, stderr: '' }
      : { stdout: 'opencode v2.0.25\n', stderr: '' }, async () => undefined)

    await expect(manager.check()).rejects.toThrow('not installed and running')
  })
})

describe('OpenCode Docker settings route', () => {
  it('reports an explicit disabled state without attempting Docker access', async () => {
    const previous = process.env.SUBPOLAR_ENABLE_OPENCODE_DOCKER_INSTALLER
    delete process.env.SUBPOLAR_ENABLE_OPENCODE_DOCKER_INSTALLER
    try {
      const url = new URL('http://localhost/api/settings/agent-runtime/opencode')
      const response = await handleSettingsRoute({
        request: new Request(url.href), url,
        path: ['api', 'settings', 'agent-runtime', 'opencode'],
        correlationId: 'runtime-test', authenticatedUser: { id: 'owner-a' }, gatewayCredential: null, internalRequest: false,
        deps: { json: (value: unknown, status = 200) => Response.json(value, { status }) },
      } as never)
      expect(response?.status).toBe(200)
      await expect(response?.json()).resolves.toMatchObject({ enabled: false, installed: false, provider: 'opencode-v2' })
    } finally {
      if (previous === undefined) delete process.env.SUBPOLAR_ENABLE_OPENCODE_DOCKER_INSTALLER
      else process.env.SUBPOLAR_ENABLE_OPENCODE_DOCKER_INSTALLER = previous
    }
  })

  it('requires an authenticated owner before exposing installation operations', async () => {
    let touched = false
    const url = new URL('http://localhost/api/settings/agent-runtime/opencode/install')
    const response = await handleSettingsRoute({
      request: new Request(url.href, { method: 'POST' }), url,
      path: ['api', 'settings', 'agent-runtime', 'opencode', 'install'],
      correlationId: 'runtime-test', authenticatedUser: null, gatewayCredential: null, internalRequest: false,
      deps: { openCodeDockerInstallation: { install: async () => { touched = true } }, json: (value: unknown, status = 200) => Response.json(value, { status }) },
    } as never)
    expect(response?.status).toBe(401)
    expect(touched).toBe(false)
  })

  it('dispatches only the fixed install and check actions to the server runtime manager', async () => {
    const calls: string[] = []
    const manager = {
      status: async () => ({ provider: 'opencode-v2', enabled: true, installed: true }),
      install: async () => { calls.push('install'); return { installed: true } },
      check: async () => { calls.push('check'); return { verified: true } },
    }
    const request = async (operation: 'install' | 'check') => {
      const url = new URL(`http://localhost/api/settings/agent-runtime/opencode/${operation}`)
      return handleSettingsRoute({
        request: new Request(url.href, { method: 'POST' }), url,
        path: ['api', 'settings', 'agent-runtime', 'opencode', operation],
        correlationId: 'runtime-test', authenticatedUser: { id: 'owner-a' }, gatewayCredential: null, internalRequest: false,
        deps: { openCodeDockerInstallation: manager, json: (value: unknown, status = 200) => Response.json(value, { status }) },
      } as never)
    }
    const installed = await request('install')
    const checked = await request('check')
    expect(installed?.status).toBe(201)
    expect(checked?.status).toBe(200)
    expect(calls).toEqual(['install', 'check'])
  })
})
