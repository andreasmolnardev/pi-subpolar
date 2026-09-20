import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { MessageWithParts } from '@/api/types'
import { messagesQueryKey } from '@/lib/queryInvalidation'
import { AssistantMessageAccumulator, type AssistantMessage } from '@/lib/assistantMessageAccumulator'

const asObject = (v: unknown): Record<string, any> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : {}
const messageText = (content: unknown): string => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((part) => {
    const value = asObject(part)
    return typeof value.text === 'string' ? value.text : ''
  }).join('')
}
const wsUrl = (url: string) => {
  // WebSocket requires an absolute URL. API_BASE_URL is commonly relative
  // ("/api"), especially when the UI and bridge are served together.
  const base = new URL(url || '/', window.location.origin)
  base.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:'
  return base.toString().replace(/\/$/, '')
}

export function useSessionTranscript(apiUrl: string | null | undefined, sessionID: string | undefined, directory?: string) {
  const queryClient = useQueryClient(); const socketRef = useRef<WebSocket | null>(null); const cursor = useRef<string | null>(null)
  const loadAllRef = useRef<{ messages: MessageWithParts[]; resolve: (messages: MessageWithParts[]) => void; reject: (error: Error) => void } | null>(null)
  const loadingOlder = useRef(false); const toolOwners = useRef(new Map<string, { messageId: string; partId: string }>()); const accumulators = useRef(new Map<string, AssistantMessageAccumulator>()); const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null); const [reconnectAttempt, setReconnectAttempt] = useState(0); const [isLoading, setLoading] = useState(true); const [isConnected, setConnected] = useState(false); const [isReconnecting, setReconnecting] = useState(false); const [hasOlder, setHasOlder] = useState(false)
  const key = useMemo(() => messagesQueryKey(apiUrl, sessionID, directory), [apiUrl, sessionID, directory])
  const query = useQuery<MessageWithParts[]>({ queryKey: key, queryFn: async () => [], enabled: false })
  const applyEvent = useCallback((raw: unknown) => {
    const envelope = asObject(raw); const event = asObject(envelope.event ?? raw); const type = String(event.type ?? '')
    // Pi wraps streaming content in assistantMessageEvent. The bridge deliberately keeps
    // this small transport envelope; this reducer is the single live projector.
    const inner = asObject(event.assistantMessageEvent ?? event); const session = sessionID!; const contentIndex = inner.contentIndex
    const eventMessage = asObject(inner.message ?? event.message)
    const eventType = String(inner.type ?? type)
    const eventMessageId = typeof event.messageId === 'string' ? event.messageId
      : typeof event.messageID === 'string' ? event.messageID
        : typeof eventMessage.id === 'string' ? eventMessage.id
          : `live:${session}:assistant`

    // User messages are persisted by the SDK too, but they must never enter the
    // assistant streaming accumulator. Some SDK versions emit message_start for
    // the user turn before the assistant starts; treating that event as an
    // assistant is what makes the first prompt appear in the wrong row.
    if (eventMessage.role === 'user') {
      const text = messageText(eventMessage.content)
      const userMessageId = typeof eventMessage.id === 'string' ? eventMessage.id : `live:${session}:user`
      if (text) {
        queryClient.setQueryData<MessageWithParts[]>(key, (old = []) => {
          if (old.some((item) => item.info.id === userMessageId)) return old
          const nextMessage: MessageWithParts = {
            info: { id: userMessageId, sessionID: session, role: 'user', time: { created: Date.now() }, content: text } as any,
            parts: [{ id: `${userMessageId}:content:0`, sessionID: session, messageID: userMessageId, type: 'text', text } as any],
          }
          // useSendPrompt inserts an optimistic row before the SDK event arrives.
          // Replace that row by content so a persisted user message does not look
          // like the prompt was queued twice in the UI.
          const optimisticIndex = [...old].reverse().findIndex((item) => {
            if (!item.info.id.startsWith('optimistic_') || item.info.role !== 'user') return false
            const optimisticText = item.parts.filter((part) => part.type === 'text').map((part) => part.text ?? '').join('')
            return optimisticText.trim() === text.trim()
          })
          if (optimisticIndex >= 0) {
            const index = old.length - 1 - optimisticIndex
            const updated = [...old]
            updated[index] = nextMessage
            return updated
          }
          return [...old, nextMessage]
        })
      }
      return
    }

    let accumulator = accumulators.current.get(eventMessageId)
    if (eventType === 'message_start') {
      accumulator = new AssistantMessageAccumulator((eventMessage.role === 'assistant' && eventMessage.content ? eventMessage : { role: 'assistant', content: [] }) as AssistantMessage)
      accumulators.current.set(eventMessageId, accumulator)
    } else if (!accumulator) {
      accumulator = new AssistantMessageAccumulator()
      accumulators.current.set(eventMessageId, accumulator)
    }
    if (eventType === 'message_update' || eventType === 'text_start' || eventType === 'text_delta' || eventType === 'text_end' || eventType === 'thinking_start' || eventType === 'thinking_delta' || eventType === 'thinking_end' || eventType === 'toolcall_start' || eventType === 'toolcall_delta' || eventType === 'toolcall_end') {
      accumulator.apply(eventType === 'message_update' && inner.assistantMessageEvent ? asObject(inner.assistantMessageEvent) : inner)
      if (Array.isArray(eventMessage.content)) accumulator.reset(eventMessage as AssistantMessage)
    }
    if (eventType === 'message_end' && Array.isArray(eventMessage.content)) {
      accumulator.finalize(eventMessage as AssistantMessage)
      accumulators.current.delete(eventMessageId)
    }
    const accumulated = accumulator.value()
    const callId = inner.toolCallId ?? event.toolCallId
    const owned = typeof callId === 'string' ? toolOwners.current.get(callId) : undefined
    const messageId = owned?.messageId ?? eventMessageId
    const partId = owned?.partId ?? `${messageId}:content:${typeof contentIndex === 'number' ? contentIndex : 0}`
    queryClient.setQueryData<MessageWithParts[]>(key, (old = []) => {
      let messages = [...old]; let message = messages.find((m) => m.info.id === messageId)
      if (!message) { message = { info: { id: messageId, sessionID: session, role: 'assistant', time: { created: Date.now() } } as any, parts: [] }; messages.push(message) }
      const parts = [...message.parts]; const at = parts.findIndex((p) => p.id === partId)
      const current = at >= 0 ? parts[at] as any : undefined
      const kind = inner.type === 'thinking_start' || inner.type === 'thinking_delta' || inner.type === 'thinking_end' ? 'reasoning' : inner.type?.startsWith('toolcall') || inner.type === 'tool_execution_start' || inner.type === 'tool_execution_update' || inner.type === 'tool_execution_end' ? 'tool' : 'text'
      let part: any = current ?? { id: partId, sessionID: session, messageID: messageId, type: kind, ...(kind === 'text' || kind === 'reasoning' ? { text: '' } : { callID: inner.toolCallId ?? inner.id ?? partId, tool: inner.toolName ?? inner.name ?? 'unknown', state: { status: 'pending', input: {}, raw: '' } }) }
      const accumulatedBlock = accumulated.content[typeof contentIndex === 'number' ? contentIndex : 0]
      if (kind === 'tool' && accumulatedBlock?.type === 'toolCall') {
        const rawArguments = typeof accumulatedBlock.arguments === 'string' ? accumulatedBlock.arguments : JSON.stringify(accumulatedBlock.arguments)
        part = { ...part, callID: accumulatedBlock.id ?? part.callID, tool: accumulatedBlock.name ?? part.tool, state: { ...part.state, raw: rawArguments } }
      }
      if (inner.type === 'text_delta' || inner.type === 'thinking_delta') part = { ...part, text: `${part.text ?? ''}${inner.delta ?? ''}` }
      if (inner.type === 'text_end' || inner.type === 'thinking_end') part = { ...part, text: inner.text ?? part.text }
      if (kind === 'reasoning' && !part.time) part = { ...part, time: { start: message.info.time.created } }
      if ((inner.type === 'text_end' || inner.type === 'thinking_end') && part.type === 'reasoning') part = { ...part, time: { start: message.info.time.created, end: Date.now() } }
      if (inner.type === 'toolcall_end') { const call = asObject(inner.toolCall ?? inner); const id = call.id ?? part.callID; part = { ...part, callID: id, tool: call.name ?? part.tool, state: { status: 'pending', input: asObject(call.arguments), raw: JSON.stringify(call.arguments ?? {}) } }; if (typeof id === 'string') toolOwners.current.set(id, { messageId, partId }) }
      if (type === 'tool_execution_start' || inner.type === 'tool_execution_start') part = { ...part, state: { status: 'running', input: asObject(part.state?.input), time: { start: Date.now() } } }
      // Tool output is intentionally not streamed. It can be very large and is
      // fetched by ToolCallPart only when the marker is expanded.
      if (type === 'tool_execution_update' || inner.type === 'tool_execution_update') part = { ...part, state: { ...part.state, status: 'running' } }
      if (type === 'tool_execution_end' || inner.type === 'tool_execution_end') {
              const error = inner.isError || event.isError
              const call = part.callID
              const detailsUrl = `${apiUrl}/sessions/${session}/tool-calls/${encodeURIComponent(String(call))}`
              const result = asObject(inner.result ?? event.result)
              const output = messageText(result.content) || (typeof result.output === 'string' ? result.output : '')
              const metadata = asObject(result.details)
              const time = { start: part.state.time?.start ?? Date.now(), end: Date.now() }
              part = { ...part, state: error
                ? { status: 'error', input: part.state.input ?? {}, error: output || 'Tool execution failed', metadata: { ...metadata, detailsUrl }, time }
                : { status: 'completed', input: part.state.input ?? {}, output, title: typeof result.title === 'string' ? result.title : '', metadata: { ...metadata, detailsUrl }, time } }
            }
      if (at >= 0) parts[at] = part; else parts.push(part)
      // Reconcile every block from Pi's authoritative message_end. The block
      // type is the source of truth; text is never interpreted by its words.
      if (eventType === 'message_end') {
        accumulated.content.forEach((block, index) => {
          const id = `${messageId}:content:${index}`
          const existingIndex = parts.findIndex((value) => value.id === id)
          const value = block.type === 'text' ? block.text : block.type === 'thinking' ? block.thinking : ''
          const next: any = block.type === 'toolCall'
            ? { id, sessionID: session, messageID: messageId, type: 'tool', callID: block.id ?? id, tool: block.name ?? 'unknown', state: { status: 'pending', input: typeof block.arguments === 'string' ? (() => { try { return JSON.parse(block.arguments) } catch { return {} } })() : block.arguments, raw: typeof block.arguments === 'string' ? block.arguments : JSON.stringify(block.arguments) } }
            : { ...(existingIndex >= 0 ? parts[existingIndex] : {}), id, sessionID: session, messageID: messageId, type: block.type === 'thinking' ? 'reasoning' : 'text', text: value, ...(block.type === 'thinking' ? { time: { start: message.info.time.created, end: Date.now() } } : {}) }
          if (existingIndex >= 0) parts[existingIndex] = next
          else parts.push(next)
        })
        parts.sort((a, b) => {
          const ai = Number(a.id.match(/:content:(\d+)$/)?.[1]); const bi = Number(b.id.match(/:content:(\d+)$/)?.[1])
          if (Number.isFinite(ai) && Number.isFinite(bi)) return ai - bi
          if (Number.isFinite(ai)) return -1
          if (Number.isFinite(bi)) return 1
          return a.id.localeCompare(b.id)
        })
      }
      messages[messages.indexOf(message)] = { ...message, parts, info: (eventType === 'message_end' ? { ...message.info, time: { ...message.info.time, completed: Date.now() } } : message.info) as any }
      return messages
    })
  }, [apiUrl, key, queryClient, sessionID])

  useEffect(() => {
    if (!apiUrl || !sessionID) return
    let closed = false; const socket = new WebSocket(`${wsUrl(apiUrl)}/sessions/${encodeURIComponent(sessionID)}/events`); socketRef.current = socket
    socket.onopen = () => { setConnected(true); setReconnecting(false); socket.send(JSON.stringify({ type: 'history.load', limit: 30 })) }
    socket.onmessage = (message) => { const value = asObject(JSON.parse(message.data)); if (value.type === 'history.chunk') { const incoming = (value.messages ?? []) as MessageWithParts[]; cursor.current = value.before ?? null; setHasOlder(Boolean(value.hasMore)); queryClient.setQueryData<MessageWithParts[]>(key, (old = []) => value.mode === 'prepend' ? [...incoming.filter((x) => !old.some((y) => y.info.id === x.info.id)), ...old] : incoming); setLoading(false); const loadingAll = loadAllRef.current; if (loadingAll) { loadingAll.messages = [...incoming, ...loadingAll.messages.filter((old) => !incoming.some((item) => item.info.id === old.info.id))]; if (value.hasMore && cursor.current) socket.send(JSON.stringify({ type: 'history.load', before: cursor.current, limit: 30 })); else { loadAllRef.current = null; loadingAll.resolve(loadingAll.messages) } } } else if (value.type === 'transcript.event') applyEvent(value) }
    socket.onclose = () => {
      setConnected(false)
       if (loadAllRef.current) { loadAllRef.current.reject(new Error('Transcript connection closed before loading all messages')); loadAllRef.current = null }
       if (!closed) {
        setReconnecting(true)
        reconnectTimer.current = setTimeout(() => { if (!closed) { setLoading(true); setReconnectAttempt((value) => value + 1) } }, 1000)
      }
    }
    return () => { closed = true; if (reconnectTimer.current) clearTimeout(reconnectTimer.current); socket.close(); socketRef.current = null }
  }, [apiUrl, sessionID, key, queryClient, applyEvent, reconnectAttempt])

  const loadOlder = useCallback(() => { if (!cursor.current || loadingOlder.current || socketRef.current?.readyState !== WebSocket.OPEN) return; loadingOlder.current = true; socketRef.current.send(JSON.stringify({ type: 'history.load', before: cursor.current, limit: 30 })); setTimeout(() => { loadingOlder.current = false }, 300) }, [])
  const loadAll = useCallback(() => new Promise<MessageWithParts[]>((resolve, reject) => {
    const current = queryClient.getQueryData<MessageWithParts[]>(key) ?? []
    if (!cursor.current || !hasOlder) { resolve(current); return }
    if (socketRef.current?.readyState !== WebSocket.OPEN) { reject(new Error('Transcript is not connected')); return }
    loadAllRef.current = { messages: current, resolve, reject }
    socketRef.current.send(JSON.stringify({ type: 'history.load', before: cursor.current, limit: 30 }))
  }), [hasOlder, key, queryClient])
  return { messages: query.data, isLoading, isConnected, isReconnecting, hasOlder, loadOlder, loadAll }
}
