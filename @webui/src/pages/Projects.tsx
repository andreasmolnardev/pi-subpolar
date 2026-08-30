import { useState } from 'react'
import { ProjectList } from '@/components/project/ProjectList'
import { ProjectDialog } from '@/components/project/ProjectDialog'
import { Header } from '@/components/ui/header'
import { Button } from '@/components/ui/button'
import { Plus } from 'lucide-react'
import { PendingActionsGroup } from '@/components/notifications/PendingActionsGroup'
import { useSidebarAction } from '@/hooks/useSidebarAction'

export function Projects() {
  const [createDialogOpen, setCreateDialogOpen] = useState(false)

  useSidebarAction('new-repo', () => {
    setCreateDialogOpen(true)
  })

  return (
    <div className="h-dvh max-h-dvh overflow-hidden bg-gradient-to-br from-background via-background to-background flex flex-col">
      <Header>
        <div className="flex items-center gap-3">
          <Header.Title logo>Subpolar</Header.Title>
        </div>
        <Header.Actions>
          <div className="flex items-center gap-1">
            <PendingActionsGroup />
          </div>
          <Button onClick={() => setCreateDialogOpen(true)} size="sm">
            <Plus className="w-4 h-4 mr-1" />
            Project
          </Button>
        </Header.Actions>
      </Header>
      <div className="container mx-auto flex-1 pt-2 px-2 min-h-0 overflow-auto pb-[calc(env(safe-area-inset-bottom)+60px)] sm:pb-0">
        <ProjectList />
      </div>
      <ProjectDialog open={createDialogOpen} onOpenChange={setCreateDialogOpen} />
    </div>
  )
}
