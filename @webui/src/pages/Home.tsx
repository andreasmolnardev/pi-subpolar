import { useState } from 'react'
import { useLocation } from 'react-router-dom'
import { ChatInputBar } from '@/components/chat/ChatInputBar'
import { Button } from '@/components/ui/button'
import { useSidebarAction } from '@/hooks/useSidebarAction'
import { Puzzle } from 'lucide-react'

const MOTIVATIONAL_MESSAGES = [
  'Ready to dive in',
  'Explore the iceberg - no matter how deep',
  'Beneath the surface lies the unknown. Brave enough to explore?',
  'The deeper you go, the greater the discovery.',
  'Submerge into the unknown and emerge with wisdom.',
  'The greatest adventures start where the map ends.',
  'Exploring the depths of data for you.',
  'Submerge into data, emerge with clarity.',
]

export function Home() {
  const location = useLocation()
  const [messageIndex] = useState(() => Math.floor(Math.random() * MOTIVATIONAL_MESSAGES.length))
  const selectedAgent = new URLSearchParams(location.search).get('agent') || '__default__'

  useSidebarAction('new-session', () => {})

  return (
    <div className="h-dvh max-h-dvh overflow-hidden bg-gradient-to-br from-background via-background to-background flex flex-col">     <div className="flex-1 flex flex-col items-center justify-center px-4 pb-12 sm:pb-16 overflow-y-auto">
        <div className="flex flex-col items-center gap-6 max-w-3xl w-full">
          <div className="h-12 flex items-center justify-center">
            <p
              key={messageIndex}
              className="mb-4 text-2xl sm:text-2xl text-muted-foreground text-center animate-in fade-in slide-in-from-bottom-2 duration-500"
            >
              {MOTIVATIONAL_MESSAGES[messageIndex]}
            </p>
          </div>

          <ChatInputBar defaultAgent={selectedAgent} />

          <div className="pt-4">
            <Button variant="outline" size="sm" disabled className="opacity-50 cursor-not-allowed gap-2">
              <Puzzle className="h-4 w-4" />
              Widgets available soon
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
