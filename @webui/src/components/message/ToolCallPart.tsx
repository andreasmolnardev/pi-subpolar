import { useState, useRef, useEffect } from 'react'
import type { components } from '@/api/opencode-types'
import { useSettings } from '@/hooks/useSettings'
import { useUserBash } from '@/stores/userBashStore'
import { useSessionStatusForSession } from '@/stores/sessionStatusStore'
import { usePermissions, useQuestions } from '@/contexts/EventContext'
import { detectFileReferences } from '@/lib/fileReferences'
import { Brain, ChevronDown, Code2, ExternalLink, FileText, Globe2, Loader2, Pencil, Search, Terminal, Wrench } from 'lucide-react'
import { CopyButton } from '@/components/ui/copy-button'
import { getToolSpecificRender } from './FileToolRender'

type ToolPart = components['schemas']['ToolPart']

interface ToolCallPartProps {
  part: ToolPart
  onFileClick?: (filePath: string, lineNumber?: number) => void
  onChildSessionClick?: (sessionId: string) => void
  simpleChatMode?: boolean
}

function getTaskSessionId(part: ToolPart): string | undefined {
  let sessionId = part.metadata?.sessionId as string | undefined
  if (!sessionId && part.state.status !== 'pending' && 'metadata' in part.state) {
    sessionId = part.state.metadata?.sessionId as string | undefined
  }
  return sessionId
}

function ClickableJson({ json, onFileClick }: { json: unknown; onFileClick?: (filePath: string) => void }) {
  const jsonString = JSON.stringify(json, null, 2)
  const references = detectFileReferences(jsonString)

  if (references.length === 0) {
    return <pre className="bg-accent p-2 rounded text-xs overflow-x-auto whitespace-pre-wrap break-words">{jsonString}</pre>
  }

  const parts: React.ReactNode[] = []
  let lastIndex = 0

  references.forEach((ref, index) => {
    if (ref.startIndex > lastIndex) {
      parts.push(jsonString.slice(lastIndex, ref.startIndex))
    }

    parts.push(
      <span
        key={`ref-${index}`}
        onClick={(e) => {
          e.stopPropagation()
          onFileClick?.(ref.filePath)
        }}
        className="text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 cursor-pointer underline decoration-dotted"
        title={`Click to open ${ref.filePath}`}
      >
        {ref.fullMatch}
      </span>
    )

    lastIndex = ref.endIndex
  })

  if (lastIndex < jsonString.length) {
    parts.push(jsonString.slice(lastIndex))
  }

  return <pre className="bg-accent p-2 rounded text-xs overflow-x-auto whitespace-pre-wrap break-words">{parts}</pre>
}

export function ToolCallPart({ part, onFileClick, onChildSessionClick }: ToolCallPartProps) {
  const { preferences } = useSettings()
  const { userBashCommands } = useUserBash()
  const taskSessionId = part.tool === 'task' ? getTaskSessionId(part) : undefined
  const taskSessionStatus = useSessionStatusForSession(taskSessionId)
  const { getForCallID: getPermissionForCallID } = usePermissions()
  const { getForCallID: getQuestionForCallID } = useQuestions()
  const outputRef = useRef<HTMLDivElement>(null)
  const isUserBashCommand = part.tool === 'bash' &&
    part.state.status === 'completed' &&
    typeof part.state.input?.command === 'string' &&
    userBashCommands.has(part.state.input.command)
  const isTodoTool = part.tool === 'todowrite' || part.tool === 'todoread'
  const [expanded, setExpanded] = useState(isUserBashCommand || isTodoTool || (preferences?.expandToolCalls ?? false))

  const pendingPermission = getPermissionForCallID(part.callID, part.sessionID)
  const isWaitingPermission = part.state.status === 'running' && !!pendingPermission
  const pendingQuestion = getQuestionForCallID(part.callID, part.sessionID)
  const isWaitingQuestion = part.state.status === 'running' && !!pendingQuestion

  useEffect(() => {
    if (part.tool === 'bash' && expanded && outputRef.current) {
      outputRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }
  }, [expanded, part.tool])

  const getStatusColor = () => {
    switch (part.state.status) {
      case 'completed':
        return 'text-green-600 dark:text-green-400'
      case 'error':
        return 'text-red-600 dark:text-red-400'
      case 'running':
        if (isWaitingPermission) return 'text-orange-600 dark:text-orange-400'
        if (isWaitingQuestion) return 'text-blue-600 dark:text-blue-400'
        return 'text-yellow-600 dark:text-yellow-400'
      default:
        return 'text-muted-foreground'
    }
  }

  const getStatusIcon = () => {
    switch (part.state.status) {
      case 'completed':
        return <span>✓</span>
      case 'error':
        return <span>✗</span>
      case 'running':
        return <Loader2 className="w-3.5 h-3.5 animate-spin" />
      case 'pending':
        return <span className="inline-block w-2 h-2 rounded-full bg-current animate-pulse" />
      default:
        return <span>○</span>
    }
  }

  const getToolIcon = () => {
    const className = "h-4 w-4 shrink-0 text-muted-foreground"

    switch (part.tool) {
      case 'grep':
      case 'glob':
      case 'list':
        return <Search className={className} />
      case 'webfetch':
        return <Globe2 className={className} />
      case 'read':
        return <FileText className={className} />
      case 'write':
      case 'edit':
        return <Pencil className={className} />
      case 'bash':
        return <Terminal className={className} />
      case 'task':
        return <Brain className={className} />
      case 'apply_patch':
        return <Code2 className={className} />
      default:
        return <Wrench className={className} />
    }
  }

  const getPreviewText = () => {
    if (part.state.status === 'pending') return null

    const input = part.state.input as Record<string, unknown>
    if (!input) return null

    switch (part.tool) {
      case 'read':
      case 'write':
      case 'edit':
        return (input.filePath as string) || null
      case 'bash':
        return (input.command as string) || null
      case 'glob':
        return (input.pattern as string) || null
      case 'grep':
        return (input.pattern as string) || null
      case 'list':
        return (input.path as string) || '.'
      case 'task':
        return (input.description as string) || null
      case 'todowrite':
      case 'todoread':
        return null
      default:
        return null
    }
  }

  const previewText = getPreviewText()
  const isFileTool = ['read', 'write', 'edit'].includes(part.tool)
  const isCompactTool = part.tool === 'bash' || part.tool === 'glob' || part.tool === 'read'
  const isActiveToolStep = part.state.status === 'pending' || part.state.status === 'running'
  const isSkillTool = part.tool === 'skill-load' || part.tool === 'skill-discover'

  const getCompactToolLabel = () => {
    if (!isCompactTool) return part.tool

    if (part.tool === 'read') {
      if (part.state.status === 'running') return 'Reading file'
      if (part.state.status === 'completed') return 'Read File'
      if (part.state.status === 'error') return 'Read Failed'
      return 'Preparing read'
    }

    if (part.state.status === 'running') return part.tool === 'glob' ? 'Running glob' : 'Running command'
    if (part.state.status === 'completed') return part.tool === 'glob' ? 'Ran Glob' : 'Ran Command'
    if (part.state.status === 'error') return part.tool === 'glob' ? 'Glob Failed' : 'Command Failed'
    return part.tool === 'glob' ? 'Preparing glob' : 'Preparing command'
  }

  if (part.tool === 'task') {
    const sessionId = taskSessionId
    const description = previewText || 'Sub-agent task'
    const status = part.state.status

    const isPending = status === 'pending'
    const isRunning = status === 'running' && taskSessionStatus.type !== 'idle'
    const isCompleted = status === 'completed' || (status === 'running' && !!sessionId && taskSessionStatus.type === 'idle')
    const isError = status === 'error'

    const content = (
      <div className="flex min-w-0 items-center gap-2">
        <Brain className="h-4 w-4 shrink-0 text-muted-foreground" />
        {isPending && <span className="inline-block h-2 w-2 rounded-full bg-current text-muted-foreground animate-pulse" />}
        {isRunning && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-yellow-600 dark:text-yellow-400" />}
        {isCompleted && <span className="text-green-600 text-sm font-medium">✓</span>}
        {isError && <span className="text-red-600 text-sm font-medium">✗</span>}
        <span className={isPending || isRunning ? 'reasoning-text-trail font-medium truncate' : 'font-medium text-muted-foreground truncate'}>{description}</span>
        <span className="shrink-0 text-[11px] font-medium text-orange-600 dark:text-orange-400">sub-agent</span>
        {sessionId && <ExternalLink className="w-3 h-3 shrink-0 text-blue-600 dark:text-blue-400" />}
      </div>
    )

    if (sessionId) {
      return (
        <button
          onClick={() => onChildSessionClick?.(sessionId)}
          className="my-1 w-full rounded-md py-1 text-left text-xs text-muted-foreground transition-colors hover:text-foreground"
          title="View subagent session"
        >
          {content}
        </button>
      )
    }

    return (
      <div className="my-1 py-1 text-xs text-muted-foreground">
        {content}
      </div>
    )
  }

  if (isTodoTool) {
    if (part.state.status === 'error') {
      return (
        <div className="my-2 text-sm text-red-600 dark:text-red-400">
          Error updating tasks: {part.state.error}
        </div>
      )
    }

    return null
  }

  if (isSkillTool) {
    const isSkillDiscoverTool = part.tool === 'skill-discover'
    const skillName = !isSkillDiscoverTool && part.state.status !== 'pending' && part.state.input && typeof part.state.input.name === 'string'
      ? part.state.input.name
      : undefined
    const label = part.state.status === 'running'
      ? isSkillDiscoverTool ? 'Discovering Skills' : 'Loading skill'
      : part.state.status === 'completed'
        ? isSkillDiscoverTool ? 'Discovered Skills' : `Loaded skill${skillName ? ` ${skillName}` : ''}`
        : part.state.status === 'error'
          ? isSkillDiscoverTool ? 'Skill discovery failed' : `Skill load failed${skillName ? ` ${skillName}` : ''}`
          : isSkillDiscoverTool ? 'Preparing skill discovery' : 'Preparing skill load'

    return (
      <details className="group my-2 text-sm text-muted-foreground">
        <summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded-md py-1 text-muted-foreground transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden">
          {isSkillDiscoverTool && <Search className="mr-1 h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
          {part.state.status === 'running' && <Loader2 className="mr-1 h-3.5 w-3.5 shrink-0 animate-spin text-yellow-600 dark:text-yellow-400" />}
          {part.state.status === 'error' && <span className="mr-1 text-red-600 text-sm font-medium">✗</span>}
          <span className={part.state.status === 'running' ? 'reasoning-text-trail font-medium' : 'font-medium text-muted-foreground'}>{label}</span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-200 group-open:rotate-180" />
        </summary>
        <div className="space-y-2 pl-6 pt-1 text-muted-foreground animate-disclosure-down">
          {part.state.status === 'running' && (
            <div className="text-sm">
              <div className="text-muted-foreground mb-1">Input:</div>
              <ClickableJson json={part.state.input} onFileClick={onFileClick} />
            </div>
          )}
          {part.state.status === 'completed' && (
            <div className="text-sm">
              <div className="text-muted-foreground mb-1">Output:</div>
              <div className="relative">
                <pre className="bg-accent p-2 rounded text-xs overflow-x-auto whitespace-pre-wrap break-all">{part.state.output}</pre>
                <CopyButton content={part.state.output} title="Copy output" className="absolute top-1 right-1" iconSize="sm" />
              </div>
            </div>
          )}
          {part.state.status === 'error' && (
            <div className="text-sm">
              <div className="text-red-600 dark:text-red-400 mb-1">Error:</div>
              <pre className="bg-accent p-2 rounded text-xs overflow-x-auto whitespace-pre-wrap break-words text-red-600 dark:text-red-300">{part.state.error}</pre>
            </div>
          )}
        </div>
      </details>
    )
  }

  const toolSpecificRender = getToolSpecificRender(part, onFileClick)
  if (toolSpecificRender) {
    return toolSpecificRender
  }

  if (isUserBashCommand) {
    const command = part.state.input.command as string
    const output = part.state.status === 'completed' ? part.state.output : ''
    const hasOutput = output.trim().length > 0
    return (
      <details className="group my-2 text-sm text-muted-foreground" open={part.state.status !== 'completed' || hasOutput}>
        <summary className="flex cursor-pointer list-none items-center gap-2 rounded-md py-1 text-muted-foreground transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden">
          <Terminal className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className={part.state.status === 'running' ? 'reasoning-text-trail font-medium truncate' : 'font-medium text-muted-foreground truncate'}>{command}</span>
          {part.state.status === 'completed' && part.state.time && (
            <span className="text-muted-foreground text-xs ml-auto">
              {((part.state.time.end - part.state.time.start) / 1000).toFixed(2)}s
            </span>
          )}
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-200 group-open:rotate-180" />
        </summary>
        {hasOutput && (
          <div className="relative pl-6 pt-1 animate-disclosure-down">
            <pre className="bg-accent p-3 rounded text-xs overflow-x-auto whitespace-pre-wrap">
              {output}
            </pre>
            <CopyButton content={output} title="Copy output" className="absolute top-3 right-2" />
          </div>
        )}
      </details>
    )
  }

  return (
    <div ref={outputRef} className="my-2 text-sm text-muted-foreground">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full min-w-0 items-center gap-2 rounded-md py-1 text-left text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        {getToolIcon()}
        {!isCompactTool && <span className={getStatusColor()}>{getStatusIcon()}</span>}
        <span className={isActiveToolStep ? 'reasoning-text-trail font-medium' : 'font-medium text-muted-foreground'}>{getCompactToolLabel()}</span>
        {isCompactTool && <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`} />}

        {previewText && isFileTool && !isCompactTool ? (
          <span
            onClick={(e) => {
              e.stopPropagation()
              if (onFileClick && previewText) {
                onFileClick(previewText)
              }
            }}
            className="text-blue-600 dark:text-blue-400 text-xs truncate hover:text-blue-700 dark:hover:text-blue-300 cursor-pointer underline decoration-dotted"
            title={`Click to open ${previewText}`}
          >
            {previewText}
          </span>
        ) : previewText && !isCompactTool ? (
          <span className="text-muted-foreground text-xs truncate">{previewText}</span>
        ) : null}

        {part.tool === 'task' && (() => {
          const sessionId = getTaskSessionId(part)
          return sessionId ? (
            <span
              onClick={(e) => {
                e.stopPropagation()
                onChildSessionClick?.(sessionId)
              }}
              className="text-blue-600 dark:text-blue-400 text-xs hover:text-blue-700 dark:hover:text-blue-300 cursor-pointer underline decoration-dotted flex items-center gap-1"
              title="View subagent session"
            >
              <ExternalLink className="w-3 h-3" />
              View Session
            </span>
          ) : null
        })()}
         {!isCompactTool && <span className="ml-auto text-xs text-muted-foreground">{isWaitingPermission ? 'awaiting permission' : isWaitingQuestion ? 'awaiting answer' : part.state.status}</span>}
         {!isCompactTool && <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`} />}
      </button>

      {expanded && (
        <div className="space-y-2 pl-6 pt-1 text-muted-foreground animate-disclosure-down">
          {part.state.status === 'pending' && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <div className="flex gap-0.5">
                <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-bounce" style={{ animationDelay: '0ms' }} />
                <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-bounce" style={{ animationDelay: '150ms' }} />
                <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-bounce" style={{ animationDelay: '300ms' }} />
              </div>
              <span>Preparing tool call...</span>
            </div>
          )}

          {isCompactTool && previewText && (
            <div className="text-sm">
              <div className="text-muted-foreground mb-1">{part.tool === 'glob' ? 'Pattern:' : part.tool === 'read' ? 'File:' : 'Command:'}</div>
              <pre className="bg-accent p-2 rounded text-xs overflow-x-auto whitespace-pre-wrap break-all">{previewText}</pre>
            </div>
          )}

          {part.state.status === 'running' && (
            <>
              {isCompactTool ? (
                <div className={`flex items-center gap-2 text-xs ${isWaitingPermission ? 'text-orange-600 dark:text-orange-400' : 'text-yellow-600 dark:text-yellow-400'}`}>
                  <Loader2 className="w-3 h-3 animate-spin" />
                  <span>{isWaitingPermission ? 'Waiting for permission...' : 'Running...'}</span>
                </div>
              ) : (
                <div className="text-sm">
                  <div className="text-muted-foreground mb-1">Input:</div>
                  <ClickableJson json={part.state.input} onFileClick={onFileClick} />
                  <div className={`flex items-center gap-2 mt-2 text-xs ${isWaitingPermission ? 'text-orange-600 dark:text-orange-400' : 'text-yellow-600 dark:text-yellow-400'}`}>
                    <Loader2 className="w-3 h-3 animate-spin" />
                    <span>{isWaitingPermission ? 'Waiting for permission...' : 'Running...'}</span>
                  </div>
                </div>
              )}
            </>
          )}

          {part.state.status === 'completed' && (
            <>
              {!isCompactTool && (
                <div className="text-sm">
                  <div className="text-muted-foreground mb-1">Input:</div>
                  <ClickableJson json={part.state.input} onFileClick={onFileClick} />
                </div>
              )}
              {part.tool !== 'bash' || part.state.output.trim() ? (
                <div className="text-sm">
                  <div className="text-muted-foreground mb-1">Output:</div>
                  <div className="relative">
                    <pre className="bg-accent p-2 rounded text-xs overflow-x-auto whitespace-pre-wrap break-all">
                      {part.state.status === 'completed' ? part.state.output : ''}
                    </pre>
                    <CopyButton content={part.state.output} title="Copy output" className="absolute top-1 right-1" iconSize="sm" />
                  </div>
                </div>
              ) : null}
              {part.state.time && (
                <div className="text-xs text-muted-foreground">
                  Duration: {((part.state.time.end - part.state.time.start) / 1000).toFixed(2)}s
                </div>
              )}
            </>
          )}

          {part.state.status === 'error' && (
            <div className="text-sm">
              <div className="text-red-600 dark:text-red-400 mb-1">Error:</div>
              <pre className="bg-accent p-2 rounded text-xs overflow-x-auto whitespace-pre-wrap break-words text-red-600 dark:text-red-300">
                {part.state.error}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
