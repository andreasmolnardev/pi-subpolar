import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cloneElement, isValidElement, type ReactElement, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { usePermissions, useQuestions } from '@/contexts/EventContext'
import { getQuestionText } from '@subpolar/shared/notifications'
import { notificationsApi } from '@/api/notifications'
import { Bell, HelpCircle } from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'

interface NotificationsSheetProps {
  isOpen: boolean
  onClose: () => void
  onOpen?: () => void
  trigger?: ReactNode
  side?: 'top' | 'bottom'
}

export function NotificationsSheet({ isOpen, onClose, onOpen, trigger, side = 'bottom' }: NotificationsSheetProps) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { data: inboxData, isLoading: isLoadingInbox } = useQuery({
    queryKey: ['notifications', 'inbox'],
    queryFn: notificationsApi.getInbox,
    refetchInterval: isOpen ? 15_000 : 60_000,
  })
  const resolveInboxItem = useMutation({
    mutationFn: notificationsApi.resolveInboxItem,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['notifications', 'inbox'] }),
  })
  const inboxItems = inboxData?.items ?? []
  const unresolvedItems = inboxItems.filter((item) => !item.resolved).slice(0, 8)
  const unreadCount = inboxItems.filter((item) => !item.resolved).length
  const notificationTrigger = isValidElement(trigger)
    ? cloneElement(trigger as ReactElement<{ children?: ReactNode; className?: string; 'aria-label'?: string }>, {
      className: `${(trigger as ReactElement<{ className?: string }>).props.className ?? ''} relative`,
      'aria-label': unreadCount > 0 ? `Open notifications, ${unreadCount} unread` : 'Open notifications',
      children: (
        <>
          {(trigger as ReactElement<{ children?: ReactNode }>).props.children}
          {unreadCount > 0 && <span aria-hidden="true" className="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold leading-none text-primary-foreground">{unreadCount > 99 ? '99+' : unreadCount}</span>}
        </>
      ),
    })
    : trigger
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

  const handleInboxItemClick = async (item: (typeof inboxItems)[number]) => {
    await resolveInboxItem.mutateAsync(item.id).catch(() => undefined)
    const path = item.deep_link?.path
    if (path) {
      const params = new URLSearchParams()
      if (path.endsWith('/automations') && item.deep_link?.automationId) {
        params.set('jobId', item.deep_link.automationId)
        params.set('automationTab', 'runs')
      }
      if (path.endsWith('/automations') && item.deep_link?.runId) params.set('runId', item.deep_link.runId)
      const query = params.toString()
      navigate(query ? `${path}?${query}` : path)
    }
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
      {notificationTrigger ? (
        <PopoverTrigger asChild>{notificationTrigger}</PopoverTrigger>
      ) : (
        <PopoverAnchor asChild>
          <span className="fixed right-4 top-14 h-px w-px" aria-hidden="true" />
        </PopoverAnchor>
      )}
      <PopoverContent
        aria-label="Notifications"
        side={side}
        align="end"
        sideOffset={8}
        className="w-[min(24rem,calc(100vw-2rem))] max-h-[min(70vh,34rem)] overflow-auto p-0"
      >
        <div className="border-b border-border px-4 py-3">
          <h2 className="text-lg font-semibold text-foreground">Notifications</h2>
        </div>
        <div className="flex flex-col gap-4 px-4 py-3">
          <div>
            <div className="mb-3 flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Bell className="h-5 w-5 text-primary" />
                <h3 className="font-semibold text-foreground">Inbox</h3>
              </div>
              {unresolvedItems.length > 0 && <span className="rounded-full bg-primary/15 px-2 py-0.5 text-xs font-medium text-primary">{unresolvedItems.length}</span>}
            </div>
            {isLoadingInbox ? (
              <div className="py-3 text-sm text-muted-foreground">Loading notifications…</div>
            ) : unresolvedItems.length === 0 ? (
              <div className="py-3 text-sm text-muted-foreground">No new notifications</div>
            ) : (
              <div className="flex flex-col gap-2">
                {unresolvedItems.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => void handleInboxItemClick(item)}
                    disabled={resolveInboxItem.isPending}
                    className="flex w-full flex-col items-start gap-1 rounded-lg border border-border p-3 text-left transition-colors hover:bg-accent"
                  >
                    <span className="w-full truncate font-medium text-foreground">{item.title}</span>
                    {item.body && <span className="line-clamp-2 w-full text-xs text-muted-foreground">{item.body}</span>}
                    <span className="text-xs text-muted-foreground">{formatDistanceToNow(item.created_at, { addSuffix: true })}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

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
