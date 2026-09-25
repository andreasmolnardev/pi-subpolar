import type { AutomationRecord, AutomationRun } from './automation.ts'
import { assertSafeIdentifier, type TaskRecord, type TaskRepository } from './task-control-plane.ts'

const SAFE_TEXT = /^[^\u0000-\u0008\u000b\u000c\u000e-\u001f]{1,12000}$/
const MAX_INPUT_BYTES = 128 * 1024

export type AutomationTaskIntent = {
  title: string
  prompt: string
  input?: Record<string, unknown>
  owner_id?: string
  project_id?: string
  agent_id?: string
  parent_run_id?: string
}

export type AutomationTaskCreator = Pick<TaskRepository, 'create'>

function assertText(value: unknown, name: string, maxLength = 12000): asserts value is string {
  if (typeof value !== 'string' || value.length > maxLength || !SAFE_TEXT.test(value)) throw new Error(`Invalid task ${name}`)
}

function assertJson(value: unknown, path = 'input', seen = new Set<object>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    if (typeof value === 'string' && !SAFE_TEXT.test(value)) throw new Error(`Invalid task ${path}`)
    return
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`Invalid task ${path}`)
    return
  }
  if (typeof value !== 'object' || seen.has(value)) throw new Error(`Invalid task ${path}`)
  seen.add(value)
  if (Array.isArray(value)) value.forEach((item, index) => assertJson(item, `${path}[${index}]`, seen))
  else Object.entries(value).forEach(([key, item]) => {
    if (!SAFE_TEXT.test(key)) throw new Error(`Invalid task ${path}`)
    assertJson(item, `${path}.${key}`, seen)
  })
  seen.delete(value)
}

export function validateAutomationTaskIntent(intent: AutomationTaskIntent): AutomationTaskIntent {
  if (!intent || typeof intent !== 'object' || Array.isArray(intent)) throw new Error('Invalid task intent')
  assertText(intent.title, 'title', 200)
  if (!intent.title.trim()) throw new Error('Invalid task title')
  assertText(intent.prompt, 'prompt')
  if (intent.owner_id !== undefined) assertSafeIdentifier(intent.owner_id, 'owner id')
  if (intent.project_id !== undefined) assertSafeIdentifier(intent.project_id, 'project id')
  if (intent.agent_id !== undefined) assertSafeIdentifier(intent.agent_id, 'agent id')
  if (intent.parent_run_id !== undefined) assertSafeIdentifier(intent.parent_run_id, 'parent run id')
  if (intent.input !== undefined) {
    if (!intent.input || typeof intent.input !== 'object' || Array.isArray(intent.input)) throw new Error('Invalid task input')
    assertJson(intent.input)
    try {
      if (new TextEncoder().encode(JSON.stringify(intent.input)).byteLength > MAX_INPUT_BYTES) throw new Error('Invalid task input')
    } catch {
      throw new Error('Invalid task input')
    }
  }
  return { ...intent, title: intent.title.trim() }
}

function assertMatches(name: string, supplied: string | undefined, expected: string | undefined): void {
  if (supplied !== undefined && supplied !== expected) throw new Error(`Task ${name} does not match automation`)
}

export async function handoffAutomationTask(
  repository: AutomationTaskCreator,
  definition: AutomationRecord,
  run: AutomationRun,
  intent: AutomationTaskIntent,
): Promise<TaskRecord> {
  const valid = validateAutomationTaskIntent(intent)
  assertSafeIdentifier(definition.id, 'automation id')
  assertSafeIdentifier(definition.owner_id, 'owner id')
  assertSafeIdentifier(run.id, 'parent run id')
  assertSafeIdentifier(run.owner_id, 'owner id')
  assertSafeIdentifier(run.automation_id, 'automation id')
  assertSafeIdentifier(definition.agent_id, 'agent id')
  if (definition.project_id) assertSafeIdentifier(definition.project_id, 'project id')
  if (run.owner_id !== definition.owner_id) throw new Error('Automation run owner does not match automation')
  if (run.automation_id !== definition.id) throw new Error('Automation run does not belong to automation')
  assertMatches('owner', valid.owner_id, definition.owner_id)
  assertMatches('project', valid.project_id, definition.project_id)
  assertMatches('agent', valid.agent_id, definition.agent_id)
  assertMatches('parent run', valid.parent_run_id, run.id)

  return repository.create({
    owner_id: definition.owner_id,
    ...(definition.project_id ? { project_id: definition.project_id } : {}),
    parent_run_id: run.id,
    agent_id: definition.agent_id,
    state: 'queued',
    kind: 'task',
    title: valid.title,
    input: { ...valid.input, prompt: valid.prompt },
  })
}
