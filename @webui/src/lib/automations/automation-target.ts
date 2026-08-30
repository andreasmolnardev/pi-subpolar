import type { Project } from '@/api/projects'
import { GENERAL_CHAT_PROJECT_ID } from '@subpolar/shared/utils'

export interface AutomationTarget {
  projectId: number
  kind: 'project'
  name: string
  subtitle: string
  fullPath: string
  backHref: string
}

export function isGeneralChatId(id: number | undefined): boolean {
  return id === GENERAL_CHAT_PROJECT_ID
}

export function automationTargetFromProject(project: Project): AutomationTarget {
  return {
    projectId: project.id,
    kind: 'project',
    name: project.name || project.directory.split('/').pop() || project.directory,
    subtitle: project.directory,
    fullPath: project.fullPath,
    backHref: `/projects/${project.id}`,
  }
}
