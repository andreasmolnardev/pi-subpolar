import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { parseMcpCommand, validateMcpServerInput } from './mcp'
import { settingsApi } from './settings'
import { AddMcpServerDialog } from '../components/settings/AddMcpServerDialog'
import { McpManager } from '../components/settings/McpManager'

const lifecycle = vi.hoisted(() => ({
  addServerAsync: vi.fn(), connectAsync: vi.fn(), disconnectAsync: vi.fn(),
  refetch: vi.fn(async () => ({})), removeAuthAsync: vi.fn(),
}))
vi.mock('@/hooks/useMcpServers', () => ({ useMcpServers: () => ({
  ...lifecycle, status: { test: { status: 'connected' } }, isLoading: false,
  isRemovingAuth: false, isAddingServer: false,
}) }))
vi.mock('../components/settings/McpOAuthDialog', () => ({ McpOAuthDialog: () => null }))
vi.mock('../components/settings/McpServerCard', () => ({ McpServerCard: (props: { serverId: string; onToggleServer: (id: string) => void; isAnyOperationPending: boolean }) =>
  createElement('button', { onClick: () => props.onToggleServer(props.serverId), disabled: props.isAnyOperationPending }, 'Toggle test server'),
}))

function mount(element: ReturnType<typeof createElement>) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(createElement(QueryClientProvider, { client }, element))
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.clearAllMocks() })

describe('MCP configuration input', () => {
  it('preserves JSON argv spaces and empty values, and rejects ambiguous shell quoting', () => {
    expect(parseMcpCommand('["node", "/path with spaces/server.js", ""]')).toEqual(['node', '/path with spaces/server.js', ''])
    expect(parseMcpCommand('node\tserver.js')).toEqual(['node', 'server.js'])
    expect(() => parseMcpCommand('node "path with spaces"')).toThrow(/JSON argv/)
    expect(() => parseMcpCommand('[1]')).toThrow()
  })
  it('rejects unsafe IDs, invalid URLs and fractional or negative timeouts', () => {
    for (const name of ['constructor', 'prototype', 'bad name', '']) expect(() => validateMcpServerInput(name, { type: 'remote', url: 'https://example.test' })).toThrow()
    for (const url of ['ftp://example.test', 'https://user:pass@example.test', 'relative']) expect(() => validateMcpServerInput('test', { type: 'remote', url })).toThrow()
    for (const timeout of [-1, 0, 1.5, NaN]) expect(() => validateMcpServerInput('test', { type: 'local', command: ['node'], timeout })).toThrow()
  })
})

describe('MCP UI lifecycle', () => {
  it('saves the selected config once and uses identical argv for lifecycle connection', async () => {
    vi.spyOn(settingsApi, 'getPiConfigs').mockResolvedValue({ configs: [{ name: 'selected', content: { mcp: {} } }], defaultConfig: null } as never)
    const defaultConfig = vi.spyOn(settingsApi, 'getDefaultPiConfig')
    const directUpdate = vi.spyOn(settingsApi, 'updatePiConfig')
    const onUpdate = vi.fn(async () => {})
    lifecycle.addServerAsync.mockResolvedValue({})
    mount(createElement(AddMcpServerDialog, { open: true, configName: 'selected', onOpenChange: vi.fn(), onUpdate }))
    fireEvent.change(screen.getByLabelText('Server ID'), { target: { value: 'new-server' } })
    fireEvent.change(screen.getByLabelText('Command'), { target: { value: '["node", "/path with spaces/server.js", ""]' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add MCP Server' }))
    await waitFor(() => expect(lifecycle.addServerAsync).toHaveBeenCalledOnce())
    expect(onUpdate).toHaveBeenCalledOnce()
    const saved = onUpdate.mock.calls[0] as unknown as [string, { mcp: Record<string, unknown> }]
    expect(saved[0]).toBe('selected')
    expect(lifecycle.addServerAsync).toHaveBeenCalledWith({ name: 'new-server', config: saved[1].mcp['new-server'] })
    expect(defaultConfig).not.toHaveBeenCalled()
    expect(directUpdate).not.toHaveBeenCalled()
  })
  it('does not overwrite an existing entry or initiate a connection', async () => {
    vi.spyOn(settingsApi, 'getPiConfigs').mockResolvedValue({ configs: [{ name: 'selected', content: { mcp: { test: { type: 'local', command: ['node'] } } } }], defaultConfig: null } as never)
    const onUpdate = vi.fn(async () => {})
    mount(createElement(AddMcpServerDialog, { open: true, configName: 'selected', onOpenChange: vi.fn(), onUpdate }))
    fireEvent.change(screen.getByLabelText('Server ID'), { target: { value: 'test' } })
    fireEvent.change(screen.getByLabelText('Command'), { target: { value: 'node server.js' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add MCP Server' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('already exists')
    expect(onUpdate).not.toHaveBeenCalled()
    expect(lifecycle.addServerAsync).not.toHaveBeenCalled()
  })
  it('keeps toggles pending until disconnect actually resolves', async () => {
    let release!: () => void
    lifecycle.disconnectAsync.mockReturnValue(new Promise<void>((resolve) => { release = resolve }))
    mount(createElement(McpManager, { config: { name: 'selected', content: { mcp: { test: { type: 'local', command: ['node'] } } } }, onUpdate: vi.fn(async () => {}) }))
    fireEvent.click(screen.getByRole('button', { name: 'Toggle test server' }))
    expect(lifecycle.disconnectAsync).toHaveBeenCalledWith('test')
    expect(screen.getByRole('button', { name: 'Toggle test server' })).toBeDisabled()
    expect(lifecycle.refetch).not.toHaveBeenCalled()
    release()
    await waitFor(() => expect(lifecycle.refetch).toHaveBeenCalledOnce())
    expect(screen.getByRole('button', { name: 'Toggle test server' })).not.toBeDisabled()
  })
})
