import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { settingsApi, type TeachToolDraft } from '@/api/settings'
import { TeachToolsSettings } from './TeachToolsSettings'

vi.mock('@/api/settings', () => ({
  settingsApi: {
    teachTools: vi.fn(),
    registerTool: vi.fn(),
  },
}))

const draft: TeachToolDraft = {
  tool_id: 'git_status',
  namespace: 'git',
  description: 'Show repository status',
  adapter: 'cli',
  target: 'git',
  operation: 'status',
  input_schema: { type: 'object' },
  output_schema: { type: 'object' },
  risk: 'low',
  requires_approval: false,
  enabled: true,
  context_mode: 'default',
  metadata: {},
}

describe('TeachToolsSettings', () => {
  beforeEach(() => vi.clearAllMocks())

  it('sends the CLI source, renders drafts, and only registers after explicit confirmation', async () => {
    vi.mocked(settingsApi.teachTools).mockResolvedValue({
      observations: ['Found a status command.'],
      drafts: [draft],
    })
    vi.mocked(settingsApi.registerTool).mockResolvedValue(draft)

    render(<TeachToolsSettings />)
    fireEvent.change(screen.getByLabelText('Goal'), { target: { value: 'Show repository status' } })
    fireEvent.change(screen.getByLabelText('Command'), { target: { value: 'git' } })
    fireEvent.change(screen.getByLabelText('Exploration arguments (optional)'), { target: { value: '--help' } })
    fireEvent.click(screen.getByRole('button', { name: 'Generate tool drafts' }))

    await waitFor(() => expect(settingsApi.teachTools).toHaveBeenCalledWith({
      kind: 'cli',
      goal: 'Show repository status',
      command: 'git',
      fixedArgs: ['--help'],
    }))
    expect(await screen.findByText('Found a status command.')).toBeInTheDocument()
    expect(screen.getByText('git_status')).toBeInTheDocument()

    const registerButton = screen.getByRole('button', { name: 'Confirm and register tool' })
    expect(registerButton).toBeDisabled()
    expect(settingsApi.registerTool).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('checkbox', { name: 'Confirm registration of git_status' }))
    expect(registerButton).toBeEnabled()
    fireEvent.click(registerButton)

    await waitFor(() => expect(settingsApi.registerTool).toHaveBeenCalledWith(draft))
    expect(await screen.findByRole('button', { name: 'Registered' })).toBeInTheDocument()
  })

  it('sends MCP server configuration as parsed JSON', async () => {
    vi.mocked(settingsApi.teachTools).mockResolvedValue({ observations: [], drafts: [] })
    render(<TeachToolsSettings />)
    fireEvent.change(screen.getByLabelText('Source type'), { target: { value: 'mcp' } })
    fireEvent.change(screen.getByLabelText('Goal'), { target: { value: 'Find available tools' } })
    fireEvent.change(screen.getByLabelText('MCP server configuration (JSON)'), {
      target: { value: '{"command":"node","args":["server.js"]}' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Generate tool drafts' }))

    await waitFor(() => expect(settingsApi.teachTools).toHaveBeenCalledWith({
      kind: 'mcp',
      goal: 'Find available tools',
      server: { command: 'node', args: ['server.js'] },
    }))
  })
})
