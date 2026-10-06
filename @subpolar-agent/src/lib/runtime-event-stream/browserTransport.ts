import type { EventStreamConnection, EventStreamTransport, EventStreamTransportHandlers } from './types'

export function createBrowserEventStreamTransport(): EventStreamTransport {
  return {
    open(url: string, handlers: EventStreamTransportHandlers): EventStreamConnection {
      const eventSource = new EventSource(url, { withCredentials: true })

      eventSource.onopen = handlers.onOpen
      eventSource.onerror = handlers.onError
      eventSource.onmessage = (event) => handlers.onMessage(event.data, event.lastEventId)
      eventSource.addEventListener('connected', (event) => {
        handlers.onConnected((event as MessageEvent).data)
      })
      eventSource.addEventListener('heartbeat', handlers.onHeartbeat)
      eventSource.addEventListener('cursor.reset', (event) => handlers.onReset?.((event as MessageEvent).lastEventId || JSON.parse((event as MessageEvent).data).cursor))

      return {
        close: () => eventSource.close(),
      }
    },

    async post(path: string, body: unknown): Promise<boolean> {
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })

      return response.ok
    },
  }
}
