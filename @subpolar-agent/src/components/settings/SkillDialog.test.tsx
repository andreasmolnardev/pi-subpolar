import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { listProjects } from '@/api/projects'
import { SkillDialog } from './SkillDialog'

vi.mock('@/api/projects', () => ({ listProjects: vi.fn(async () => []) }))

function renderDialog(onSubmit: (data: unknown) => void) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <SkillDialog open onOpenChange={vi.fn()} onSubmit={onSubmit} />
    </QueryClientProvider>,
  )
}

describe('durable SkillDialog', () => {
  it('offers the instruction-only development template and submits canonical tool references as hints', async () => {
    const onSubmit = vi.fn()
    renderDialog(onSubmit)

    fireEvent.click(screen.getByRole('button', { name: 'Use Development Workflow template' }))
    expect((screen.getByLabelText('Skill Body') as HTMLTextAreaElement).value).toContain('Keep authorization and approval decisions in the runtime tool router')
    fireEvent.change(screen.getByLabelText('Linked tool IDs (context hints only)'), { target: { value: 'read\nacme/search' } })
    const createButton = screen.getByRole('button', { name: 'Create' })
    await waitFor(() => expect(createButton).toBeEnabled())
    fireEvent.click(createButton)

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      id: 'development-workflow',
      mode: 'explicit-only',
      toolIds: ['read', 'acme/search'],
    })))
  })

  it('rejects non-canonical tool references in the editor', async () => {
    const onSubmit = vi.fn()
    renderDialog(onSubmit)
    fireEvent.change(screen.getByLabelText('Skill Name'), { target: { value: 'guide' } })
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Guide' } })
    fireEvent.change(screen.getByLabelText('Skill Body'), { target: { value: 'Body' } })
    fireEvent.change(screen.getByLabelText('Linked tool IDs (context hints only)'), { target: { value: 'acme//search' } })
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled()
    expect(onSubmit).not.toHaveBeenCalled()
  })
})
