import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import type { ReactNode } from 'react'
import { usePermissions, useQuestions } from '@/contexts/EventContext'
import { getQuestionText } from '@subpolar/shared/notifications'
import { Bell, HelpCircle } from 'lucide-react'

interface NotificationsSheetProps {
  isOpen: boolean
  onClose: () => void
  onOpen?: () => void
  trigger?: ReactNode
}

export function NotificationsSheet({ isOpen, onClose, onOpen, trigger }: NotificationsSheetProps) {
  const {
    current: currentPermission,
    pendingCount: permissionCount,
    setShowDialog,
    navigateToCurrent: navigateToPermission,
  } = usePermissions()
  const {
    current: currentQuestion,
    pendingCount: questionCount,
    navigateToCurrent: navigateToQuestion,
  } = useQuestions()

  const handlePermissionClick = () => {
    navigateToPermission()
    setShowDialog(true)
    onClose()
  }

  const handleQuestionClick = () => {
    navigateToQuestion()
    onClose()
  }

  return (
    <Popover
      open={isOpen}
      onOpenChange={(open) => {
        if (open) onOpen?.()
        else onClose()
      }}
    >
      {trigger ? (
        <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      ) : (
        <PopoverAnchor asChild>
          <span className="fixed right-4 top-14 h-px w-px" aria-hidden="true" />
        </PopoverAnchor>
      )}
      <PopoverContent
        aria-label="Notifications"
        side="bottom"
        align="end"
        sideOffset={8}
        className="w-[min(24rem,calc(100vw-2rem))] max-h-[min(70vh,34rem)] overflow-auto p-0"
      >
        <div className="border-b border-border px-4 py-3">
          <h2 className="text-lg font-semibold text-foreground">Notifications</h2>
        </div>
        <div className="flex flex-col gap-4 px-4 py-3">
          <div>
            <div className="flex items-center gap-2 mb-3">
              <Bell className="w-5 h-5 text-orange-500" />
              <h3 className="font-semibold text-foreground">Pending permissions</h3>
            </div>
            {permissionCount === 0 ? (
              <div className="text-muted-foreground text-sm py-4">
                You're all caught up
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {currentPermission && (
                  <button
                    type="button"
                    onClick={handlePermissionClick}
                    className="flex flex-col items-start gap-1 p-3 rounded-lg border border-border hover:bg-accent transition-colors text-left w-full"
                  >
                    <span className="font-medium text-foreground capitalize">
                      {currentPermission.permission.replace(/_/g, ' ')}
                    </span>
                    <span className="text-xs text-muted-foreground truncate w-full">
                      {currentPermission.patterns?.[0] || 'View details'}
                    </span>
                  </button>
                )}
                {permissionCount > 1 && (
                  <div className="text-xs text-muted-foreground px-3">
                    +{permissionCount - 1} more
                  </div>
                )}
              </div>
            )}
          </div>

          <div>
            <div className="flex items-center gap-2 mb-3">
              <HelpCircle className="w-5 h-5 text-blue-500" />
              <h3 className="font-semibold text-foreground">Pending questions</h3>
            </div>
            {questionCount === 0 ? (
              <div className="text-muted-foreground text-sm py-4">
                You're all caught up
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {currentQuestion && (
                  <button
                    type="button"
                    onClick={handleQuestionClick}
                    className="flex flex-col items-start gap-1 p-3 rounded-lg border border-border hover:bg-accent transition-colors text-left w-full"
                  >
                    <span className="font-medium text-foreground">
                      {getQuestionText(currentQuestion) || 'Question'}
                    </span>
                    <span className="text-xs text-muted-foreground truncate w-full">
                      Tap to view
                    </span>
                  </button>
                )}
                {questionCount > 1 && (
                  <div className="text-xs text-muted-foreground px-3">
                    +{questionCount - 1} more
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
