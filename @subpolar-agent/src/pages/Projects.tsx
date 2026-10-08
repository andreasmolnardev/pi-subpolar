import { ProjectList } from '@/components/project/ProjectList'
import { Header } from '@/components/ui/header'
import { PendingActionsGroup } from '@/components/notifications/PendingActionsGroup'

export function Projects() {
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
        </Header.Actions>
      </Header>
      <div className="container mx-auto flex-1 pt-2 px-2 min-h-0 overflow-auto pb-[calc(env(safe-area-inset-bottom)+60px)] sm:pb-0">
        <ProjectList />
      </div>
    </div>
  )
}
