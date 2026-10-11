import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TeachToolsDialog } from './TeachToolsDialog'

vi.mock('@/api/settings', () => ({
  settingsApi: { teachTools: vi.fn(), registerTool: vi.fn() },
}))

describe('TeachToolsDialog', () => {
  it('opens the tool teaching workflow from chat', () => {
    render(<TeachToolsDialog open onOpenChange={vi.fn()} />)

    expect(screen.getAllByRole('heading', { name: 'Teach Tools' })).toHaveLength(2)
    expect(screen.getByLabelText('Source type')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Generate tool drafts' })).toBeInTheDocument()
  })
})
