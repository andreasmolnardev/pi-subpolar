import { createStatelessSubpolarRuntime, type ToolGateway as CoreToolGateway } from '../../../../packages/subpolar-core/src/index.ts'
import {
  createPocketBaseAdapter,
  createPocketBaseEventReplayPort,
  createPocketBaseRunStore,
  type PocketBaseClientPort,
  type PocketBaseCollectionPort,
} from '../../../../packages/subpolar-persistance-pocketbase/src/index.ts'
import type {
  Principal,
  RuntimeContext,
  RuntimeExecution,
  StatelessRunResult,
  StatelessRunRequest,
} from '../../../../packages/subpolar-contracts/src/index.ts'


export type PocketBaseSdkClient = {
  collection: (name: string) => {
    getFullList: (options?: Record<string, unknown>) => Promise<unknown[]>
    getOne: (id: string) => Promise<unknown>
    create: (data: Record<string, unknown>) => Promise<unknown>
    update: (id: string, data: Record<string, unknown>) => Promise<unknown>
  }
}

export type StatelessWebUiRunInput = {
  ownerId: string
  sessionId: string
  runId: string
  requestId: string
  prompt: string
  signal?: AbortSignal
  metadata?: Record<string, string>
}

export type StatelessWebUiRuntimeOptions = {
  client: PocketBaseSdkClient
  ownerId: string
  resolveContext: (request: StatelessRunRequest) => Promise<RuntimeContext>
  execute: (execution: RuntimeExecution) => Promise<unknown>
  gateway: CoreToolGateway
  onEvent?: (event: Parameters<NonNullable<import('../../../../packages/subpolar-contracts/src/index.ts').RunEventSink>>[0]) => void | Promise<void>
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && ((error as { status?: unknown }).status === 404 || (error as { statusCode?: unknown }).statusCode === 404))
}

function createClientPort(client: PocketBaseSdkClient): PocketBaseClientPort {
  return {
    collection(name): PocketBaseCollectionPort {
      const collection = client.collection(name)
      return {
        async list() {
          return (await collection.getFullList()) as Array<{ id: string; [key: string]: unknown }>
        },
        async get(id) {
          try {
            return await collection.getOne(id) as { id: string; [key: string]: unknown }
          } catch (error) {
            if (isNotFound(error)) return undefined
            throw error
          }
        },
        async create(data) {
          return await collection.create(data) as { id: string; [key: string]: unknown }
        },
        async update(id, data) {
          try {
            return await collection.update(id, data) as { id: string; [key: string]: unknown }
          } catch (error) {
            if (isNotFound(error)) return undefined
            throw error
          }
        },
      }
    },
  }
}


/**
 * Compose a request-scoped runtime. The only retained object is the immutable
 * composition callback; run stores and event replay are owner-bound to the
 * authenticated PocketBase client and are recreated for each invocation.
 */
export function createStatelessWebUiRuntime(options: StatelessWebUiRuntimeOptions) {
  if (!options.ownerId.trim()) throw new Error('Runtime owner is required')
  const adapter = createPocketBaseAdapter({
    client: createClientPort(options.client),
    eventReplay: true,
    collections: {
      runs: 'subpolar_runs',
      runEvents: 'subpolar_run_events',
    },
  })
  const runStore = createPocketBaseRunStore(adapter, options.ownerId)
  const eventReplay = createPocketBaseEventReplayPort(adapter, options.ownerId)

  return {
    async runPrompt(input: StatelessWebUiRunInput): Promise<StatelessRunResult> {
      if (input.ownerId !== options.ownerId) throw new Error('Runtime owner mismatch')
      if (!input.sessionId.trim()) throw new Error('Runtime session is required')
      const request: StatelessRunRequest = {
        runId: input.runId,
        requestId: input.requestId,
        prompt: input.prompt,
        sessionId: input.sessionId,
        principal: { id: options.ownerId, kind: 'user' } satisfies Principal,
        signal: input.signal,
      }
      const resolveContext: typeof options.resolveContext = async (contextRequest) => {
        const context = await options.resolveContext(contextRequest)
        if (context.principal.id !== options.ownerId || context.principal.kind !== 'user'
          || context.sessionId !== input.sessionId || context.requestId !== input.requestId
          || (context.runId !== undefined && context.runId !== input.runId)) {
          throw new Error('Resolved runtime tenant or run mismatch')
        }
        return context
      }
      const runtime = createStatelessSubpolarRuntime({
        context: { load: resolveContext },
        gateway: options.gateway,
        runStore,
        eventReplayPort: eventReplay,
        eventSink: options.onEvent,
        execute: options.execute,
      })
      return runtime.run(request)
    },
  }
}
