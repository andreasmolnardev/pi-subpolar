import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { settingsApi } from '@/api/settings'
import { IntegrationsSettings } from './IntegrationsSettings'

const savedArgv = ['node', '/path with spaces/server.js', '--label', 'value with spaces']
const integration = {
  id: 'mcp-integration',
  name: 'MCP server',
  enabled: true,
  type: 'mcp' as const,
  transport: 'stdio' as const,
  serverUrl: '',
  command: savedArgv,
  cwd: '',
  environment: {},
  headers: {},
  timeout: 15000,
}

function renderSettings() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(<QueryClientProvider client={queryClient}><IntegrationsSettings /></QueryClientProvider>)
}

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('IntegrationsSettings integration choices', () => {
  it('keeps Git hidden until selected from the Add integration popover', async () => {
    vi.spyOn(settingsApi, 'listIntegrations').mockResolvedValue({ integrations: [] })

    renderSettings()
    await screen.findByText('No integrations configured')
    expect(screen.queryByRole('heading', { name: 'Git provider accounts' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Add integration' }))
    expect(screen.getByRole('button', { name: 'Git' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'MCP' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'OpenAPI' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Git' }))
    expect(await screen.findByRole('heading', { name: 'Git provider accounts' })).toBeInTheDocument()
  })

  it('opens the integration dialog with the selected type', async () => {
    vi.spyOn(settingsApi, 'listIntegrations').mockResolvedValue({ integrations: [] })

    renderSettings()
    await screen.findByText('No integrations configured')
    fireEvent.click(screen.getByRole('button', { name: 'Add integration' }))
    fireEvent.click(screen.getByRole('button', { name: 'OpenAPI' }))

    expect(await screen.findByLabelText('Provider name')).toBeInTheDocument()
    expect(screen.getByLabelText('OpenAPI JSON')).toBeInTheDocument()
  })

  it('does not render previously saved CalDAV or mail integrations', async () => {
    vi.spyOn(settingsApi, 'listIntegrations').mockResolvedValue({
      integrations: [
        { id: 'old-calendar', type: 'caldav', name: 'Calendar', enabled: true },
        { id: 'old-mail', type: 'mail', name: 'Mail', enabled: true },
      ] as never,
    })

    renderSettings()

    expect(await screen.findByText('No integrations configured')).toBeInTheDocument()
    expect(screen.queryByText('Calendar')).not.toBeInTheDocument()
    expect(screen.queryByText('Mail')).not.toBeInTheDocument()
  })
})

describe('IntegrationsSettings MCP command editing', () => {
  it('preserves saved argv arguments containing spaces when editing and saving', async () => {
    vi.spyOn(settingsApi, 'listIntegrations').mockResolvedValue({ integrations: [integration] })
    const updateIntegration = vi.spyOn(settingsApi, 'updateIntegration').mockImplementation(async (value) => value)

    const { container } = renderSettings()
    await screen.findByText('MCP server')
    fireEvent.click(container.querySelector('.lucide-pencil')!.closest('button')!)

    expect(screen.getByLabelText('Command and arguments')).toHaveValue(JSON.stringify(savedArgv))
    fireEvent.click(screen.getByRole('button', { name: 'Save Integration' }))

    await waitFor(() => expect(updateIntegration).toHaveBeenCalledOnce())
    expect(updateIntegration.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ command: savedArgv }))
  })
})
