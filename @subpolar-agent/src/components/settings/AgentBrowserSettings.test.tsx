import { useState } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { browserApi, type BrowserConfiguration } from '@/api/browser'
import { AgentBrowserSettings } from './AgentBrowserSettings'
vi.mock('@/api/browser', () => ({ browserApi: { profiles: vi.fn(), createProfile: vi.fn() } }))
beforeEach(() => { vi.resetAllMocks(); vi.mocked(browserApi.profiles).mockResolvedValue({ profiles: [{ id: 'private', name: 'Private' }] }) })
function Harness({ onChange }: { onChange: ReturnType<typeof vi.fn> }) {
  const [configuration, setConfiguration] = useState<BrowserConfiguration>({ allowedProfileIds: ['private'], defaultProfileId: 'private', allowEphemeral: false })
  return <AgentBrowserSettings allowed={true} configuration={configuration} onChange={(allowed, config) => { setConfiguration(config); onChange(allowed, config) }} />
}
describe('agent browser profile grants', () => {
  it('clears default profile when its grant is removed', async () => {
    const changed = vi.fn(); render(<Harness onChange={changed} />)
    fireEvent.click(await screen.findByLabelText('Private'))
    expect(changed).toHaveBeenLastCalledWith(true, { allowedProfileIds: [], defaultProfileId: undefined, allowEphemeral: false })
    expect(screen.getByLabelText('Default browser profile')).toHaveValue('')
  })
  it('creates a profile and explicitly grants it only through current agent configuration', async () => {
    vi.mocked(browserApi.createProfile).mockResolvedValue({ profile: { id: 'new', name: 'Work' } })
    const changed = vi.fn(); render(<Harness onChange={changed} />)
    await screen.findByLabelText('Private')
    fireEvent.change(screen.getByLabelText('Create browser profile name'), { target: { value: 'Work' } })
    fireEvent.click(screen.getByText('Create and assign profile'))
    await waitFor(() => expect(changed).toHaveBeenCalledWith(true, { allowedProfileIds: ['private', 'new'], defaultProfileId: 'private', allowEphemeral: false }))
    expect(browserApi.createProfile).toHaveBeenCalledWith('Work')
  })
})
