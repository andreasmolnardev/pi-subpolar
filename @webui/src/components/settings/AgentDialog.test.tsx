import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { settingsApi } from '@/api/settings'
import { AgentDialog } from './AgentDialog'

vi.mock('@/api/settings', () => ({
  settingsApi: {
    listSubpolarTools: vi.fn(async () => ({ tools: [] })),
    listAgentToolPolicies: vi.fn(async () => ({ policies: [] })),
  },
}))

describe('AgentDialog development workflow profile opt-in', () => {
  it('persists explicit-only instructions without adding tool access', async () => {
    const onSubmit = vi.fn()
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={queryClient}>
        <AgentDialog open onOpenChange={vi.fn()} onSubmit={onSubmit} />
      </QueryClientProvider>,
    )

    fireEvent.change(screen.getByLabelText('Agent Name'), { target: { value: 'builder' } })
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Help with software development.' } })
    fireEvent.click(screen.getByRole('switch', { name: 'Enable Development Workflow skill' }))
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
    const submittedAgent = onSubmit.mock.calls[0][1]
    expect(submittedAgent.skill_context_modes['development-workflow']).toBe('explicit-only')
    expect(submittedAgent.toolAccess?.some((tool: { type: string }) => tool.type === 'subpolar')).toBe(false)
  })

  it('does not turn a selected generated tool skill into a tool grant', async () => {
    vi.mocked(settingsApi.listSubpolarTools).mockResolvedValue({
      tools: [{ tool_id: 'acme/search', namespace: 'acme', adapter: 'http', description: 'Search', input_schema: {}, risk: 'read', requires_approval: false, metadata: {} }],
    } as never)
    const onSubmit = vi.fn()
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={queryClient}>
        <AgentDialog
          open
          onOpenChange={vi.fn()}
          onSubmit={onSubmit}
          editingAgent={{ name: 'builder', agent: { id: 'agent_1', prompt: 'Build safely.', skillAccess: [{ id: 'tool-acme-search', discovery: 'name', source: 'manual' }] } }}
        />
      </QueryClientProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Update' }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
    const submittedAgent = onSubmit.mock.calls[0][1]
    expect(submittedAgent.skills).toContain('tool-acme-search')
    expect(submittedAgent.toolAccess?.some((tool: { type: string; id: string }) => tool.type === 'subpolar' && tool.id === 'acme/search')).toBe(false)
  })
})
