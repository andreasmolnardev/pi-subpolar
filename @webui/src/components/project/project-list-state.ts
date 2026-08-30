import type { Project } from '@/api/projects'

export interface ProjectViewModel extends Project {
  activityTimestamp: number
}
