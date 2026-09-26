import { vi } from 'vitest'

vi.mock('@/hooks/useMobile', () => ({
  useMobile: vi.fn(),
}))
vi.mock('@/hooks/useMobileTabBar', () => ({
  useMobileTabBar: vi.fn(),
}))
vi.mock('@/components/navigation/NotificationsSheet', () => ({
  NotificationsSheet: ({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) =>
    isOpen ? <button type="button" data-testid="notifications-sheet" onClick={onClose}>NotificationsSheet</button> : null,
}))
vi.mock('@/components/navigation/MoreDrawer', () => ({
  MoreDrawer: ({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) =>
    isOpen ? <button type="button" data-testid="more-drawer" onClick={onClose}>MoreDrawer</button> : null,
}))

import { render, screen } from '@testing-library/react'
import { describe, it, expect, beforeEach, vi as vitest } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { MobileSheetHost } from './MobileSheetHost'
import { useMobile } from '@/hooks/useMobile'
import { useMobileTabBar } from '@/hooks/useMobileTabBar'

function renderHost() {
  return render(
    <MemoryRouter>
      <MobileSheetHost />
    </MemoryRouter>,
  )
}

describe('MobileSheetHost', () => {
  beforeEach(() => {
    vitest.clearAllMocks()
    vi.mocked(useMobile).mockReturnValue(true)
    vi.mocked(useMobileTabBar).mockReturnValue({
      openSheet: null,
      open: vitest.fn(),
      close: vitest.fn(),
    })
  })

  it('renders nothing when useMobile returns false', () => {
    vi.mocked(useMobile).mockReturnValue(false)
    const { container } = renderHost()
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing when no sheet is open', () => {
    const { container } = renderHost()
    expect(container.firstChild).toBeNull()
  })

  it('renders NotificationsSheet when notifications is open', () => {
    vi.mocked(useMobileTabBar).mockReturnValue({ openSheet: 'notifications', open: vitest.fn(), close: vitest.fn() })
    renderHost()
    expect(screen.getByTestId('notifications-sheet')).toBeInTheDocument()
  })

  it('renders MoreDrawer when more is open', () => {
    vi.mocked(useMobileTabBar).mockReturnValue({ openSheet: 'more', open: vitest.fn(), close: vitest.fn() })
    renderHost()
    expect(screen.getByTestId('more-drawer')).toBeInTheDocument()
  })

  it('passes close to the open sheet', () => {
    const close = vitest.fn()
    vi.mocked(useMobileTabBar).mockReturnValue({ openSheet: 'more', open: vitest.fn(), close })
    renderHost()
    screen.getByTestId('more-drawer').click()
    expect(close).toHaveBeenCalledTimes(1)
  })
})
