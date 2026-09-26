import { vi } from 'vitest'

vi.mock('@/hooks/useMobile', () => ({
  useMobile: vi.fn(),
}))

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, beforeEach } from 'vitest'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { MobileTabBar } from './MobileTabBar'
import { useMobile } from '@/hooks/useMobile'

function LocationSpy() {
  const { pathname } = useLocation()
  return <div data-testid="location">{pathname}</div>
}

function renderTabBar(initialEntry = '/') {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <MobileTabBar />
    </MemoryRouter>,
  )
}

describe('MobileTabBar', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders nothing when useMobile returns false', () => {
    vi.mocked(useMobile).mockReturnValue(false)
    const { container } = renderTabBar()
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing on unsupported paths', () => {
    vi.mocked(useMobile).mockReturnValue(true)
    const { container } = renderTabBar('/login')
    expect(container.firstChild).toBeNull()
  })

  it('renders Projects and More on the root route', () => {
    vi.mocked(useMobile).mockReturnValue(true)
    renderTabBar()
    expect(screen.getByRole('button', { name: 'Projects' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'More' })).toBeInTheDocument()
  })

  it('renders the global tabs on a project detail route', () => {
    vi.mocked(useMobile).mockReturnValue(true)
    renderTabBar('/projects/123')
    expect(screen.getByRole('button', { name: 'Projects' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'More' })).toBeInTheDocument()
  })

  it('navigates to the projects route from the Projects tab', async () => {
    vi.mocked(useMobile).mockReturnValue(true)
    const user = userEvent.setup()

    render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="*" element={<><MobileTabBar /><LocationSpy /></>} />
        </Routes>
      </MemoryRouter>,
    )

    await user.click(screen.getByRole('button', { name: 'Projects' }))
    expect(screen.getByTestId('location')).toHaveTextContent('/projects')
  })

  it('hides the tab bar inside a session or project automation route', () => {
    vi.mocked(useMobile).mockReturnValue(true)
    for (const pathname of ['/projects/1/sessions/abc', '/projects/1/automations', '/automations']) {
      const { container, unmount } = renderTabBar(pathname)
      expect(container.firstChild).toBeNull()
      unmount()
    }
  })

  it('marks Projects active on the root route', () => {
    vi.mocked(useMobile).mockReturnValue(true)
    renderTabBar()
    expect(screen.getByRole('button', { name: 'Projects' })).toHaveClass('text-primary', 'border-primary')
  })

  it('marks More active when its sheet is open', () => {
    vi.mocked(useMobile).mockReturnValue(true)
    renderTabBar('/?mobileTab=more')
    expect(screen.getByRole('button', { name: 'More' })).toHaveClass('text-primary', 'border-primary')
  })
})
