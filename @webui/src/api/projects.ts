import { fetchWrapper, fetchWrapperVoid } from './fetchWrapper'
import { API_BASE_URL } from '@/config'
import type { GeneralChatStatus, GeneralChatInitRequest } from '@subpolar/shared/types'
import { GENERAL_CHAT_PROJECT_ID } from '@subpolar/shared/utils'

export interface Project {
  id: number | null
  name: string
  directory: string
  fullPath: string
  piConfigName?: string
  agentNames?: string[]
  hasAgentOverride?: boolean
  status: 'ready' | 'error'
  createdAt: number
  updatedAt: number
  lastAccessedAt?: number
  isGeneralChat?: boolean
}

export function hasProjectId(project: Project): project is Project & { id: number } {
  return typeof project.id === 'number' && Number.isFinite(project.id)
}

export async function listProjects(): Promise<Project[]> {
  const res = await fetchWrapper<{ projects: Project[] }>(`${API_BASE_URL}/api/projects`)
  return res.projects
}

export async function getProject(id: number): Promise<Project> {
  if (id === GENERAL_CHAT_PROJECT_ID) {
    const res = await fetchWrapper<{ directory: string }>(`${API_BASE_URL}/api/projects/general-chat`)
    return {
      id: GENERAL_CHAT_PROJECT_ID,
      name: 'General Chat',
      directory: res.directory,
      fullPath: res.directory,
      status: 'ready',
      createdAt: 0,
      updatedAt: 0,
      isGeneralChat: true,
    }
  }

  const res = await fetchWrapper<{ project: Project }>(`${API_BASE_URL}/api/projects/${id}`)
  return res.project
}

export async function createProject(data: {
  name: string
  directory?: string
  piConfigName?: string
  agentNames?: string[]
}): Promise<Project> {
  return fetchWrapper(`${API_BASE_URL}/api/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
}

export async function updateProject(
  id: number,
  data: { name?: string; directory?: string; piConfigName?: string; agentNames?: string[] },
): Promise<Project> {
  return fetchWrapper(`${API_BASE_URL}/api/projects/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
}

export async function getDefaultProjectDirectory(projectName: string, userId?: string): Promise<string> {
  const res = await fetchWrapper<{ directory: string }>(`${API_BASE_URL}/api/projects/default-directory`, {
    params: { projectName, userId },
  })
  return res.directory
}

export async function listProjectDirectories(path?: string, userId?: string): Promise<{ currentPath: string; directories: Array<{ name: string; path: string }> }> {
  return fetchWrapper(`${API_BASE_URL}/api/projects/directories`, {
    params: { path, userId },
  })
}

export type MentionContextItem = { type: 'file' | 'skill'; value: string }

export async function listProjectMentions(directory: string, query: string): Promise<{
  files: string[]
  skills: Array<{ name: string; description?: string }>
}> {
  return fetchWrapper(`${API_BASE_URL}/api/projects/mentions`, {
    params: { directory, query },
  })
}

export async function loadMentionContext(directory: string, mentions: MentionContextItem[]): Promise<string> {
  const res = await fetchWrapper<{ context: string }>(`${API_BASE_URL}/api/projects/mention-context`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ directory, mentions }),
  })
  return res.context
}

export async function deleteProject(id: number): Promise<void> {
  return fetchWrapperVoid(`${API_BASE_URL}/api/projects/${id}`, {
    method: 'DELETE',
  })
}

export async function touchProjectActivity(id: number): Promise<void> {
  return fetchWrapperVoid(`${API_BASE_URL}/api/projects/${id}/access`, {
    method: 'POST',
  })
}

export async function switchProjectConfig(id: number, configName: string): Promise<void> {
  return fetchWrapperVoid(`${API_BASE_URL}/api/projects/${id}/config/switch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ configName }),
  })
}

export async function getGeneralChatStatus(projectId: number): Promise<GeneralChatStatus> {
  return fetchWrapper(`${API_BASE_URL}/api/projects/${projectId}/general-chat`, {
    method: 'GET',
  })
}

export async function initializeGeneralChat(
  projectId: number,
  options?: GeneralChatInitRequest,
): Promise<void> {
  return fetchWrapperVoid(`${API_BASE_URL}/api/projects/${projectId}/general-chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(options ?? {}),
  })
}
