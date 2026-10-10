import { act, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { browserApi } from '@/api/browser'
import { changeAuthOwner } from '@/stores/authIdentityStore'
import { BrowserScreenshot, screenshotFromOutput } from './BrowserScreenshot'
vi.mock('@/api/browser', () => ({ browserApi: { artifact: vi.fn() } }))
beforeEach(() => { vi.resetAllMocks(); URL.createObjectURL = vi.fn().mockReturnValue('blob:private'); URL.revokeObjectURL = vi.fn() })
describe('browser screenshot history', () => {
  it('extracts only artifact identity and ignores supplied external URLs', () => {
    expect(screenshotFromOutput(JSON.stringify({ screenshotArtifact: { id: 'record', status: 'captured', url: 'https://evil.test' } }))).toEqual({ id: 'record', status: 'captured' })
    expect(screenshotFromOutput('not json')).toBeNull()
  })
  it('loads protected image by ID and revokes object URL on owner change', async () => {
    act(() => changeAuthOwner('screenshot-owner-a'))
    vi.mocked(browserApi.artifact).mockResolvedValueOnce(new Blob(['png'], { type: 'image/png' })).mockImplementationOnce(() => new Promise(() => {}))
    const view = render(<BrowserScreenshot artifact={{ id: 'artifact-1', status: 'captured' }} />)
    await screen.findByAltText('Browser screenshot after tool action')
    expect(browserApi.artifact).toHaveBeenCalledWith('artifact-1', expect.any(AbortSignal))
    act(() => changeAuthOwner('screenshot-owner-b'))
    expect(screen.queryByAltText('Browser screenshot after tool action')).not.toBeInTheDocument()
    await waitFor(() => expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:private'))
    view.unmount()
  })
  it('does not fetch unavailable artifacts', () => {
    render(<BrowserScreenshot artifact={{ id: 'failed', status: 'unavailable' }} />)
    expect(screen.getByText('Screenshot unavailable for this action.')).toBeInTheDocument()
    expect(browserApi.artifact).not.toHaveBeenCalled()
  })
})
