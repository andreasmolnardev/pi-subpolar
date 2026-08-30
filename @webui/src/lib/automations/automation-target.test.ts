import { describe, it, expect } from 'vitest'
import {
  isGeneralChatId,
  automationTargetFromProject,
} from './automation-target'

describe('isGeneralChatId', () => {
  it('returns true for repoId 0', () => {
    expect(isGeneralChatId(0)).toBe(true)
  })

  it('returns false for positive repoId', () => {
    expect(isGeneralChatId(5)).toBe(false)
  })

  it('returns false for undefined', () => {
    expect(isGeneralChatId(undefined)).toBe(false)
  })
})

describe('automationTargetFromProject', () => {
  it('returns correct automation target for a project', () => {
    const project = {
      id: 5,
      name: 'y',
      directory: 'y',
      fullPath: '/abs/y',
      status: 'ready' as const,
      createdAt: 0,
      updatedAt: 0,
    }

    const target = automationTargetFromProject(project)

    expect(target).toEqual({
      projectId: 5,
      kind: 'project',
      name: 'y',
      subtitle: 'y',
      fullPath: '/abs/y',
      backHref: '/projects/5',
    })
  })
})
