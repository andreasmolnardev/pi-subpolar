import { memo, useMemo, useState, useCallback, useEffect } from 'react'
import { Pencil, RotateCcw, Send } from 'lucide-react'
import { CopyButton } from '@/components/ui/copy-button'
import { MessagePart } from './MessagePart'
import { EditableUserMessage, ClickableUserMessage } from './EditableUserMessage'
import { useRefreshMessage } from '@/hooks/useRemoveMessage'
import { MessageError } from './MessageError'
import { AssistantSuggestions } from './AssistantSuggestions'
import type { Message, Part, MessageWithParts } from '@/api/types'
import { useSessionStatusForSession } from '@/stores/sessionStatusStore'
import { useSessionTodos } from '@/stores/sessionTodosStore'
import { useSettings } from '@/hooks/useSettings'
import type { components } from '@/api/opencode-types'
import type { Todo } from '@/components/message/SessionTodoDisplay'
import type { RuntimeError } from '@/lib/runtime-errors'

function getMessageTextContent(parts: Part[]): string {
  return parts
    .filter(p => p.type === 'text')
    .map(p => p.text || '')
    .join('\n\n')
    .trim()
}

interface MessageThreadProps {
  apiUrl: string
  sessionID: string
  directory?: string
  messages?: MessageWithParts[]
  onFileClick?: (filePath: string, lineNumber?: number) => void
  onChildSessionClick?: (sessionId: string) => void
  model?: string
  suggestionsByAssistantId?: ReadonlyMap<string, string[]>
  onSuggestionSelect?: (suggestion: string) => void
  sessionStartedAt?: number
  readOnly?: boolean
}

function SendingIndicator() {
  return (
    <div className="flex flex-col items-start">
      <div className="flex items-center gap-2 px-1 py-1 text-sm text-muted-foreground">
        <Send className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="reasoning-text-trail font-medium">Sending...</span>
      </div>
    </div>
  )
}

const isMessageStreaming = (msg: Message): boolean => {
  if (msg.role !== 'assistant') return false
  return !('completed' in msg.time && msg.time.completed)
}

function isSessionStatusActive(sessionStatus: { type?: string }): boolean {
  return sessionStatus?.type !== undefined && sessionStatus.type !== 'idle'
}

const compareMessageIds = (id1: string, id2: string): number => {
  const num1 = parseInt(id1, 10)
  const num2 = parseInt(id2, 10)
  if (!isNaN(num1) && !isNaN(num2)) return num1 - num2
  return id1.localeCompare(id2)
}

const hasRenderableContent = (role: Message['role'], parts: Part[], simpleChatMode: boolean): boolean => {
  if (!parts || parts.length === 0) return false
   
  return parts.some(part => {
    switch (part.type) {
      case 'text':
        return !!(part.text && part.text.trim())
      case 'reasoning':
        return !simpleChatMode && !!(part.text && part.text.trim())
      case 'file':
        return role === 'user'
      case 'patch':
      case 'snapshot':
      case 'agent':
        return !simpleChatMode
      case 'tool':
        return !simpleChatMode || part.tool === 'task'
      case 'retry':
        return true
      case 'step-finish':
      case 'step-start':
      case 'compaction':
        return false
      case 'subtask':
        return true
      default:
        return false
    }
  })
}

function isTaskToolPart(part: Part): part is components['schemas']['ToolPart'] {
  return part.type === 'tool' && part.tool === 'task'
}

function isSubAgentActivityPart(part: Part): boolean {
  return part.type === 'subtask' || isTaskToolPart(part)
}

function hasTextContent(parts: Part[]): boolean {
  return parts.some(p => p.type === 'text' && !!(p.text && p.text.trim()))
}

function isBubblePart(part: Part): boolean {
  return part.type === 'text' && !part.synthetic && !!part.text?.trim()
}

function isGenerationStepPart(part: Part): boolean {
  if (part.type === 'reasoning') return !!part.text?.trim()
  if (part.type === 'tool') return part.state.status === 'pending' || part.state.status === 'running'
  if (part.type === 'text') return !part.synthetic && !!part.text?.trim()
  return false
}

function getActiveGenerationPartIndex(parts: Part[]): number | undefined {
  for (let index = parts.length - 1; index >= 0; index--) {
    if (isGenerationStepPart(parts[index])) return index
  }

  return undefined
}

function isBelowBubblePart(part: Part): boolean {
  return part.type === 'step-finish' || part.type === 'retry'
}

function getBelowBubbleParts(role: Message['role'], parts: Part[], bubbleParts: Part[]): Part[] {
  const belowBubbleParts = parts.filter(isBelowBubblePart)
  if (role !== 'assistant' || bubbleParts.length === 0) return belowBubbleParts.filter(part => part.type !== 'step-finish')

  const lastStepFinishIndex = parts.findLastIndex((part: Part) => part.type === 'step-finish')
  return belowBubbleParts.filter(part => part.type !== 'step-finish' || parts.indexOf(part) === lastStepFinishIndex)
}

function isIgnorableSubAgentMessagePart(part: Part): boolean {
  if (part.type === 'step-start' || part.type === 'step-finish' || part.type === 'compaction') {
    return true
  }
  if (part.type === 'text') {
    return !part.text?.trim()
  }
  if (part.type === 'reasoning') {
    return true
  }
  return false
}

function isStandaloneSubAgentMessage(role: Message['role'], parts: Part[]): boolean {
  if (role !== 'assistant') return false
  if (parts.length === 0) return false
  if (hasTextContent(parts)) return false
  
  const hasSubAgentActivity = parts.some(isSubAgentActivityPart)
  const allPartsAreSubAgentOrStructural = parts.every(part => {
    if (isIgnorableSubAgentMessagePart(part)) {
      return true
    }
    return isSubAgentActivityPart(part)
  })
  
  return hasSubAgentActivity && allPartsAreSubAgentOrStructural
}

const findLastMessageByRole = (
  messages: MessageWithParts[],
  role: 'user' | 'assistant',
  predicate?: (msg: Message) => boolean
): string | undefined => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i].info
    if (msg.role === role && (!predicate || predicate(msg))) {
      return msg.id
    }
  }
  return undefined
}

const isDeliveredUserMessage = (message: Message): boolean => {
  if (message.role !== 'user' || !('queueDelivery' in message)) return true
  return (message as Message & { queueDelivery?: string }).queueDelivery === 'sent'
}

export function formatSentTimestamp(timestamp: number, now = new Date()): string {
  const messageDate = new Date(timestamp)
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const messageDay = new Date(messageDate.getFullYear(), messageDate.getMonth(), messageDate.getDate())
  const yesterday = new Date(today)
  yesterday.setDate(yesterday.getDate() - 1)
  const weekAgo = new Date(today)
  weekAgo.setDate(weekAgo.getDate() - 7)
  const time = messageDate.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })

  if (messageDay.getTime() === today.getTime()) return time
  if (messageDay.getTime() === yesterday.getTime()) return `Yesterday ${time}`
  if (messageDay > weekAgo && messageDay < yesterday) {
    return `${messageDate.toLocaleDateString(undefined, { weekday: 'long' })} ${time}`
  }
  return `${messageDate.toLocaleDateString(undefined, { dateStyle: 'medium' })} ${time}`
}

export function shouldShowSentTimestamp(messageTimestamp: number, previousMessageTimestamp?: number): boolean {
  return previousMessageTimestamp === undefined || messageTimestamp - previousMessageTimestamp > 30 * 60 * 1000
}

const isWaitingForAssistant = (messages: MessageWithParts[], pendingAssistantId: string | undefined): boolean => {
  if (pendingAssistantId) return false

  let lastUserIndex = -1
  let lastAssistantIndex = -1
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const role = messages[index].info.role
    if (role === 'user' && lastUserIndex < 0) lastUserIndex = index
    if (role === 'assistant' && lastAssistantIndex < 0) lastAssistantIndex = index
    if (lastUserIndex >= 0 && lastAssistantIndex >= 0) break
  }

  if (lastUserIndex < 0 || lastUserIndex <= lastAssistantIndex) return false
  return isDeliveredUserMessage(messages[lastUserIndex].info)
}

function AttemptTabs({
  attempts,
  activeAttemptID,
  onSelect,
}: {
  attempts: Array<{ id: string; content: string }>
  activeAttemptID: string
  onSelect: (id: string) => void
}) {
  if (attempts.length < 2) return null
  return (
    <div className="mb-1 flex w-full justify-center gap-1" role="tablist" aria-label="Message attempts">
      {attempts.map((attempt, index) => (
        <button
          key={attempt.id}
          type="button"
          role="tab"
          aria-selected={attempt.id === activeAttemptID}
          onClick={() => onSelect(attempt.id)}
          className={`rounded px-2 py-0.5 text-xs ${attempt.id === activeAttemptID ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-accent/60'}`}
        >
          Attempt {index + 1}
        </button>
      ))}
    </div>
  )
}

interface MessageRowProps {
  msgWithParts: MessageWithParts
  nextAssistantMessage: MessageWithParts | undefined
  pendingAssistantId: string | undefined
  lastUserMessageId: string | undefined
  isSessionBusy: boolean
  editingUserMessageId: string | null
  editingForAssistantId: string | null
  apiUrl: string
  sessionID: string
  directory?: string
  onFileClick?: (filePath: string, lineNumber?: number) => void
  onChildSessionClick?: (sessionId: string) => void
  handleStartEditUserMessage: (userMessageId: string, assistantMessageId: string) => void
  handleCancelEdit: () => void
  model?: string
  simpleChatMode: boolean
  suggestions?: string[]
  onSuggestionSelect?: (suggestion: string) => void
  attempts: Array<{ id: string; content: string }>
  activeAttemptID: string
  setActiveAttemptID: (id: string) => void
  onRetryRequest: (messageID: string, content: string, assistantMessageID: string, model?: string) => Promise<void>
  retryingMessageID: string | null
  readOnly: boolean
}

const MessageRow = memo(function MessageRow({
  msgWithParts,
  nextAssistantMessage,
  pendingAssistantId,
  lastUserMessageId,
  isSessionBusy,
  editingUserMessageId,
  editingForAssistantId,
  apiUrl,
  sessionID,
  directory,
  onFileClick,
  onChildSessionClick,
  handleStartEditUserMessage,
  handleCancelEdit,
  model,
  simpleChatMode,
  suggestions,
  onSuggestionSelect,
  attempts,
  activeAttemptID,
  setActiveAttemptID,
  onRetryRequest,
  retryingMessageID,
  readOnly,
}: MessageRowProps) {
  const msg = msgWithParts.info
  const parts = msgWithParts.parts
  const streaming = isMessageStreaming(msg)
  const activeGenerationPartIndex = streaming ? getActiveGenerationPartIndex(parts) : undefined
  const queueDelivery = msg.role === 'user' && 'queueDelivery' in msg
    ? (msg as Message & { queueDelivery?: 'sent' }).queueDelivery
    : undefined
  const isQueued = msg.role === 'user' && queueDelivery !== 'sent' && pendingAssistantId && compareMessageIds(msg.id, pendingAssistantId) > 0
  const isLastUserMessage = msg.role === 'user' && msg.id === lastUserMessageId
  const messageTextContent = getMessageTextContent(parts)
  const assistantMetadata = msg.role === 'assistant'
    ? {
      modelID: 'modelID' in msg ? msg.modelID : undefined,
      created: msg.time?.created,
      completed: 'completed' in msg.time ? msg.time.completed : undefined,
    }
    : undefined

  const nextAssistantMsg = nextAssistantMessage?.info
  const isUserBeforeAssistant = msg.role === 'user' && nextAssistantMessage
  const canEditUserMessage = !readOnly && isLastUserMessage && isUserBeforeAssistant && !isSessionBusy
  const canRetryUserMessage = !readOnly && isLastUserMessage && nextAssistantMessage && !isSessionBusy

  const isEditingThisMessage = !readOnly && editingUserMessageId === msg.id

  const hasContent = hasRenderableContent(msg.role, parts, simpleChatMode)
  const hasError = msg.role === 'assistant' && 'error' in msg && msg.error
  const standaloneSubAgentMessage = isStandaloneSubAgentMessage(msg.role, parts)
  const bubbleParts = parts.filter(isBubblePart)
  const aboveBubbleParts = parts.filter(part => !isBubblePart(part) && !isBelowBubblePart(part))
  const belowBubbleParts = getBelowBubbleParts(msg.role, parts, bubbleParts)
  const messageAlignment = msg.role === 'user' ? 'items-end' : 'items-start'
  const messageWidth = msg.role === 'user' ? 'max-w-[80%]' : 'w-full'

  if (!hasContent && !hasError) {
    return null
  }

  if (standaloneSubAgentMessage) {
    return (
      <div
        key={msg.id}
        className="flex flex-col group"
      >
        <div className="space-y-1">
          {parts.filter(isSubAgentActivityPart).map((part, partIndex) => (
            <div key={`${msg.id}-${part.id}-${partIndex}`}>
              <MessagePart
                part={part}
                role={msg.role}
                allParts={parts}
                partIndex={partIndex}
                onFileClick={onFileClick}
                onChildSessionClick={onChildSessionClick}
                messageTextContent={messageTextContent}
                isActiveGenerationStep={streaming && parts.indexOf(part) === activeGenerationPartIndex}
                assistantMetadata={assistantMetadata}
              />
            </div>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div
      key={msg.id}
      className={`flex flex-col group ${messageAlignment}`}
    >
      <div className={`flex flex-col ${msg.role === 'user' ? 'gap-1' : 'gap-0'} ${messageWidth}`}>
        <div className={`flex items-center justify-between gap-2 px-1 ${msg.role === 'user' ? 'hidden' : ''}`}>
          <div className="flex items-center gap-2">
            {msg.role === 'user' && <span className="text-xs font-medium text-muted-foreground">You</span>}
            {msg.role === 'user' && msg.time && (
              <span className="text-xs text-muted-foreground">
                {new Date(msg.time.created).toLocaleTimeString()}
              </span>
            )}
            {isQueued && (
              <span className="text-xs font-semibold bg-amber-500 text-amber-950 px-1.5 py-0.5 rounded">
                QUEUED
              </span>
            )}
            {queueDelivery === 'sent' && (
              <span className="text-xs font-semibold bg-emerald-500/20 text-emerald-700 dark:text-emerald-300 px-1.5 py-0.5 rounded">
                SENT
              </span>
            )}
          </div>
          
        </div>

        {aboveBubbleParts.length > 0 && (
          <div className="space-y-2">
            {aboveBubbleParts.map((part: Part, partIndex: number) => (
              <div key={`${msg.id}-${part.id}-${partIndex}`}>
                <MessagePart
                  part={part}
                  role={msg.role}
                  allParts={parts}
                  partIndex={parts.indexOf(part)}
                  onFileClick={onFileClick}
                  onChildSessionClick={onChildSessionClick}
                  messageTextContent={msg.role === 'assistant' ? messageTextContent : undefined}
                  isActiveGenerationStep={streaming && parts.indexOf(part) === activeGenerationPartIndex}
                  assistantMetadata={assistantMetadata}
                />
              </div>
            ))}
          </div>
        )}

        {(bubbleParts.length > 0 || (msg.role === 'user' && isEditingThisMessage && editingForAssistantId) || hasError) && (
          <div className={`group/message relative ${msg.role === 'user' ? 'flex flex-col items-end gap-1' : ''}`}>
            {msg.role === 'user' && (
              <AttemptTabs attempts={attempts} activeAttemptID={activeAttemptID} onSelect={setActiveAttemptID} />
            )}
            <div
              className={`${
                msg.role === 'user'
                  ? 'rounded-3xl px-4 py-2'
                  : ''
              } ${
                msg.role === 'user'
                  ? isQueued
                    ? 'bg-amber-500/10 border border-amber-500/30'
                  : isEditingThisMessage
                    ? 'bg-primary/30 border border-primary/50 text-primary-foreground'
                    : 'bg-primary text-primary-foreground border border-primary'
                  : 'bg-transparent border-transparent'
              } ${streaming ? 'animate-pulse-subtle' : ''}`}
            >
              <div className="space-y-2">
              {msg.role === 'user' && attempts.length > 1 ? (
                attempts.find((attempt) => attempt.id === activeAttemptID)?.content ?? messageTextContent
              ) : msg.role === 'user' && isEditingThisMessage && editingForAssistantId ? (
                <EditableUserMessage
                  apiUrl={apiUrl}
                  sessionId={sessionID}
                  directory={directory}
                  content={messageTextContent}
                  assistantMessageId={editingForAssistantId}
                  onCancel={handleCancelEdit}
                  model={model}
                />
              ) : msg.role === 'user' && canEditUserMessage && nextAssistantMsg && !simpleChatMode ? (
                <ClickableUserMessage
                  content={messageTextContent}
                  onClick={() => handleStartEditUserMessage(msg.id, nextAssistantMsg.id)}
                  isEditable={false}
                />
              ) : msg.role === 'user' && simpleChatMode ? (
                <ClickableUserMessage
                  content={messageTextContent}
                  onClick={() => {}}
                  isEditable={false}
                />
              ) : bubbleParts.length > 0 ? (
                bubbleParts.map((part: Part, partIndex: number) => (
                  <div key={`${msg.id}-${part.id}-${partIndex}`}>
                    <MessagePart
                      part={part}
                      role={msg.role}
                      allParts={parts}
                      partIndex={parts.indexOf(part)}
                      onFileClick={onFileClick}
                      onChildSessionClick={onChildSessionClick}
                      messageTextContent={msg.role === 'assistant' ? messageTextContent : undefined}
                      isActiveGenerationStep={streaming && parts.indexOf(part) === activeGenerationPartIndex}
                      assistantMetadata={assistantMetadata}
                    />
                  </div>
                ))
              ) : null}
              {hasError && (
                <MessageError error={msg.error as RuntimeError} />
              )}
              </div>
            </div>
          {msg.role === 'user' && !isEditingThisMessage && (
              <div className="flex items-center gap-1 pr-2 text-muted-foreground opacity-0 transition-opacity group-hover/message:opacity-100 group-focus-within/message:opacity-100">
              <CopyButton content={messageTextContent} title="Copy message" iconSize="md" variant="ghost" />
              {canEditUserMessage && nextAssistantMsg && (
                <button
                  type="button"
                  onClick={() => handleStartEditUserMessage(msg.id, nextAssistantMsg.id)}
                  className="rounded p-1 hover:bg-accent hover:text-foreground"
                  title="Edit message"
                  aria-label="Edit message"
                >
                  <Pencil className="h-4 w-4" />
                </button>
              )}
              {canRetryUserMessage && nextAssistantMsg && (
                <button
                  type="button"
                  onClick={() => void onRetryRequest(msg.id, messageTextContent, nextAssistantMsg.id, model)}
                  disabled={retryingMessageID === msg.id}
                  className="rounded p-1 hover:bg-accent hover:text-foreground disabled:opacity-50"
                  title="Retry request"
                  aria-label="Retry request"
                >
                  <RotateCcw className={`h-4 w-4 ${retryingMessageID === msg.id ? 'animate-spin' : ''}`} />
                </button>
              )}
              </div>
            )}
          </div>
        )}

        {belowBubbleParts.length > 0 && (
          <div className="space-y-2">
            {belowBubbleParts.map((part: Part, partIndex: number) => (
              <div key={`${msg.id}-${part.id}-${partIndex}`}>
                <MessagePart
                  part={part}
                  role={msg.role}
                  allParts={parts}
                  partIndex={parts.indexOf(part)}
                  onFileClick={onFileClick}
                  onChildSessionClick={onChildSessionClick}
                  messageTextContent={msg.role === 'assistant' ? messageTextContent : undefined}
                  isActiveGenerationStep={streaming && parts.indexOf(part) === activeGenerationPartIndex}
                  assistantMetadata={assistantMetadata}
                />
              </div>
            ))}
          </div>
        )}
        {msg.role === 'assistant' && suggestions && onSuggestionSelect && (
          <AssistantSuggestions suggestions={suggestions} onSelect={onSuggestionSelect} />
        )}
      </div>
    </div>
  )
})

export const MessageThread = memo(function MessageThread({ 
  apiUrl, 
  sessionID, 
  directory, 
  messages, 
  onFileClick, 
  onChildSessionClick,
  model,
  suggestionsByAssistantId,
  onSuggestionSelect,
  sessionStartedAt,
  readOnly = false,
}: MessageThreadProps) {
  const [editingUserMessageId, setEditingUserMessageId] = useState<string | null>(null)
  const [editingForAssistantId, setEditingForAssistantId] = useState<string | null>(null)
  const [attemptsByMessageID, setAttemptsByMessageID] = useState<Record<string, Array<{ id: string; content: string }>>>({})
  const [activeAttemptByMessageID, setActiveAttemptByMessageID] = useState<Record<string, string>>({})
  const [retryingMessageID, setRetryingMessageID] = useState<string | null>(null)
  const retryMutation = useRefreshMessage({ apiUrl, sessionId: sessionID, directory })
  const sessionStatus = useSessionStatusForSession(sessionID)
  const { preferences } = useSettings()
  const simpleChatMode = preferences?.simpleChatMode ?? false
  
  const pendingAssistantId = useMemo(() => {
    if (!messages) return undefined
    return findLastMessageByRole(messages, 'assistant', isMessageStreaming)
  }, [messages])

  const lastUserMessageId = useMemo(() => {
    if (!messages) return undefined
    return findLastMessageByRole(messages, 'user')
  }, [messages])

  const nextAssistantByMessageId = useMemo(() => {
    const map = new Map<string, MessageWithParts | undefined>()
    if (!messages) return map
    let next: MessageWithParts | undefined
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]
      map.set(msg.info.id, next)
      if (msg.info.role === 'assistant') {
        next = msg
      }
    }
    return map
  }, [messages])

  const isSessionBusy = !!pendingAssistantId || isSessionStatusActive(sessionStatus)
  const isWaitingForAssistantResponse = sessionStatus.type === 'busy'
    && isWaitingForAssistant(messages ?? [], pendingAssistantId)
  const setSessionTodos = useSessionTodos((state) => state.setTodos)

  useEffect(() => {
    if (!messages || messages.length === 0) return

    const allParts = messages.flatMap(m => m.parts)

    const latestTodoPart = allParts
      .filter((part): part is components['schemas']['ToolPart'] => part.type === 'tool' && (part.tool === 'todowrite' || part.tool === 'todoread'))
      .filter(part => part.state.status === 'completed' && 'time' in part.state)
      .sort((a, b) => {
        const aState = a.state as { time?: { end?: number } }
        const bState = b.state as { time?: { end?: number } }
        const aEndTime = aState.time?.end ?? 0
        const bEndTime = bState.time?.end ?? 0
        return bEndTime - aEndTime
      })[0]

    if (latestTodoPart) {
      const state = latestTodoPart.state
      let todos: Todo[] = []

      if ('metadata' in state && state.metadata?.todos && Array.isArray(state.metadata.todos)) {
        todos = state.metadata.todos as Todo[]
      } else if ('output' in state && state.output) {
        try {
          const parsed = JSON.parse(state.output)
          todos = Array.isArray(parsed)
            ? parsed as Todo[]
            : parsed?.todos ? parsed.todos as Todo[]
            : []
        } catch (_) {
          console.warn('Failed to parse todo output:', _)
        }
      }

      if (todos.length > 0) {
        setSessionTodos(sessionID, todos)
      }
    }
  }, [messages, sessionID, setSessionTodos])

  const handleStartEditUserMessage = useCallback((userMessageId: string, assistantMessageId: string) => {
    setEditingUserMessageId(userMessageId)
    setEditingForAssistantId(assistantMessageId)
  }, [])

  const handleCancelEdit = useCallback(() => {
    setEditingUserMessageId(null)
    setEditingForAssistantId(null)
  }, [])

  const handleRetryMessage = useCallback((messageID: string, content: string): string => {
    const attempt = { id: `attempt-${Date.now()}-${Math.random()}`, content }
    setAttemptsByMessageID((current) => ({
      ...current,
      [messageID]: [...(current[messageID] ?? [{ id: messageID, content }]), attempt],
    }))
    setActiveAttemptByMessageID((active) => ({ ...active, [messageID]: attempt.id }))
    return attempt.id
  }, [])

  const handleRetryRequest = useCallback(async (messageID: string, content: string, assistantMessageID: string, requestModel?: string) => {
    setRetryingMessageID(messageID)
    const attemptID = handleRetryMessage(messageID, content)
    try {
      await retryMutation.mutateAsync({ assistantMessageID, userMessageContent: content, model: requestModel })
    } catch {
      setAttemptsByMessageID((current) => ({
        ...current,
        [messageID]: (current[messageID] ?? []).filter((attempt) => attempt.id !== attemptID),
      }))
      setActiveAttemptByMessageID((current) => ({ ...current, [messageID]: messageID }))
    } finally {
      setRetryingMessageID(null)
    }
  }, [handleRetryMessage, retryMutation])
  
  if (!messages || messages.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground">
        No messages yet. Start a conversation below.
      </div>
    )
  }

  return (
    <div className="flex flex-col space-y-2 p-2 overflow-x-hidden">
        {messages.map((msgWithParts, messageIndex) => (
        <div key={msgWithParts.info.id} className="relative w-full">
        {msgWithParts.info.role === 'user' && messageIndex === messages.findIndex((message) => message.info.role === 'user') && sessionStartedAt && (
          <div className="pointer-events-none absolute inset-x-0 -top-6 text-center text-xs text-muted-foreground">
            {new Date(sessionStartedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
          </div>
        )}
        {msgWithParts.info.role === 'user' && msgWithParts.info.time && shouldShowSentTimestamp(
          msgWithParts.info.time.created,
          messageIndex > 0 ? messages[messageIndex - 1].info.time?.created : undefined,
        ) && (
          <div className="w-full pb-2 text-center text-xs text-muted-foreground">
            {formatSentTimestamp(msgWithParts.info.time.created)}
          </div>
        )}
        <MessageRow
          msgWithParts={msgWithParts}
          nextAssistantMessage={nextAssistantByMessageId.get(msgWithParts.info.id)}
          pendingAssistantId={pendingAssistantId}
          lastUserMessageId={lastUserMessageId}
          isSessionBusy={isSessionBusy}
          attempts={attemptsByMessageID[msgWithParts.info.id] ?? [{ id: msgWithParts.info.id, content: getMessageTextContent(msgWithParts.parts) }]}
          activeAttemptID={activeAttemptByMessageID[msgWithParts.info.id] ?? msgWithParts.info.id}
          setActiveAttemptID={(attemptID) => setActiveAttemptByMessageID((current) => ({ ...current, [msgWithParts.info.id]: attemptID }))}
          onRetryRequest={handleRetryRequest}
          retryingMessageID={retryingMessageID}
          readOnly={readOnly}
          editingUserMessageId={editingUserMessageId}
          editingForAssistantId={editingForAssistantId}
          apiUrl={apiUrl}
          sessionID={sessionID}
          directory={directory}
          onFileClick={onFileClick}
          onChildSessionClick={onChildSessionClick}
          handleStartEditUserMessage={handleStartEditUserMessage}
          handleCancelEdit={handleCancelEdit}
          model={model}
          simpleChatMode={simpleChatMode}
          suggestions={suggestionsByAssistantId?.get(msgWithParts.info.id)}
          onSuggestionSelect={onSuggestionSelect}
        />
        </div>
      ))}
      {isWaitingForAssistantResponse && <SendingIndicator />}
    </div>
  )
})
