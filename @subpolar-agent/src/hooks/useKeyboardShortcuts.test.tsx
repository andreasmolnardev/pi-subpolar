import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useKeyboardShortcuts } from './useKeyboardShortcuts'

let preferences: { keyboardShortcuts?: Record<string, string>; directShortcuts?: string[] } = {}
vi.mock('./useSettings', () => ({ useSettings: () => ({ preferences }) }))
beforeEach(() => { preferences = {} })

function Shortcuts({ open }: { open: () => void }) {
  useKeyboardShortcuts({}) // SessionDetail must not consume or duplicate the palette action.
  useKeyboardShortcuts({ openCommandPalette: open })
  return <><textarea aria-label="Composer" /><textarea aria-label="Editor" data-file-editor="true" /><input aria-label="Input" /><div contentEditable aria-label="Editable" /></>
}

describe('command palette shortcuts', () => {
  it.each(['Composer', 'Editor', 'Input', 'Editable'])('opens exactly once with Ctrl+K and Cmd+K from %s', name => {
    const open = vi.fn()
    render(<Shortcuts open={open} />)
    const target = screen.getByLabelText(name)
    target.focus()
    expect(fireEvent.keyDown(target, { key: 'k', ctrlKey: true })).toBe(false)
    expect(open).toHaveBeenCalledTimes(1)
    expect(fireEvent.keyDown(target, { key: 'k', metaKey: true })).toBe(false)
    expect(open).toHaveBeenCalledTimes(2)
  })
  it('does not re-enable a disabled palette shortcut', () => {
    preferences = { keyboardShortcuts: { commandPalette: '' } }
    const open = vi.fn()
    render(<Shortcuts open={open} />)
    fireEvent.keyDown(screen.getByLabelText('Composer'), { key: 'k', ctrlKey: true })
    fireEvent.keyDown(screen.getByLabelText('Composer'), { key: 'k', metaKey: true })
    expect(open).not.toHaveBeenCalled()
  })
  it('honors a configured direct shortcut instead of the defaults', () => {
    preferences = { keyboardShortcuts: { commandPalette: 'Ctrl+P' }, directShortcuts: ['commandPalette'] }
    const open = vi.fn()
    render(<Shortcuts open={open} />)
    const target = screen.getByLabelText('Editor')
    target.focus()
    fireEvent.keyDown(target, { key: 'k', ctrlKey: true })
    fireEvent.keyDown(target, { key: 'k', metaKey: true })
    expect(open).not.toHaveBeenCalled()
    fireEvent.keyDown(target, { key: 'p', ctrlKey: true })
    expect(open).toHaveBeenCalledTimes(1)
  })
})
