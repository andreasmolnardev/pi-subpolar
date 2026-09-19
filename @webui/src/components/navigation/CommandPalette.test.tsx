import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { CommandPalette } from './CommandPalette'

const navigate = vi.fn()
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom')
  return { ...actual, useNavigate: () => navigate }
})

describe('CommandPalette', () => {
  it('filters actions and navigates with keyboard selection', () => {
    const onOpenChange = vi.fn()
    render(<MemoryRouter><CommandPalette open onOpenChange={onOpenChange} /></MemoryRouter>)
    const input = screen.getByRole('textbox', { name: 'Search commands' })
    fireEvent.change(input, { target: { value: 'project' } })
    expect(screen.getByRole('option', { name: /Switch project/ })).toBeInTheDocument()
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(navigate).toHaveBeenCalledWith('/projects')
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('moves selection with arrow keys', () => {
    render(<MemoryRouter><CommandPalette open onOpenChange={vi.fn()} /></MemoryRouter>)
    const input = screen.getByRole('textbox', { name: 'Search commands' })
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(screen.getByRole('option', { name: /Search sessions/ })).toHaveAttribute('aria-selected', 'true')
  })
})
