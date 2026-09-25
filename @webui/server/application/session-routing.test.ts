import { describe, expect, it, vi } from 'vitest'
import { routeSessionRequest } from './session-routing.ts'

const candidates = [
  { id: 'productivity', agentName: 'productivity' },
  { id: 'homelab/productivity', agentName: 'productivity', projectName: 'homelab' },
] as const

describe('routeSessionRequest', () => {
  it('asks the model without tools and accepts the selected candidate', async () => {
    const completeSimple = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: '{"targetAgentId":"homelab/productivity"}' }],
    })

    const target = await routeSessionRequest({
      runtime: { completeSimple } as never,
      model: {} as never,
      request: 'Check my home server',
      candidates,
    })

    expect(target.id).toBe('homelab/productivity')
    const context = completeSimple.mock.calls[0]?.[1] as Record<string, unknown>
    expect(context).not.toHaveProperty('tools')
  })

  it('rejects non-JSON routing responses', async () => {
    await expect(routeSessionRequest({
      runtime: { completeSimple: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'productivity' }] }) } as never,
      model: {} as never,
      request: 'Write a note',
      candidates,
    })).rejects.toMatchObject({ code: 'SESSION_ROUTING_FAILED' })
  })
})
