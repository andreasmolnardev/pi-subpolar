import { hasProjectId, type Project } from '@/api/projects'
import { GENERAL_CHAT_PROJECT_ID } from '@subpolar/shared/utils'

export function getSidebarProjectRoute(value: string, projects: Project[] | undefined): string | null {
  if (value === String(GENERAL_CHAT_PROJECT_ID)) return '/home'
  const project = projects?.filter(hasProjectId).find((item) => String(item.id) === value)
  return project ? `/projects/${project.id}` : null
}
