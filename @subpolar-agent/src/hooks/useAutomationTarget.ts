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
    const status = workspaceQuery.status
    return {
      automationTarget: status
        ? {
            projectId: projectId ?? 0,
            kind: 'project',
            name: 'General Chat',
            subtitle: status.relativePath || status.directory,
            fullPath: status.directory,
            backHref: `/projects/${projectId}`,
          }
        : undefined,
      isLoading: workspaceQuery.isLoading,
      isError: workspaceQuery.isError,
    }
  }

  return {
    automationTarget: projectQuery.data ? automationTargetFromProject(projectQuery.data) : undefined,
    isLoading: projectQuery.isLoading,
    isError: projectQuery.isError,
  }
}
