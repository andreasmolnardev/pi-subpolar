import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { MessageWithParts } from '@/api/types'
import { messagesQueryKey } from '@/lib/queryInvalidation'

const asObject = (v: unknown): Record<string, any> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : {}
const wsUrl = (url: string) => {
  // WebSocket requires an absolute URL. API_BASE_URL is commonly relative
  // ("/api"), especially when the UI and bridge are served together.
  const base = new URL(url || '/', window.location.origin)
  base.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:'
  return base.toString().replace(/\/$/, '')
}

export function useSessionTranscript(apiUrl: string | null | undefined, sessionID: string | undefined, directory?: string) {
  const queryClient = useQueryClient(); const socketRef = useRef<WebSocket | null>(null); const cursor = useRef<string | null>(null)
  const loadingOlder = useRef(false); const toolOwners = useRef(new Map<string, { messageId: string; partId: string }>()); const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null); const [reconnectAttempt, setReconnectAttempt] = useState(0); const [isLoading, setLoading] = useState(true); const [isConnected, setConnected] = useState(false); const [isReconnecting, setReconnecting] = useState(false); const [hasOlder, setHasOlder] = useState(false)
  const key = useMemo(() => messagesQueryKey(apiUrl, sessionID, directory), [apiUrl, sessionID, directory])
  const query = useQuery<MessageWithParts[]>({ queryKey: key, queryFn: async () => [], enabled: false })
  const applyEvent = useCallback((raw: unknown) => {
    const envelope = asObject(raw); const event = asObject(envelope.event ?? raw); const type = String(event.type ?? '')
    // Pi wraps streaming content in assistantMessageEvent. The bridge deliberately keeps
    // this small transport envelope; this reducer is the single live projector.
    const inner = asObject(event.assistantMessageEvent ?? event); const session = sessionID!; const contentIndex = inner.contentIndex
    const eventMessageId = typeof event.messageId === 'string' ? event.messageId : (typeof event.messageID === 'string' ? event.messageID : `live:${session}:assistant`)
    const callId = inner.toolCallId ?? event.toolCallId
    const owned = typeof callId === 'string' ? toolOwners.current.get(callId) : undefined
    const messageId = owned?.messageId ?? eventMessageId
    const partId = owned?.partId ?? `${messageId}:content:${typeof contentIndex === 'number' ? contentIndex : 0}`
    queryClient.setQueryData<MessageWithParts[]>(key, (old = []) => {
      let messages = [...old]; let message = messages.find((m) => m.info.id === messageId)
      if (!message) { message = { info: { id: messageId, sessionID: session, role: 'assistant', time: { created: Date.now() } } as any, parts: [] }; messages.push(message) }
      const parts = [...message.parts]; const at = parts.findIndex((p) => p.id === partId)
      const current = at >= 0 ? parts[at] as any : undefined
      const kind = inner.type === 'thinking_start' || inner.type === 'thinking_delta' || inner.type === 'thinking_end' ? 'reasoning' : inner.type?.startsWith('toolcall') ? 'tool' : 'text'
      let part: any = current ?? { id: partId, sessionID: session, messageID: messageId, type: kind, ...(kind === 'text' || kind === 'reasoning' ? { text: '' } : { callID: inner.toolCallId ?? inner.id ?? partId, tool: inner.toolName ?? inner.name ?? 'unknown', state: { status: 'pending', input: {}, raw: '' } }) }
      if (inner.type === 'text_delta' || inner.type === 'thinking_delta') part = { ...part, text: `${part.text ?? ''}${inner.delta ?? ''}` }
      if (inner.type === 'text_end' || inner.type === 'thinking_end') part = { ...part, text: inner.text ?? part.text, ...(kind === 'reasoning' ? { time: { start: message.info.time.created, end: Date.now() } } : {}) }
      if (inner.type === 'toolcall_end') { const call = asObject(inner.toolCall ?? inner); const id = call.id ?? part.callID; part = { ...part, callID: id, tool: call.name ?? part.tool, state: { status: 'pending', input: asObject(call.arguments), raw: JSON.stringify(call.arguments ?? {}) } }; if (typeof id === 'string') toolOwners.current.set(id, { messageId, partId }) }
      if (type === 'tool_execution_start' || inner.type === 'tool_execution_start') part = { ...part, state: { status: 'running', input: asObject(part.state?.input), time: { start: Date.now() } } }
      // Tool output is intentionally not streamed. It can be very large and is
      // fetched by ToolCallPart only when the marker is expanded.
      if (type === 'tool_execution_update' || inner.type === 'tool_execution_update') part = { ...part, state: { ...part.state, status: 'running' } }
      if (type === 'tool_execution_end' || inner.type === 'tool_execution_end') { const error = inner.isError || event.isError; const call = part.callID; const detailsUrl = `${apiUrl}/sessions/${session}/tool-calls/${encodeURIComponent(String(call))}`; part = { ...part, state: error ? { status: 'error', input: part.state.input, error: 'Tool execution failed (expand for details)', metadata: { detailsUrl }, time: { start: part.state.time?.start ?? Date.now(), end: Date.now() } } : { status: 'completed', input: part.state.input, output: '', title: '', metadata: { detailsUrl }, time: { start: part.state.time?.start ?? Date.now(), end: Date.now() } } } }
      if (at >= 0) parts[at] = part; else parts.push(part)
      messages[messages.indexOf(message)] = { ...message, parts, info: (inner.type === 'message_end' ? { ...message.info, time: { ...message.info.time, completed: Date.now() } } : message.info) as any }
      return messages
    })
  }, [apiUrl, key, queryClient, sessionID])

  useEffect(() => {
    if (!apiUrl || !sessionID) return
    let closed = false; const socket = new WebSocket(`${wsUrl(apiUrl)}/sessions/${encodeURIComponent(sessionID)}/events`); socketRef.current = socket
    socket.onopen = () => { setConnected(true); setReconnecting(false); socket.send(JSON.stringify({ type: 'history.load', limit: 30 })) }
    socket.onmessage = (message) => { const value = asObject(JSON.parse(message.data)); if (value.type === 'history.chunk') { const incoming = (value.messages ?? []) as MessageWithParts[]; cursor.current = value.before ?? null; setHasOlder(Boolean(value.hasMore)); queryClient.setQueryData<MessageWithParts[]>(key, (old = []) => value.mode === 'prepend' ? [...incoming.filter((x) => !old.some((y) => y.info.id === x.info.id)), ...old] : incoming); setLoading(false) } else if (value.type === 'transcript.event') applyEvent(value) }
    socket.onclose = () => {
      setConnected(false)
      if (!closed) {
        setReconnecting(true)
        reconnectTimer.current = setTimeout(() => { if (!closed) { setLoading(true); setReconnectAttempt((value) => value + 1) } }, 1000)
      }
    }
    return () => { closed = true; if (reconnectTimer.current) clearTimeout(reconnectTimer.current); socket.close(); socketRef.current = null }
  }, [apiUrl, sessionID, key, queryClient, applyEvent, reconnectAttempt])

  const loadOlder = useCallback(() => { if (!cursor.current || loadingOlder.current || socketRef.current?.readyState !== WebSocket.OPEN) return; loadingOlder.current = true; socketRef.current.send(JSON.stringify({ type: 'history.load', before: cursor.current, limit: 30 })); setTimeout(() => { loadingOlder.current = false }, 300) }, [])
  return { messages: query.data, isLoading, isConnected, isReconnecting, hasOlder, loadOlder }
}
