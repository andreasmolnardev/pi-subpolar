import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MarkdownRenderer } from './MarkdownRenderer'

describe('MarkdownRenderer security', () => {
  it('does not activate raw HTML from document content', () => {
    render(<MarkdownRenderer content={'<img src="x" onerror="alert(1)"><script>alert(2)</script>'} />)
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
    expect(document.querySelector('script')).toBeNull()
  })
})
