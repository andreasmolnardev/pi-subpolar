import { useContextUsage } from '@/hooks/useContextUsage'
import { CopyButton } from '@/components/ui/copy-button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Button } from '@/components/ui/button'
import { ChevronDown } from 'lucide-react'
import type { MessageWithParts, Part } from '@/api/types'

interface ContextUsageIndicatorProps {
  apiUrl: string | null
  sessionID: string | undefined
  directory?: string
  isConnected: boolean
  isReconnecting?: boolean
  messages?: MessageWithParts[]
}

const getUsageTextColor = (percentage: number) => {
  if (percentage < 50) return 'text-green-700 dark:text-green-400'
  if (percentage < 80) return 'text-yellow-700 dark:text-yellow-400'
  return 'text-red-700 dark:text-red-400'
}

const getPartText = (part: Part) => {
  if (part.type === 'text' || part.type === 'reasoning') return part.text || ''
  if (part.type === 'tool') return `[Tool: ${part.tool || 'unknown'}]`
  if (part.type === 'file') return `[File: ${part.filename || 'unknown'}]`
  if (part.type === 'patch') return '[Patch]'
  return ''
}

const getConversationHistory = (messages: MessageWithParts[] = []) => {
  return messages
    .map((message) => {
      const role = message.info.role === 'assistant' ? 'General Chat' : 'User'
      const content = message.parts.map(getPartText).filter(Boolean).join('\n\n')
      if (!content.trim()) return ''
      return `${role}:\n${content}`
    })
    .filter((entry) => entry.trim())
    .join('\n\n---\n\n')
}

export function ContextUsageIndicator({ apiUrl, sessionID, directory, isConnected, isReconnecting, messages }: ContextUsageIndicatorProps) {
  const { totalTokens, contextLimit, usagePercentage, currentModel, isLoading } = useContextUsage(apiUrl, sessionID, directory)

  if (isLoading) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">Loading...</span>
      </div>
    )
  }

  if (isReconnecting) {
    return <span className="text-xs text-yellow-700 dark:text-yellow-400 font-medium">Reconnecting...</span>
  }

  if (!isConnected) {
    return <span className="text-xs text-muted-foreground font-medium">Disconnected</span>
  }

  const tokenText = contextLimit
    ? `${totalTokens.toLocaleString()} (${Math.round(usagePercentage || 0)}%)`
    : totalTokens.toLocaleString()

  const conversationHistory = getConversationHistory(messages)
  const userMessages = messages?.filter((message) => message.info.role === 'user').length || 0
  const assistantMessages = messages?.filter((message) => message.info.role === 'assistant').length || 0

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs font-medium">
          <span className={`whitespace-nowrap ${getUsageTextColor(usagePercentage || 0)}`}>
            {tokenText}
          </span>
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80 p-3">
        <div className="flex items-start justify-between gap-3">
          <DropdownMenuLabel className="px-0 py-0 text-foreground">Conversation context</DropdownMenuLabel>
          <CopyButton content={conversationHistory} title="Copy conversation history" iconSize="sm" variant="ghost" />
        </div>
        <DropdownMenuSeparator className="my-3" />
        <div className="grid gap-2 text-xs">
          <div className="flex justify-between gap-3">
            <span className="text-muted-foreground">Tokens</span>
            <span className="font-medium text-foreground">{totalTokens.toLocaleString()}</span>
          </div>
          <div className="flex justify-between gap-3">
            <span className="text-muted-foreground">Context limit</span>
            <span className="font-medium text-foreground">{contextLimit ? contextLimit.toLocaleString() : 'Unknown'}</span>
          </div>
          <div className="flex justify-between gap-3">
            <span className="text-muted-foreground">Usage</span>
            <span className={`font-medium ${getUsageTextColor(usagePercentage || 0)}`}>{usagePercentage === null ? 'Unknown' : `${Math.round(usagePercentage)}%`}</span>
          </div>
          <div className="flex justify-between gap-3">
            <span className="text-muted-foreground">Messages</span>
            <span className="font-medium text-foreground">{messages?.length || 0}</span>
          </div>
          <div className="flex justify-between gap-3">
            <span className="text-muted-foreground">User / General Chat</span>
            <span className="font-medium text-foreground">{userMessages} / {assistantMessages}</span>
          </div>
          <div className="flex justify-between gap-3">
            <span className="text-muted-foreground">Model</span>
            <span className="max-w-44 truncate text-right font-medium text-foreground">{currentModel || 'Unknown'}</span>
          </div>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
