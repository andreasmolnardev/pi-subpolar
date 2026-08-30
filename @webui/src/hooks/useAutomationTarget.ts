import { useQuery } from '@tanstack/react-query'
import { getProject } from '@/api/projects'
import { useWorkspaceMode } from '@/hooks/useWorkspaceMode'
import { isGeneralChatId, automationTargetFromProject } from '@/lib/automations/automation-target'
import type { AutomationTarget } from '@/lib/automations/automation-target'

export function useAutomationTarget(projectId: number | undefined): {
  automationTarget: AutomationTarget | undefined
  isLoading: boolean
  isError: boolean
} {
  const workspaceQuery = useWorkspaceMode(projectId)

  const projectQuery = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => getProject(projectId!),
    enabled: projectId !== undefined && projectId > 0,
  })

  if (isGeneralChatId(projectId)) {
    return {
      automationTarget: workspaceQuery.status && projectQuery.data ? automationTargetFromProject(projectQuery.data) : undefined,
      isLoading: projectQuery.isLoading,
      isError: projectQuery.isError,
    }
  }

  return {
    automationTarget: projectQuery.data ? automationTargetFromProject(projectQuery.data) : undefined,
    isLoading: projectQuery.isLoading,
    isError: projectQuery.isError,
  }
}
