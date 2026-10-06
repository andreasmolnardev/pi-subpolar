import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { CommandSuggestions } from './CommandSuggestions'

const commands = [
  { name: 'compact', description: 'Compact session' },
  { name: 'continue', description: 'Continue session' },
] as never[]

describe('CommandSuggestions', () => {
  it('renders an accessible listbox with ranked options', () => {
    render(
      <CommandSuggestions
        isOpen
        query="com"
        commands={commands}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    expect(screen.getByRole('listbox', { name: 'Slash commands' })).toBeTruthy()
    expect(screen.getAllByRole('option')).toHaveLength(1)
    expect(screen.getByRole('option', { name: /\/compact/ })).toHaveAttribute('aria-selected', 'true')
  })
})
