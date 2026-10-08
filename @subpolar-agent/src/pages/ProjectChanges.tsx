import { useQuery } from '@tanstack/react-query'
import { useParams } from 'react-router-dom'
import { getProject } from '@/api/projects'
import { ChangesSurface } from '@/components/project/ChangesSurface'
import { Header } from '@/components/ui/header'
import { Button } from '@/components/ui/button'
import { Loader2 } from 'lucide-react'
import { getApiErrorMessage } from '@/api/git'

export function ProjectChanges() {
  const { id } = useParams<{ id: string }>()
  const projectId = Number(id) || 0
  const projectQuery = useQuery({ queryKey: ['project', projectId], queryFn: () => getProject(projectId), enabled: Boolean(projectId) })

  if (projectQuery.isLoading) return <div className="flex min-h-screen items-center justify-center"><Loader2 className="h-6 w-6 animate-spin" /></div>
  if (projectQuery.isError || !projectQuery.data) return <div className="flex min-h-screen flex-col items-center justify-center gap-3 p-6 text-center"><p>{projectQuery.isError ? getApiErrorMessage(projectQuery.error) : 'Project not found.'}</p><Button variant="outline" onClick={() => void projectQuery.refetch()}>Retry</Button></div>

  return <div className="flex h-dvh min-h-0 flex-col bg-background">
    <Header><Header.BackButton to={`/projects/${projectId}`} /><Header.Title>{projectQuery.data.name} Changes</Header.Title></Header>
    <ChangesSurface projectId={String(projectId)} />
  </div>
}
