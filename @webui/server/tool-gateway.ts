import type { Approval, PermissionOverride, ToolAdapter } from './tools.ts'

/**
 * The operation shared by Pi extensions and server routes.
 *
 * Authentication is deliberately not part of this object. The HTTP boundary
 * authenticates a request and constructs a context before calling the gateway.
 */
export interface ToolGatewayRequest {
  toolId: string
  input: unknown
}

/**
 * Execution metadata supplied by a trusted in-process caller.
 *
 * `waitForApproval` follows the existing `callTool` behavior: false (or
 * omitted) returns an approval-required result, while true waits for the
 * approval record to resolve.
 */
export interface ToolGatewayContext {
  userId: string
  agentName: string
  sessionId?: string
  cwd?: string
  callId?: string
  permissionOverride?: PermissionOverride
  waitForApproval?: boolean
  onApproval?: (approval: Approval) => void | Promise<void>
}

export interface ToolGatewayError {
  code: string
  message: string
}

export interface ToolGatewaySuccess<TResult = unknown> {
  ok: true
  toolId: string
  result: TResult
}

export interface ToolGatewayApprovalRequired {
  ok: false
  toolId: string
  approvalRequired: boolean
  approvalId: string
  message: string
}

export interface ToolGatewayFailure {
  ok: false
  toolId: string
  error: ToolGatewayError
}

export type ToolGatewayResult<TResult = unknown> =
  | ToolGatewaySuccess<TResult>
  | ToolGatewayApprovalRequired
  | ToolGatewayFailure

/** A complete executor, normally a thin adapter around the existing callTool. */
export type ToolGatewayExecutor = (
  request: ToolGatewayRequest,
  context: ToolGatewayContext,
) => Promise<ToolGatewayResult>

/** The next delegate exposed to a registered adapter wrapper. */
export type ToolGatewayDelegate = ToolGatewayExecutor

/**
 * An adapter handler may execute a request itself or delegate to the existing
 * executor. This allows tracing, compatibility adapters, and future adapter
 * implementations without making the gateway depend on PocketBase or HTTP.
 */
export type ToolGatewayAdapterHandler = (
  request: ToolGatewayRequest,
  context: ToolGatewayContext,
  next: ToolGatewayDelegate,
) => Promise<ToolGatewayResult>

/** Adapter names currently understood by tools.ts, plus names added by hosts. */
export type ToolGatewayAdapter = ToolAdapter | (string & {})

/**
 * Mutable only during trusted server setup. It is intentionally independent of
 * the PocketBase tool registry: callTool remains responsible for looking up a
 * tool, applying policy, creating approvals, auditing, and invoking its
 * configured adapter.
 */
export class ToolGatewayAdapterRegistry {
  private readonly handlers = new Map<string, ToolGatewayAdapterHandler>()

  constructor(initial?: Readonly<Record<string, ToolGatewayAdapterHandler>>) {
    for (const [adapter, handler] of Object.entries(initial ?? {})) this.register(adapter, handler)
  }

  register(adapter: ToolGatewayAdapter, handler: ToolGatewayAdapterHandler): () => void {
    const key = normalizeAdapter(adapter)
    if (this.handlers.has(key)) throw new Error(`Tool gateway adapter is already registered: ${key}`)
    this.handlers.set(key, handler)
    return () => {
      if (this.handlers.get(key) === handler) this.handlers.delete(key)
    }
  }

  get(adapter: ToolGatewayAdapter): ToolGatewayAdapterHandler | undefined {
    return this.handlers.get(normalizeAdapter(adapter))
  }

  has(adapter: ToolGatewayAdapter): boolean {
    return this.handlers.has(normalizeAdapter(adapter))
  }

  list(): string[] {
    return [...this.handlers.keys()].sort()
  }
}

export interface ToolGatewayOptions {
  executor: ToolGatewayExecutor
  adapters?: ToolGatewayAdapterRegistry
}

export interface ToolGateway {
  readonly adapters: ToolGatewayAdapterRegistry
  /** Execute through the configured base executor. */
  call(request: ToolGatewayRequest, context: ToolGatewayContext): Promise<ToolGatewayResult>
  /** Execute through a trusted adapter wrapper, if one is registered. */
  callWithAdapter(adapter: ToolGatewayAdapter, request: ToolGatewayRequest, context: ToolGatewayContext): Promise<ToolGatewayResult>
}

function normalizeAdapter(adapter: string): string {
  const key = adapter.trim()
  if (!key) throw new Error('Tool gateway adapter name must not be empty')
  return key
}

function failure(toolId: string, code: string, error: unknown): ToolGatewayFailure {
  return {
    ok: false,
    toolId,
    error: {
      code,
      message: error instanceof Error ? error.message : String(error),
    },
  }
}

/**
 * In-process gateway implementation. It has no server, fetch, or token
 * dependency, so the same instance can be used by Pi wrappers and HTTP route
 * handlers in the bridge process.
 */
export class InProcessToolGateway implements ToolGateway {
  readonly adapters: ToolGatewayAdapterRegistry
  private readonly executor: ToolGatewayExecutor

  constructor(options: ToolGatewayOptions) {
    this.executor = options.executor
    this.adapters = options.adapters ?? new ToolGatewayAdapterRegistry()
  }

  call(request: ToolGatewayRequest, context: ToolGatewayContext): Promise<ToolGatewayResult> {
    return this.executeBase(request, context)
  }

  async callWithAdapter(
    adapter: ToolGatewayAdapter,
    request: ToolGatewayRequest,
    context: ToolGatewayContext,
  ): Promise<ToolGatewayResult> {
    const key = normalizeAdapter(adapter)
    const handler = this.adapters.get(key)
    if (!handler) return failure(request.toolId, 'ADAPTER_NOT_REGISTERED', `Tool gateway adapter is not registered: ${key}`)

    const next: ToolGatewayDelegate = (nextRequest, nextContext) => this.executeBase(nextRequest, nextContext)
    try {
      return await handler(request, context, next)
    } catch (error) {
      return failure(request.toolId, 'TOOL_GATEWAY_FAILED', error)
    }
  }

  private async executeBase(request: ToolGatewayRequest, context: ToolGatewayContext): Promise<ToolGatewayResult> {
    try {
      return await this.executor(request, context)
    } catch (error) {
      return failure(request.toolId, 'TOOL_GATEWAY_FAILED', error)
    }
  }
}

export function createToolGateway(options: ToolGatewayOptions): ToolGateway {
  return new InProcessToolGateway(options)
}

/** The options shape accepted by the existing server-side callTool function. */
export interface ExistingCallToolOptions {
  cwd?: string
  callId?: string
  waitForApproval?: boolean
  onApproval?: (approval: Approval) => void | Promise<void>
}

/**
 * Structural type for tools.ts callTool. Keeping this type here avoids a
 * runtime import of tools.ts and leaves the gateway usable with a compatible
 * executor in tests or another host.
 */
export type ExistingCallTool<TClient> = (
  client: TClient,
  userId: string,
  agentName: string,
  toolId: string,
  input: unknown,
  sessionId?: string,
  override?: PermissionOverride,
  options?: ExistingCallToolOptions,
) => Promise<ToolGatewayResult>

/**
 * Adapt the current PocketBase-backed callTool implementation to the gateway.
 * The caller supplies the import and client, which keeps this module from
 * introducing a tools.ts -> tool-gateway.ts dependency or a circular import.
 */
export function createToolGatewayExecutor<TClient>(
  client: TClient,
  callTool: ExistingCallTool<TClient>,
): ToolGatewayExecutor {
  return (request, context) => callTool(
    client,
    context.userId,
    context.agentName,
    request.toolId,
    request.input,
    context.sessionId,
    context.permissionOverride,
    {
      cwd: context.cwd ?? process.cwd(),
      callId: context.callId ?? crypto.randomUUID(),
      waitForApproval: context.waitForApproval,
      onApproval: context.onApproval,
    },
  )
}

/** Build a gateway around the existing tools.ts executor without importing it. */
export function createToolGatewayFromCallTool<TClient>(
  client: TClient,
  callTool: ExistingCallTool<TClient>,
  options: Omit<ToolGatewayOptions, 'executor'> = {},
): ToolGateway {
  return createToolGateway({
    ...options,
    executor: createToolGatewayExecutor(client, callTool),
  })
}
