import { render, screen, fireEvent } from '@testing-library/react'
import { beforeEach, describe, it, expect, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { MoreDrawer } from './MoreDrawer'
import { useCommands } from '@/hooks/useCommands'
import { useUIState } from '@/stores/uiStateStore'

vi.mock('@/hooks/useCommands')
vi.mock('@/hooks/useMobile', () => ({
  useSwipeBack: () => ({ bind: vi.fn() }),
}))

const renderMoreDrawer = (initialEntry = '/') => render(
  <MemoryRouter initialEntries={[initialEntry]}>
    <MoreDrawer isOpen onClose={vi.fn()} />
  </MemoryRouter>,
)

describe('MoreDrawer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(useCommands).mockReturnValue({
      commands: [],
      loading: false,
      error: null,
      filterCommands: vi.fn().mockReturnValue([
        { name: 'help', description: 'Show help', template: '', agent: '', model: '', hints: [] },
      ]),
    })
    useUIState.getState().clearPendingPromptCommand()
  })

  it('renders the empty current More surface and its close control', () => {
    renderMoreDrawer()
    expect(screen.getByRole('dialog', { name: 'More' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument()
    expect(screen.queryByText('Settings')).not.toBeInTheDocument()
    expect(screen.queryByText('Logout')).not.toBeInTheDocument()
  })

  it('renders session commands on the canonical project session route', () => {
    renderMoreDrawer('/projects/1/sessions/session-1')
    fireEvent.click(screen.getByRole('button', { name: 'Commands' }))
    expect(screen.getByRole('button', { name: /help/ })).toBeInTheDocument()
  })

  it('selects a session command and closes the drawer', () => {
    const onClose = vi.fn()
    render(
      <MemoryRouter initialEntries={['/projects/1/sessions/session-1']}>
        <MoreDrawer isOpen onClose={onClose} />
      </MemoryRouter>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Commands' }))
    fireEvent.click(screen.getByRole('button', { name: /help/ }))

    expect(useUIState.getState().pendingPromptCommand?.command.name).toBe('help')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('does not render session commands outside a session route', () => {
    renderMoreDrawer('/projects/1')
    expect(screen.queryByRole('button', { name: 'Commands' })).not.toBeInTheDocument()
  })
})
