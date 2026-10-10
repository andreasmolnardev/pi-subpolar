import { StrictMode } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { browserApi } from '@/api/browser'
import { changeAuthOwner } from '@/stores/authIdentityStore'
import { LiveBrowser } from './LiveBrowser'
vi.mock('@/api/browser', () => ({ browserApi: { profiles: vi.fn(), sessions: vi.fn(), create: vi.fn(), frame: vi.fn(), control: vi.fn(), input: vi.fn(), close: vi.fn() } }))
const session = { id: 'browser-1', lifecycle: 'open', tabs: [{ id: 'tab-1', title: 'Fixture', url: 'https://fixture.test' }], current_tab_id: 'tab-1', current_url: 'https://fixture.test' }
beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.mocked(browserApi.profiles).mockResolvedValue({ profiles: [{ id: 'profile-1', name: 'Private login' }] })
  vi.mocked(browserApi.sessions).mockResolvedValue({ sessions: [session] })
  vi.mocked(browserApi.create).mockResolvedValue({ session })
  vi.mocked(browserApi.frame).mockResolvedValue({ frame: { mimeType: 'image/png', data: 'abc' }, session, controller: null })
  vi.mocked(browserApi.control).mockImplementation(async (_id, _scope, action) => ({ controller: action === 'release' ? null : { leaseId: 'lease-1', expiresAt: Date.now() + 30000 } }))
  vi.mocked(browserApi.input).mockResolvedValue({ session })
})
describe('LiveBrowser', () => {
  it('lists scoped sessions without starting Chromium or loading frames until connected', async () => {
    const view = render(<StrictMode><LiveBrowser scope={{ sessionId: 'conversation' }} /></StrictMode>)
    await screen.findByText('Private login')
    expect(browserApi.sessions).toHaveBeenCalledWith({ sessionId: 'conversation' })
    expect(browserApi.create).not.toHaveBeenCalled()
    expect(browserApi.frame).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText('Attach browser session'), { target: { value: session.id } })
    await screen.findByText('Connect viewer')
    expect(browserApi.frame).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('Connect viewer'))
    await screen.findByAltText('Live remote browser')
    expect(browserApi.frame).toHaveBeenCalledWith(session.id, { sessionId: 'conversation' }, expect.any(AbortSignal))
    expect(screen.getByLabelText('Browser address')).toBeDisabled()
    view.unmount()
  })
  it('supports StrictMode replay, requires manual lease and releases it on disconnect', async () => {
    const view = render(<StrictMode><LiveBrowser scope={{ sessionId: 'conversation' }} /></StrictMode>)
    await screen.findByText('Private login')
    fireEvent.click(screen.getByText('New browser window'))
    await screen.findByAltText('Live remote browser')
    fireEvent.click(screen.getByText('Take control'))
    await screen.findByText('Return control')
    fireEvent.change(screen.getByLabelText('Browser address'), { target: { value: 'https://other.test' } })
    fireEvent.click(screen.getByText('Go'))
    await waitFor(() => expect(browserApi.input).toHaveBeenCalledWith(session.id, { sessionId: 'conversation' }, 'lease-1', 'navigate', { url: 'https://other.test' }))
    fireEvent.click(screen.getByText('Disconnect viewer'))
    await screen.findByText('Connect viewer')
    expect(browserApi.control).toHaveBeenCalledWith(session.id, { sessionId: 'conversation' }, 'release', 'lease-1')
    expect(browserApi.close).not.toHaveBeenCalled()
    view.unmount()
  })
  it('drops private session/profile state when account changes', async () => {
    act(() => changeAuthOwner('account-a'))
    const view = render(<LiveBrowser />)
    await screen.findByText('Private login')
    vi.mocked(browserApi.profiles).mockResolvedValue({ profiles: [] })
    vi.mocked(browserApi.sessions).mockResolvedValue({ sessions: [] })
    act(() => changeAuthOwner('account-b'))
    await waitFor(() => expect(screen.queryByText('Private login')).not.toBeInTheDocument())
    view.unmount()
  })
})
