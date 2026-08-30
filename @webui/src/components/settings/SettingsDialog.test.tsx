import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom'
import { SettingsDialog } from './SettingsDialog'

vi.mock('@/components/settings/GeneralSettings', () => ({
  GeneralSettings: () => <div data-testid="general-settings">General Settings Content</div>,
}))

vi.mock('@/components/settings/ChatSettings', () => ({
  ChatSettings: () => <div data-testid="chat-settings">Chat Settings Content</div>,
}))

vi.mock('@/components/settings/AppearanceSettings', () => ({
  AppearanceSettings: () => <div data-testid="appearance-settings">Appearance Settings Content</div>,
}))

vi.mock('@/components/settings/KeyboardShortcuts', () => ({
  KeyboardShortcuts: () => <div data-testid="shortcuts-settings">Keyboard Shortcuts Content</div>,
}))

vi.mock('@/components/settings/ProviderSettings', () => ({
  ProviderSettings: () => <div data-testid="providers-settings">Provider Settings Content</div>,
}))

vi.mock('@/components/settings/IntegrationsSettings', () => ({
  IntegrationsSettings: () => <div data-testid="integrations-settings">Integrations Settings Content</div>,
}))

vi.mock('@/components/settings/AccountSettings', () => ({
  AccountSettings: () => <div data-testid="account-settings">Account Settings Content</div>,
}))

vi.mock('@/components/settings/VoiceSettings', () => ({
  VoiceSettings: () => <div data-testid="voice-settings">Voice Settings Content</div>,
}))

vi.mock('@/components/settings/NotificationSettings', () => ({
  NotificationSettings: () => <div data-testid="notification-settings">Notification Settings Content</div>,
}))

vi.mock('@/hooks/useMobile', () => ({
  useSwipeBack: vi.fn(() => ({
    bind: vi.fn(),
    swipeProgress: 0,
    swipeStyles: {},
  })),
}))

describe('SettingsDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('resets to menu state when dialog closes and reopens', () => {
    function TestWrapper() {
      const location = useLocation()
      const navigate = useNavigate()

      const searchParams = new URLSearchParams(location.search)
      const isOpen = searchParams.get('settings') === 'open'

      return (
        <>
          <button onClick={() => navigate('?settings=open&settingsTab=general')}>Open Settings</button>
          <button onClick={() => navigate('/')}>Close Settings</button>
          {isOpen && <span data-testid="dialog-open">Dialog Open</span>}
          <SettingsDialog />
        </>
      )
    }

    render(
      <MemoryRouter initialEntries={['/']}>
        <TestWrapper />
      </MemoryRouter>
    )

    fireEvent.click(screen.getByText('Open Settings'))
    expect(screen.getByTestId('dialog-open')).toBeInTheDocument()

    fireEvent.click(screen.getByText('Close Settings'))
    expect(screen.queryByTestId('dialog-open')).not.toBeInTheDocument()

    fireEvent.click(screen.getByText('Open Settings'))
    expect(screen.getByTestId('dialog-open')).toBeInTheDocument()
  })

  it('displays menu items in mobile view', () => {
    function TestWrapper() {
      const location = useLocation()
      const navigate = useNavigate()

      const searchParams = new URLSearchParams(location.search)
      const isOpen = searchParams.get('settings') === 'open'

      return (
        <>
          <button onClick={() => navigate('?settings=open')}>Open Settings</button>
          {isOpen && <span data-testid="dialog-open">Dialog Open</span>}
          <SettingsDialog />
        </>
      )
    }

    render(
      <MemoryRouter initialEntries={['/']}>
        <TestWrapper />
      </MemoryRouter>
    )

    fireEvent.click(screen.getByText('Open Settings'))
    expect(screen.getByTestId('dialog-open')).toBeInTheDocument()

    expect(screen.getAllByText('Account').length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('General Settings').length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('Chat').length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('Appearance').length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('Keyboard Shortcuts').length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('Models').length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('Integrations').length).toBeGreaterThanOrEqual(1)
    expect(screen.queryByText('Git')).not.toBeInTheDocument()
    expect(screen.queryByText('OpenCode Config')).not.toBeInTheDocument()
  })
})
