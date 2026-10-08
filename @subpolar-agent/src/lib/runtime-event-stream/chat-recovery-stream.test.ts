import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventStream } from './runtimeEventStream'
import type { EventStreamTransportHandlers } from './types'

const subscriptions: Array<{ dispose(): void }> = []
afterEach(() => {
  subscriptions.splice(0).forEach(subscription => subscription.dispose())
  vi.useRealTimers()
})

function harness() {
  const urls: string[] = []
  let handlers: EventStreamTransportHandlers
  const stream = new EventStream({ transport: {
    open(url, callbacks) { urls.push(url); handlers = callbacks; return { close() {} } },
    async post() { return true },
  } })
  const onEvent = vi.fn()
  const subscription = stream.subscribeGlobalMonitor({ directories: ['/repo'], onEvent })
  subscriptions.push(subscription)
  return { urls, onEvent, subscription, handlers: () => handlers! }
}

describe('chat recovery stream cursor seam', () => {
  it('reconnects after an error with the last durable cursor and ignores duplicate replay', async () => {
    vi.useFakeTimers()
    const h = harness()
    const event = JSON.stringify({ type: 'message.updated', properties: { info: { id: 'assistant' } } })
    h.handlers().onOpen()
    h.handlers().onMessage(event, '12')
    h.handlers().onError()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(new URL(h.urls.at(-1)!).searchParams.get('after')).toBe('12')
    h.handlers().onMessage(event, '12')
    h.handlers().onMessage(event, '13')
    expect(h.onEvent).toHaveBeenCalledTimes(2)
  })

  it('accepts retained events after a cursor reset and uses the new cursor on reconnect', () => {
    const h = harness()
    h.handlers().onMessage(JSON.stringify({ type: 'old' }), '100')
    h.handlers().onReset?.('4')
    h.handlers().onMessage(JSON.stringify({ type: 'retained' }), '5')
    expect(h.onEvent).toHaveBeenLastCalledWith({ type: 'retained' })
    h.subscription.reconnect()
    expect(new URL(h.urls.at(-1)!).searchParams.get('after')).toBe('5')
  })
})
