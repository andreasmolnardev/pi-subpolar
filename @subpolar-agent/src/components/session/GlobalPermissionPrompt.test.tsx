import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import type { PermissionRequest } from '@/api/types'
import { GlobalPermissionPrompt } from './GlobalPermissionPrompt'

const mocks = vi.hoisted(() => ({
  usePermissions: vi.fn(),
}))

vi.mock('@/contexts/EventContext', () => ({
  usePermissions: mocks.usePermissions,
}))

vi.mock('./PermissionRequestDialog', () => ({
  PermissionRequestDialog: ({ permission }: { permission: PermissionRequest }) => (
    <div data-testid="permission-dialog">{permission.id}</div>
  ),
}))

const permission: PermissionRequest = {
  id: 'approval-1',
  sessionID: 'session-1',
  permission: 'bash',
  patterns: ['bash'],
  metadata: {},
  always: [],
}

function renderPrompt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <GlobalPermissionPrompt />
    </MemoryRouter>,
  )
}

describe('GlobalPermissionPrompt', () => {
  it('renders a real-time approval outside the active session', () => {
    mocks.usePermissions.mockReturnValue({
      current: permission,
      pendingCount: 1,
      respond: vi.fn(),
      showDialog: true,
    })

    renderPrompt('/new')

    expect(screen.getByTestId('permission-dialog')).toHaveTextContent('approval-1')
  })

  it('leaves the active session to render its inline approval prompt', () => {
    mocks.usePermissions.mockReturnValue({
      current: permission,
      pendingCount: 1,
      respond: vi.fn(),
      showDialog: true,
    })

    renderPrompt('/projects/1/sessions/session-1')

    expect(screen.queryByTestId('permission-dialog')).not.toBeInTheDocument()
  })
})
