import type PocketBase from 'pocketbase'
import {
  AutomationExecutionService,
  AutomationService,
  createCoreActionRegistry,
  type AgentExecutionPort,
  type AutomationExecution,
} from '../../../../packages/subpolar-automations/src/index.ts'
import {
  createPocketBaseAutomationRepositories,
} from '../../../../packages/subpolar-persistance-pocketbase/src/automations.ts'
import type {
  PocketBaseClientPort,
  PocketBaseCollectionPort,
  PocketBaseConditionalUpdatePort,
  PocketBaseStoredRecord,
} from '../../../../packages/subpolar-persistance-pocketbase/src/index.ts'
import { InboxRepository } from '../../persistence/inbox.ts'
import { fetchWithNetworkPolicy, readBoundedResponse } from '../../core/network-policy.ts'

export type FirstClassAutomationRuntimeOptions = {
  client: PocketBase
  ownerId: string
  agentExecutor: AgentExecutionPort
  assertAgentAccess: (ownerId: string, agentId: string) => Promise<void>
  executeToolAction: (input: {
    ownerId: string
    execution: AutomationExecution
    toolId: string
    input: unknown
    actionId: string
    signal?: AbortSignal
  }) => Promise<unknown>
  now?: () => Date
}

const updateLocks = new WeakMap<object, Map<string, Promise<void>>>()

async function withProcessLock<T>(client: object, key: string, work: () => Promise<T>): Promise<T> {
  let locks = updateLocks.get(client)
  if (!locks) { locks = new Map(); updateLocks.set(client, locks) }
  const previous = locks.get(key) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => { release = resolve })
  locks.set(key, current)
  await previous
  try { return await work() } finally {
    release()
    if (locks.get(key) === current) locks.delete(key)
  }
}

function pocketBasePort(client: PocketBase): PocketBaseClientPort {
  return {
    collection(name): PocketBaseCollectionPort {
      const collection = client.collection(name)
      return {
        async list() { return await collection.getFullList() as PocketBaseStoredRecord[] },
        async get(id) { return await collection.getOne(id).catch(() => undefined) as PocketBaseStoredRecord | undefined },
        async create(data) { return await collection.create(data) as PocketBaseStoredRecord },
        async update(id, data) { return await collection.update(id, data).catch(() => undefined) as PocketBaseStoredRecord | undefined },
      }
    },
  }
}

/**
 * The development bridge runs a single scheduler process. This adapter provides
 * process-local conditional updates for that deployment and deliberately reports
 * that claims are not safe across multiple bridge processes. Production multi-
 * process deployments must inject a database-backed conditional update port.
 */
function processConditionalUpdate(client: PocketBase): PocketBaseConditionalUpdatePort {
  return {
    multiProcessSafe: false,
    async update(collection, id, expected, data) {
      return withProcessLock(client, `automation-cas:${id}`, async () => {
        const current = await collection.get(id)
        if (!current || Object.entries(expected).some(([key, value]) => current[key] !== value)) return undefined
        return collection.update(id, data)
      })
    },
  }
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

export function createFirstClassAutomationRuntime(options: FirstClassAutomationRuntimeOptions) {
  const now = options.now ?? (() => new Date())
  const repositories = createPocketBaseAutomationRepositories({
    client: pocketBasePort(options.client),
    now,
    conditionalUpdate: processConditionalUpdate(options.client),
  })
  const actions = createCoreActionRegistry({
    notification: {
      async execute({ ownerId, execution, resolvedInput }) {
        if (ownerId !== options.ownerId) throw new Error('Automation owner mismatch')
        const input = object(resolvedInput)
        const result = await new InboxRepository(options.client).upsert({
          owner_id: ownerId,
          kind: 'automation_result',
          reference_id: execution.id,
          title: typeof input.title === 'string' ? input.title : 'Automation completed',
          body: typeof input.body === 'string' ? input.body : undefined,
          ...(execution.projectId ? { project_id: execution.projectId } : {}),
          deep_link: { path: '/automations' },
          metadata: { automationId: execution.automationId, executionId: execution.id, runId: execution.runId ?? '' },
        })
        return { notificationId: result.id }
      },
    },
    webhook: {
      async execute({ ownerId, resolvedInput, signal }) {
        if (ownerId !== options.ownerId) throw new Error('Automation owner mismatch')
        const input = object(resolvedInput)
        if (typeof input.url !== 'string' || typeof input.body !== 'string') throw new Error('Invalid automation webhook action')
        const endpoint = new URL(input.url)
        if (endpoint.protocol !== 'https:') throw new Error('Automation webhooks require HTTPS')
        if (typeof input.credentialRef === 'string') {
          throw Object.assign(new Error('Webhook credentials are not configured for this action'), { code: 'AUTOMATION_CREDENTIAL_UNAVAILABLE' })
        }
        let response: Response
        try {
          response = await fetchWithNetworkPolicy(endpoint, {
            method: input.method === 'PUT' ? 'PUT' : 'POST',
            headers: { 'content-type': 'application/json' },
            body: input.body,
            signal,
          }, { allowedHosts: [endpoint.hostname], maxRedirects: 0, timeoutMs: 15_000, maxResponseBytes: 64 * 1024 })
        } catch (error) {
          throw Object.assign(error instanceof Error ? error : new Error('Webhook delivery failed'), { outcomeUnknown: true })
        }
        const responseBody = await readBoundedResponse(response, 64 * 1024).catch(() => '')
        if (!response.ok) throw Object.assign(new Error(`Webhook returned HTTP ${response.status}`), {
          code: 'AUTOMATION_WEBHOOK_FAILED',
          // A remote endpoint may commit before returning an error response.
          // Fail closed instead of replaying an effect with unknown semantics.
          outcomeUnknown: true,
        })
        return { status: response.status, body: responseBody.slice(0, 4000) }
      },
    },
    tool: {
      async execute({ ownerId, execution, action, resolvedInput, signal }) {
        const input = object(resolvedInput)
        if (typeof input.toolId !== 'string') throw new Error('Invalid automation tool action')
        return options.executeToolAction({ ownerId, execution, toolId: input.toolId, input: input.input, actionId: action.id, signal })
      },
    },
  })
  const service = new AutomationService({
    repository: repositories.repository,
    agentAccess: { assertCanUse: options.assertAgentAccess },
    clock: { now },
  })
  const executions = new AutomationExecutionService({
    repository: repositories.repository,
    executions: repositories.executionStore,
    agentAccess: { assertCanUse: options.assertAgentAccess },
    agentExecutor: options.agentExecutor,
    actions: actions.toMap(),
    ids: { next: (prefix) => `${prefix}:${crypto.randomUUID()}` },
    clock: { now },
  })

  return {
    definitions: service,
    executions,
    repositories,
    async execution(ownerId: string, executionId: string) {
      const record = await executions.get(ownerId, executionId)
      return record ? { ...record, actions: await repositories.executionStore.listActions(ownerId, executionId) } : undefined
    },
    async history(ownerId: string, automationId: string, limit?: number) {
      const records = await executions.list(ownerId, automationId, limit)
      return Promise.all(records.map(async (record) => ({
        ...record,
        actions: await repositories.executionStore.listActions(ownerId, record.id),
      })))
    },
    async deliver(ownerId: string, automationId: string, trigger: import('../../../../packages/subpolar-automations/src/types.ts').TriggerInput, occurrenceKey: string, signal?: AbortSignal, background = false) {
      return executions.deliver({ ownerId, automationId, trigger, occurrenceKey, signal, background })
    },
  }
}
