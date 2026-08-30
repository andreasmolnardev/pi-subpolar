import { memo } from 'react'
import type { components } from '@/api/opencode-types'
import { Brain, ChevronDown, Loader2, Volume2, VolumeX } from 'lucide-react'
import { TextPart } from './TextPart'
import { PatchPart } from './PatchPart'
import { ToolCallPart } from './ToolCallPart'
import { RetryPart } from './RetryPart'
import { useTTS } from '@/hooks/useTTS'
import { useMobile } from '@/hooks/useMobile'
import { useSettings } from '@/hooks/useSettings'
import { CopyButton } from '@/components/ui/copy-button'

type RetryPartType = components['schemas']['RetryPart']

type Part = components['schemas']['Part']

interface MessagePartProps {
  part: Part
  role?: string
  allParts?: Part[]
  partIndex?: number
  onFileClick?: (filePath: string, lineNumber?: number) => void
  onChildSessionClick?: (sessionId: string) => void
  messageTextContent?: string
  isActiveGenerationStep?: boolean
  assistantMetadata?: AssistantMetadata
}

interface AssistantMetadata {
  modelID?: string
  created?: number
  completed?: number
}

function formatTime(value?: number): string | undefined {
  return value ? new Date(value).toLocaleTimeString() : undefined
}

function getCopyableContent(part: Part, allParts?: Part[]): string {
  switch (part.type) {
    case 'text':
      return part.text || ''
    case 'patch':
      return `Patch: ${part.hash}\nFiles: ${part.files.join(', ')}`
    case 'tool':
      if (part.state.status === 'completed' && part.state.input) {
        return JSON.stringify(part.state.input, null, 2)
      } else if (part.state.status === 'running' && part.state.input) {
        return JSON.stringify(part.state.input, null, 2)
      }
      return `Tool: ${part.tool} (${part.state.status})`
    case 'reasoning':
      return part.text || ''
    case 'snapshot':
      return part.snapshot || ''
    case 'agent':
      return `Agent: ${part.name}`
    case 'subtask':
      return `${part.agent}: ${part.description}\n\n${part.prompt}`.trim()
    case 'step-finish':
      if (allParts) {
        return allParts
          .filter(p => p.type === 'text')
          .map(p => p.text || '')
          .join('\n\n')
          .trim()
      }
      return ''
    case 'file':
      return part.filename || part.url || 'File'
    default:
      return ''
  }
}

interface TTSButtonProps {
  messageId: string
  content: string
  className?: string
}

function TTSButton({ messageId, content, className = "" }: TTSButtonProps) {
  const { speakMessage, stop, isEnabled, isPlaying, isLoading, activeMessageId } = useTTS()
  
  if (!isEnabled || !content.trim()) {
    return null
  }
  
  const isThisPlaying = (isPlaying || isLoading) && activeMessageId === messageId
  
  const handleClick = () => {
    if (isThisPlaying) {
      stop()
    } else {
      speakMessage(messageId, content)
    }
  }

  return (
    <button
      onClick={handleClick}
      className={`p-1.5 rounded ${isThisPlaying ? 'bg-red-500/20 text-red-500 hover:bg-red-500/30' : 'bg-card hover:bg-card-hover text-muted-foreground hover:text-foreground'} ${className}`}
      title={isThisPlaying ? "Stop playback" : "Read aloud"}
      disabled={isLoading && !isThisPlaying}
    >
      {isLoading && isThisPlaying ? (
        <Loader2 className="w-4 h-4 animate-spin" />
      ) : isThisPlaying ? (
        <VolumeX className="w-4 h-4" />
      ) : (
        <Volume2 className="w-4 h-4" />
      )}
    </button>
  )
}

export const MessagePart = memo(function MessagePart({ part, role, allParts, partIndex, onFileClick, onChildSessionClick, messageTextContent, isActiveGenerationStep = false, assistantMetadata }: MessagePartProps) {
  const { preferences } = useSettings()
  const simpleChatMode = preferences?.simpleChatMode ?? false
  const showReasoning = preferences?.showReasoning ?? false
  const copyableContent = getCopyableContent(part, allParts)
  const isMobile = useMobile()
  
  switch (part.type) {
    case 'text':
      if (part.synthetic) return null
      if (role === 'user' && allParts && partIndex !== undefined) {
        const nextPart = allParts[partIndex + 1]
        if (nextPart && nextPart.type === 'file') {
          return null
        }
      }
      return <TextPart part={part} />
    case 'patch':
      if (simpleChatMode) return null
      return <PatchPart part={part} onFileClick={onFileClick} />
    case 'tool':
      if (simpleChatMode && part.tool !== 'task') return null
      return <ToolCallPart part={part} onFileClick={onFileClick} onChildSessionClick={onChildSessionClick} />
    case 'reasoning':
      if (simpleChatMode || !showReasoning) return null
      return (
        <details open={isActiveGenerationStep} className="group my-2 text-sm text-muted-foreground">
          <summary className="flex cursor-pointer list-none items-center gap-2 rounded-md py-1 text-muted-foreground transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden">
            <Brain className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className={isActiveGenerationStep ? 'reasoning-text-trail font-medium' : 'font-medium text-muted-foreground'}>Reasoning</span>
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-200 group-open:rotate-180" />
          </summary>
          <div className="overflow-hidden whitespace-pre-wrap pl-6 pt-1 text-muted-foreground/90 animate-disclosure-down">
            {part.text}
          </div>
        </details>
      )
    case 'snapshot':
      if (simpleChatMode) return null
      return (
        <div className="border border-border rounded-lg p-4 my-2 bg-card">
          <div className="text-xs text-muted-foreground font-mono">Snapshot: {part.snapshot}</div>
        </div>
      )
    case 'agent':
      if (simpleChatMode) return null
      return (
        <div className="border border-border rounded-lg p-4 my-2 bg-card">
          <div className="text-sm font-medium text-blue-600 dark:text-blue-400">Agent: {part.name}</div>
        </div>
      )
    case 'step-finish':
      if (simpleChatMode) return null
      if (!assistantMetadata?.completed) return null
      {
        const isFree = part.cost === 0
        const totalTokens = part.tokens.input + part.tokens.output + (part.tokens.cache?.read || 0)
        const durationSeconds = assistantMetadata?.created && assistantMetadata.completed
          ? Math.max(0, assistantMetadata.completed - assistantMetadata.created) / 1000
          : part.time ? (part.time.end - part.time.start) / 1000 : undefined
        const tokensPerSecond = durationSeconds && durationSeconds > 0 ? part.tokens.output / durationSeconds : undefined
        const startedAt = formatTime(assistantMetadata?.created)
        const endedAt = formatTime(assistantMetadata?.completed)
        const metadataItems = [
          assistantMetadata?.modelID,
          endedAt ?? startedAt,
          durationSeconds !== undefined ? `${durationSeconds.toFixed(1)}s` : undefined,
          tokensPerSecond ? `${tokensPerSecond.toFixed(1)} t/s` : undefined,
          isMobile && isFree ? undefined : `$${part.cost.toFixed(4)}`,
          `${totalTokens} tokens`,
        ].filter(Boolean)
        return (
          <div className="text-xs text-muted-foreground my-1 flex items-center gap-2">
            <span>{metadataItems.join(' • ')}</span>
            <CopyButton content={copyableContent} title="Copy step complete" />
            {messageTextContent && part.messageID && <TTSButton messageId={part.messageID} content={messageTextContent} />}
          </div>
        )
      }
    case 'file':
      return (
        <span className="inline-flex items-center gap-1 px-2 py-1 rounded bg-muted border border-border text-sm text-foreground">
          <span className="text-blue-600 dark:text-blue-400">@</span>
          <span className="font-medium">{part.filename || 'File'}</span>
        </span>
      )
    case 'retry':
      return <RetryPart part={part as RetryPartType} />
    case 'subtask': {
      const label = part.description || part.prompt || 'Sub-agent task'
      return (
        <div className="my-1 w-full py-1 text-left text-xs text-muted-foreground">
          <div className="flex items-center gap-2 min-w-0">
            <Brain className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="truncate">{label}</span>
            <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">sub-agent</span>
          </div>
        </div>
      )
    }
    case 'step-start':
    case 'compaction':
      return null
    default:
      return null
  }
})
