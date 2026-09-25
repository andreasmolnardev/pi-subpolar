import { describe, expect, it, vi } from 'vitest'
import { handoffAutomationTask, type AutomationTaskCreator } from '../application/automations/automation-task.ts'
import type { AutomationRecord, AutomationRun } from '../application/automations/automation.ts'
import type { TaskRecord } from '../application/task-control-plane.ts'

const definition: AutomationRecord = {
  id: 'automation-a', owner_id: 'owner-a', name: 'Nightly', prompt: 'run', agent_id: 'agent-a', project_id: 'project-a',
  timezone: 'UTC', schedule: { kind: 'once', at: 1 }, state: 'active', created_at: 1, updated_at: 1,
}
const run: AutomationRun = { id: 'run-a', automation_id: 'automation-a', owner_id: 'owner-a', trigger_key: 'manual', state: 'running', attempt: 1, created_at: 1 }

function creator(): { repository: AutomationTaskCreator; create: ReturnType<typeof vi.fn> } {
  const create = vi.fn(async (input): Promise<TaskRecord> => ({ ...input, id: 'task-a', created_at: 1, updated_at: 1 } as TaskRecord))
  return { repository: { create }, create }
}

describe('automation task handoff', () => {
  it('creates one normal queued task with automation ownership and lineage', async () => {
    const { repository, create } = creator()
    const task = await handoffAutomationTask(repository, definition, run, { title: 'Build', prompt: 'Build it', input: { priority: 'high' } })
    expect(task).toMatchObject({ owner_id: 'owner-a', project_id: 'project-a', parent_run_id: 'run-a', agent_id: 'agent-a', state: 'queued', kind: 'task', title: 'Build', input: { priority: 'high', prompt: 'Build it' } })
    expect(create).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['owner_id', { owner_id: 'owner-b' }],
    ['project_id', { project_id: 'project-b' }],
    ['agent_id', { agent_id: 'agent-b' }],
    ['parent_run_id', { parent_run_id: 'run-b' }],
  ])('rejects %s mismatch', async (_name, mismatch) => {
    const { repository, create } = creator()
    await expect(handoffAutomationTask(repository, definition, run, { title: 'Build', prompt: 'Build it', ...mismatch })).rejects.toThrow('match')
    expect(create).not.toHaveBeenCalled()
  })

  it('rejects a run belonging to another automation', async () => {
    const { repository, create } = creator()
    await expect(handoffAutomationTask(repository, definition, { ...run, automation_id: 'automation-b' }, { title: 'Build', prompt: 'Build it' })).rejects.toThrow('belong')
    expect(create).not.toHaveBeenCalled()
  })

  it('rejects unsafe or invalid task input', async () => {
    const { repository, create } = creator()
    await expect(handoffAutomationTask(repository, definition, run, { title: 'Build', prompt: 'ok\u0000' })).rejects.toThrow('Invalid task prompt')
    await expect(handoffAutomationTask(repository, definition, run, { title: 'Build', prompt: 'ok', input: { value: Number.NaN } })).rejects.toThrow('Invalid task input.value')
    expect(create).not.toHaveBeenCalled()
  })

  it('does not execute, lease, or mutate the automation records', async () => {
    const { repository } = creator()
    const beforeDefinition = structuredClone(definition)
    const beforeRun = structuredClone(run)
    await handoffAutomationTask(repository, definition, run, { title: 'Build', prompt: 'Build it' })
    expect(definition).toEqual(beforeDefinition)
    expect(run).toEqual(beforeRun)
  })
})
