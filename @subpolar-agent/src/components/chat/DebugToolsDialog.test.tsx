import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { DebugToolsDialog } from './DebugToolsDialog'

const mocks = vi.hoisted(() => ({
  listTools: vi.fn(),
  callTool: vi.fn(),
}))

vi.mock('@/api/settings', () => ({
  settingsApi: {
    listAgentDebugTools: mocks.listTools,
    callAgentDebugTool: mocks.callTool,
  },
}))

describe('DebugToolsDialog', () => {
  beforeEach(() => {
    mocks.listTools.mockReset().mockResolvedValue({
      tools: [{
        id: 'web.search',
        description: 'Search the web',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string', description: 'Search query' } },
          required: ['query'],
        },
        requiresApproval: false,
        contextMode: 'always',
      }],
    })
    mocks.callTool.mockReset().mockResolvedValue({ ok: true, value: ['result'] })
  })

  afterEach(cleanup)

  it('lists current agent tools, collects required params, then executes selected tool', async () => {
    render(<DebugToolsDialog open onOpenChange={vi.fn()} sessionID="session-1" agentName="researcher" />)

    expect(await screen.findByRole('button', { name: /web\.search/ })).toBeTruthy()
    expect(mocks.listTools).toHaveBeenCalledWith('researcher', 'session-1')

    fireEvent.click(screen.getByRole('button', { name: /web\.search/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Run tool' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('query is required')
    expect(mocks.callTool).not.toHaveBeenCalled()

    fireEvent.change(screen.getByRole('textbox', { name: /query/ }), { target: { value: 'Subpolar tools' } })
    fireEvent.click(screen.getByRole('button', { name: 'Run tool' }))

    await waitFor(() => expect(mocks.callTool).toHaveBeenCalledWith({
      toolId: 'web.search',
      sessionId: 'session-1',
      agentName: 'researcher',
      input: { query: 'Subpolar tools' },
    }))
    expect(await screen.findByText(/"result"/)).toBeTruthy()
  })
})
