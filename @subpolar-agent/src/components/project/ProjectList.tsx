import { useState, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { deleteProject, hasProjectId, listProjects } from '@/api/projects'
import { DeleteDialog } from '@/components/ui/delete-dialog'
import { FolderOpen } from 'lucide-react'
import { ProjectCard } from './ProjectCard'
import { ProjectCardSkeleton } from './ProjectCardSkeleton'
import { GENERAL_CHAT_PROJECT_ID } from '@subpolar/shared/utils'

export function ProjectList() {
  const queryClient = useQueryClient()
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [projectToDelete, setProjectToDelete] = useState<number | null>(null)

  const {
    data: projects,
    isLoading,
    error,
  } = useQuery({
    queryKey: ['projects'],
    queryFn: listProjects,
  })

  const regularProjects = useMemo(
    () => projects?.filter((p) => hasProjectId(p) && p.id !== GENERAL_CHAT_PROJECT_ID) ?? null,
    [projects],
  )

  const projectForDelete = useMemo(() => {
    return projectToDelete ? projects?.find(p => p.id === projectToDelete) : null
  }, [projectToDelete, projects])

  const deleteMutation = useMutation({
    mutationFn: deleteProject,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] })
      setDeleteDialogOpen(false)
      setProjectToDelete(null)
    },
  })

  if (isLoading && !projects) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-2 gap-3 md:gap-4 w-full">
        {Array.from({ length: 6 }).map((_, i) => (
          <ProjectCardSkeleton key={i} />
        ))}
      </div>
    )
  }

  if (error) {
    return (
      <div className="text-center p-8 text-destructive">
        Failed to load projects:{' '}
        {error instanceof Error ? error.message : 'Unknown error'}
      </div>
    )
  }

  if (!regularProjects || regularProjects.length === 0) {
    return (
      <div className="text-center p-12">
        <FolderOpen className="w-12 h-12 mx-auto mb-4 text-zinc-600" />
        <p className="text-zinc-500">
          No projects yet. Create one to get started.
        </p>
      </div>
    )
  }

  return (
    <>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-2 gap-3 md:gap-4 w-full">
        {regularProjects.map((project) => (
          <ProjectCard
            key={project.id}
            project={project}
            onDelete={(id) => {
              setProjectToDelete(id)
              setDeleteDialogOpen(true)
            }}
            isDeleting={deleteMutation.isPending && projectToDelete === project.id}
          />
        ))}
      </div>

      <DeleteDialog
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        onConfirm={() => {
          if (projectToDelete) {
            deleteMutation.mutate(projectToDelete)
          }
        }}
        onCancel={() => {
          setDeleteDialogOpen(false)
          setProjectToDelete(null)
        }}
        title="Delete Project"
        description={
          projectForDelete
            ? `Are you sure you want to delete project "${projectForDelete.name}"? This will remove the project reference. Your files will not be affected.`
            : 'Are you sure you want to delete this project?'
        }
        itemName={projectForDelete?.name}
        isDeleting={deleteMutation.isPending}
      />
    </>
  )
}
