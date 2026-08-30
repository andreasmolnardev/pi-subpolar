import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Folder, AlertCircle } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { ProjectRowActions } from './ProjectRowActions'
import { hasProjectId, type Project } from '@/api/projects'

interface ProjectCardProps {
  project: Project
  onDelete: (id: number) => void
  isDeleting: boolean
  activityLabel?: string
}

function formatActivityLabel(timestamp: number): string {
  const now = Date.now()
  const diff = now - timestamp
  const seconds = Math.floor(diff / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)

  if (days > 0) {
    return days === 1 ? '1d ago' : `${days}d ago`
  }
  if (hours > 0) {
    return hours === 1 ? '1h ago' : `${hours}h ago`
  }
  if (minutes > 0) {
    return minutes === 1 ? '1m ago' : `${minutes}m ago`
  }
  return 'just now'
}

export function ProjectCard({
  project,
  onDelete,
  isDeleting,
  activityLabel,
}: ProjectCardProps) {
  const navigate = useNavigate()
  const [actionsOpen, setActionsOpen] = useState(false)

  const isReady = project.status === 'ready'
  const canNavigate = isReady && hasProjectId(project)

  const handleCardClick = () => {
    if (canNavigate && !actionsOpen) {
      navigate(`/projects/${project.id}`)
    }
  }

  const label = activityLabel || (project.lastAccessedAt ? formatActivityLabel(project.lastAccessedAt) : undefined)

  return (
    <div
      onClick={handleCardClick}
      className={`relative border rounded-xl overflow-hidden transition-all duration-200 w-full ${
        canNavigate ? 'cursor-pointer active:scale-[0.98] hover:border-blue-500/50 hover:bg-accent/50 hover:shadow-md' : 'cursor-default'
      } border-border bg-card`}
    >
      <div className="p-4">
        <div className="flex items-start gap-2 mb-2">
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <Folder className="w-4 h-4 text-muted-foreground shrink-0" />
            <h3 className="font-semibold text-base text-foreground truncate">
              {project.name}
            </h3>
            {!isReady && (
              <Badge variant="destructive" className="text-xs px-1.5 py-0">
                <AlertCircle className="w-3 h-3 mr-0.5" />
                Error
              </Badge>
            )}
          </div>

          <ProjectRowActions
            project={project}
            onDelete={onDelete}
            isDeleting={isDeleting}
            onActionsOpenChange={setActionsOpen}
          />
        </div>

        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span className="truncate flex-1">
            {project.directory || project.fullPath}
          </span>
          {label && (
            <span className="text-xs text-muted-foreground/70 shrink-0">
              {label}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}
