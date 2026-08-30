import { useNavigate } from 'react-router-dom'
import { Loader2, ExternalLink, FolderOpen, Settings, Trash2, MoreVertical } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { hasProjectId, type Project } from '@/api/projects'

interface ProjectRowActionsProps {
  project: Project
  onDelete: (id: number) => void
  isDeleting: boolean
  onActionsOpenChange?: (isOpen: boolean) => void
  onSwitchConfig?: () => void
}

export function ProjectRowActions({
  project,
  onDelete,
  isDeleting,
  onActionsOpenChange,
  onSwitchConfig,
}: ProjectRowActionsProps) {
  const navigate = useNavigate()
  const canUseProjectId = hasProjectId(project)

  return (
    <DropdownMenu onOpenChange={onActionsOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label="Project actions"
          size="sm"
          variant="ghost"
          className="h-8 w-8 p-0"
          onClick={(e) => e.stopPropagation()}
        >
          <MoreVertical className="w-4 h-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="z-[200]"
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <DropdownMenuItem
          onClick={() => navigate(`/projects/${project.id}`)}
          disabled={!canUseProjectId}
        >
          <ExternalLink className="w-4 h-4 mr-2" />
          Open
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => navigate(`/projects/${project.id}?dialog=files`)}
          disabled={!canUseProjectId}
        >
          <FolderOpen className="w-4 h-4 mr-2" />
          File Browser
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => onSwitchConfig?.()}
        >
          <Settings className="w-4 h-4 mr-2" />
          Switch Config
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => {
            if (canUseProjectId) onDelete(project.id)
          }}
          disabled={isDeleting || !canUseProjectId}
          className="text-destructive"
        >
          {isDeleting ? (
            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
          ) : (
            <Trash2 className="w-4 h-4 mr-2" />
          )}
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
