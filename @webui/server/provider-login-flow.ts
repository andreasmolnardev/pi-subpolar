import { randomUUID } from 'node:crypto'
import type {
  AuthEvent,
  AuthInteraction,
  AuthPrompt,
  AuthType,
  Credential,
} from '@earendil-works/pi-ai'
import type { ModelRuntime } from '@earendil-works/pi-coding-agent'

/** A provider instance may have its own account while using a shared Pi provider implementation. */
export interface ProviderInstanceMapping {
  runtimeProviderId: string
  accountContext?: unknown
}

export type ProviderInstanceRegistry =
  | ReadonlyMap<string, ProviderInstanceMapping>
  | Readonly<Record<string, ProviderInstanceMapping>>

export type ProviderInstanceResolver = (
  providerInstanceId: string,
  ownerId: string,
) => ProviderInstanceMapping | undefined | Promise<ProviderInstanceMapping | undefined>

/** The part of ModelRuntime needed by this controller, convenient for test doubles. */
export type ProviderLoginRuntime = Pick<ModelRuntime, 'login'>

export interface ProviderRuntimeFactoryContext {
  flowId: string
  ownerId: string
  providerInstanceId: string
  runtimeProviderId: string
  /** Optional non-secret label used when provisioning a new provider account. */
  displayName?: string
  accountContext?: unknown
  type: AuthType
}

export type ProviderRuntimeFactory = (
  context: ProviderRuntimeFactoryContext,
) => ProviderLoginRuntime | Promise<ProviderLoginRuntime>

/** Server-only sink for the credential returned by a completed login flow. */
export type ProviderLoginCredentialSink = (
  context: ProviderRuntimeFactoryContext,
  credential: Credential,
) => Promise<void>

/** Auth prompts are persisted and sent to clients without the provider's signal. */
export type ProviderLoginFlowPrompt =
  | { type: 'text'; message: string; placeholder?: string }
  | { type: 'secret'; message: string; placeholder?: string }
  | {
      type: 'select'
      message: string
      options: readonly { id: string; label: string; description?: string }[]
    }
  | { type: 'manual_code'; message: string; placeholder?: string }

export type ProviderLoginFlowEvent =
  | {
      sequence: number
      timestamp: number
      type: 'prompt'
      promptId: string
      prompt: ProviderLoginFlowPrompt
    }
  | ({ sequence: number; timestamp: number } & AuthEvent)

export type ProviderLoginFlowPhase = 'pending' | 'completed' | 'failed' | 'cancelled' | 'expired'

export interface ProviderLoginFlowResult {
  flowId: string
  providerInstanceId: string
  runtimeProviderId: string
  type: AuthType
  credentialType: AuthType
  completedAt: number
}

export interface ProviderLoginFlowErrorInfo {
  code: 'LOGIN_FAILED'
  message: 'Provider login failed.'
}

export interface ProviderLoginFlowStatus {
  flowId: string
  providerInstanceId: string
  runtimeProviderId: string
  type: AuthType
  phase: ProviderLoginFlowPhase
  createdAt: number
  updatedAt: number
  expiresAt: number
  currentPrompt?: {
    promptId: string
    prompt: ProviderLoginFlowPrompt
  }
  result?: ProviderLoginFlowResult
  error?: ProviderLoginFlowErrorInfo
}

export interface ProviderLoginFlowEvents {
  flowId: string
  events: readonly ProviderLoginFlowEvent[]
  /** Pass this value as `after` on the next poll. */
  nextSequence: number
}

export interface StoredProviderLoginFlow {
  /** This is server-owned data; callers should not expose ownerId to clients. */
  ownerId: string
  flowId: string
  providerInstanceId: string
  runtimeProviderId: string
  type: AuthType
  phase: ProviderLoginFlowPhase
  createdAt: number
  updatedAt: number
  expiresAt: number
  nextSequence: number
  events: ProviderLoginFlowEvent[]
  currentPrompt?: {
    promptId: string
    prompt: ProviderLoginFlowPrompt
  }
  result?: ProviderLoginFlowResult
  error?: ProviderLoginFlowErrorInfo
}

/**
 * Durable flow metadata storage. It intentionally has no method for storing prompt
 * answers or credentials. `delete` is optional so a small database adapter can start
 * with only get/set; TTL cleanup still occurs on every controller access.
 */
export interface ProviderLoginFlowStorage {
  get(flowId: string): Promise<StoredProviderLoginFlow | undefined>
  set(flow: StoredProviderLoginFlow): Promise<void>
  delete?(flowId: string): Promise<void>
}

export interface CreateProviderLoginFlowControllerOptions {
  runtimeFactory: ProviderRuntimeFactory
  /** Persist credentials without exposing them in flow state or HTTP responses. */
  credentialSink?: ProviderLoginCredentialSink
  storage?: ProviderLoginFlowStorage
  providerInstances?: ProviderInstanceRegistry
  resolveProviderInstance?: ProviderInstanceResolver
  /** Absolute lifetime of a flow. It is not extended by polling. */
  ttlMs?: number
  /** Maximum number of replayable events retained per flow. */
  maxEvents?: number
  now?: () => number
  flowIdFactory?: () => string
}

export interface StartProviderLoginFlowInput {
  ownerId: string
  providerInstanceId: string
  type: AuthType
  /** Optional non-secret label used when provisioning a new provider account. */
  displayName?: string
}

export interface ProviderLoginFlowReference {
  ownerId: string
  flowId: string
}

export interface GetProviderLoginFlowEventsInput extends ProviderLoginFlowReference {
  /** Return events with sequence greater than this cursor. Defaults to zero. */
  after?: number
  /** Defaults to 100. */
  limit?: number
}

export interface RespondToProviderLoginPromptInput extends ProviderLoginFlowReference {
  promptId: string
  /** For select prompts this must be one of the advertised option ids. */
  value: string
}

export class ProviderLoginFlowError extends Error {
  readonly code:
    | 'INVALID_INPUT'
    | 'FLOW_NOT_FOUND'
    | 'FLOW_EXPIRED'
    | 'FLOW_NOT_ACTIVE'
    | 'PROMPT_NOT_FOUND'
    | 'PROMPT_MISMATCH'
    | 'INVALID_PROMPT_RESPONSE'
    | 'FLOW_CANCELLED'

  constructor(
    code:
      | 'INVALID_INPUT'
      | 'FLOW_NOT_FOUND'
      | 'FLOW_EXPIRED'
      | 'FLOW_NOT_ACTIVE'
      | 'PROMPT_NOT_FOUND'
      | 'PROMPT_MISMATCH'
      | 'INVALID_PROMPT_RESPONSE'
      | 'FLOW_CANCELLED',
    message: string,
  ) {
    super(message)
    this.name = 'ProviderLoginFlowError'
    this.code = code
  }
}

type DeferredPrompt = {
  promptId: string
  settled: boolean
  resolve: (value: string) => void
  reject: (reason: unknown) => void
  cleanup: () => void
}

type ActiveFlow = {
  record: StoredProviderLoginFlow
  displayName?: string
  abortController: AbortController
  currentPrompt?: DeferredPrompt
  timer: ReturnType<typeof setTimeout>
  writes: Promise<void>
}

const DEFAULT_TTL_MS = 10 * 60 * 1000
const DEFAULT_EVENT_LIMIT = 100
const DEFAULT_MAX_EVENTS = 1000

function isAuthType(value: unknown): value is AuthType {
  return value === 'api_key' || value === 'oauth'
}

function requiredString(name: string, value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ProviderLoginFlowError('INVALID_INPUT', `${name} is required`)
  }
  return value
}

function integerOption(name: string, value: unknown, fallback: number, minimum: number, maximum?: number): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || (maximum !== undefined && value > maximum)) {
    throw new ProviderLoginFlowError('INVALID_INPUT', `${name} must be an integer in the supported range`)
  }
  return value
}

function publicPrompt(prompt: AuthPrompt): ProviderLoginFlowPrompt {
  const { signal, ...withoutSignal } = prompt
  void signal
  return withoutSignal
}

function copyStoredFlow(flow: StoredProviderLoginFlow): StoredProviderLoginFlow {
  return {
    ...flow,
    events: flow.events.map((event) => structuredClone(event)),
    ...(flow.currentPrompt
      ? { currentPrompt: structuredClone(flow.currentPrompt) }
      : {}),
    ...(flow.result ? { result: structuredClone(flow.result) } : {}),
    ...(flow.error ? { error: structuredClone(flow.error) } : {}),
  }
}

function publicStatus(record: StoredProviderLoginFlow): ProviderLoginFlowStatus {
  return {
    flowId: record.flowId,
    providerInstanceId: record.providerInstanceId,
    runtimeProviderId: record.runtimeProviderId,
    type: record.type,
    phase: record.phase,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    expiresAt: record.expiresAt,
    ...(record.currentPrompt ? { currentPrompt: structuredClone(record.currentPrompt) } : {}),
    ...(record.result ? { result: structuredClone(record.result) } : {}),
    ...(record.error ? { error: structuredClone(record.error) } : {}),
  }
}

function safeFailure(error: unknown): ProviderLoginFlowErrorInfo {
  // Provider errors can contain response bodies, bearer tokens, or API keys. Do
  // not copy provider-controlled messages into the durable/public flow record.
  void error
  return { code: 'LOGIN_FAILED', message: 'Provider login failed.' }
}

/**
 * In-memory storage suitable for a single bridge process and unit tests. Supply a
 * database-backed implementation to retain replayable flow metadata across bridge
 * requests or deployments.
 */
export class InMemoryProviderLoginFlowStorage implements ProviderLoginFlowStorage {
  private readonly flows = new Map<string, StoredProviderLoginFlow>()

  async get(flowId: string): Promise<StoredProviderLoginFlow | undefined> {
    const flow = this.flows.get(flowId)
    return flow ? copyStoredFlow(flow) : undefined
  }

  async set(flow: StoredProviderLoginFlow): Promise<void> {
    this.flows.set(flow.flowId, copyStoredFlow(flow))
  }

  async delete(flowId: string): Promise<void> {
    this.flows.delete(flowId)
  }
}

/**
 * Server-side controller for authenticated, resumable Pi provider login flows.
 *
 * Every public method requires the authenticated owner's id. A wrong owner is
 * deliberately reported as FLOW_NOT_FOUND, so flow ids cannot be used to probe
 * another user's activity. Prompt answers and credentials never enter storage,
 * events, status, or result objects.
 *
 * Resumable means a client can reconnect and replay events by flow id/cursor while
 * this server process owns the login operation. `ModelRuntime.login` itself is not
 * serializable; a process restart requires the route layer to start a new flow.
 *
 * Route shape (all request bodies are already parsed/validated by the route layer):
 *
 *   const started = await controller.start({ ownerId: user.id, providerInstanceId, type })
 *   const events = await controller.getEvents({ ownerId: user.id, flowId, after })
 *   const status = await controller.respond({ ownerId: user.id, flowId, promptId, value })
 *   const status = await controller.cancel({ ownerId: user.id, flowId })
 *   await controller.getStatus({ ownerId: user.id, flowId })
 *   await controller.getResult({ ownerId: user.id, flowId })
 */
export class ProviderLoginFlowController {
  private readonly storage: ProviderLoginFlowStorage
  private readonly runtimeFactory: ProviderRuntimeFactory
  private readonly credentialSink?: ProviderLoginCredentialSink
  private readonly providerInstances?: ProviderInstanceRegistry
  private readonly resolveProviderInstance?: ProviderInstanceResolver
  private readonly ttlMs: number
  private readonly maxEvents: number
  private readonly now: () => number
  private readonly flowIdFactory: () => string
  private readonly active = new Map<string, ActiveFlow>()

  constructor(options: CreateProviderLoginFlowControllerOptions) {
    if (typeof options.runtimeFactory !== 'function') {
      throw new ProviderLoginFlowError('INVALID_INPUT', 'runtimeFactory is required')
    }

    this.runtimeFactory = options.runtimeFactory
    this.credentialSink = options.credentialSink
    this.storage = options.storage ?? new InMemoryProviderLoginFlowStorage()
    this.providerInstances = options.providerInstances
    this.resolveProviderInstance = options.resolveProviderInstance
    this.ttlMs = integerOption('ttlMs', options.ttlMs, DEFAULT_TTL_MS, 1)
    this.maxEvents = integerOption('maxEvents', options.maxEvents, DEFAULT_MAX_EVENTS, 1)
    this.now = options.now ?? Date.now
    this.flowIdFactory = options.flowIdFactory ?? randomUUID
  }

  /** Start immediately and return a flow id; login continues in the background. */
  async start(input: StartProviderLoginFlowInput): Promise<ProviderLoginFlowStatus> {
    const ownerId = requiredString('ownerId', input.ownerId)
    const providerInstanceId = requiredString('providerInstanceId', input.providerInstanceId)
    const displayName = input.displayName === undefined ? undefined : requiredString('displayName', input.displayName)
    if (!isAuthType(input.type)) {
      throw new ProviderLoginFlowError('INVALID_INPUT', 'type must be api_key or oauth')
    }

    const mapping = await this.resolveInstance(providerInstanceId, ownerId)
    const createdAt = this.now()
    const flowId = this.newFlowId()
    const record: StoredProviderLoginFlow = {
      ownerId,
      flowId,
      providerInstanceId,
      runtimeProviderId: mapping.runtimeProviderId,
      type: input.type,
      phase: 'pending',
      createdAt,
      updatedAt: createdAt,
      expiresAt: createdAt + this.ttlMs,
      nextSequence: 0,
      events: [],
    }
    await this.storage.set(copyStoredFlow(record))

    const abortController = new AbortController()
    const timer = setTimeout(() => {
      void this.expire(this.active.get(flowId)).catch(() => undefined)
    }, this.ttlMs)
    const active: ActiveFlow = {
      record,
      ...(displayName === undefined ? {} : { displayName }),
      abortController,
      timer,
      writes: Promise.resolve(),
    }
    this.active.set(flowId, active)
    void this.run(active, mapping).catch(() => undefined)
    return publicStatus(record)
  }

  /** Replay notifications/prompts after a cursor; prompt answers are never replayed. */
  async getEvents(input: GetProviderLoginFlowEventsInput): Promise<ProviderLoginFlowEvents> {
    const record = await this.loadOwned(input)
    await this.expireIfNeeded(record)
    const after = integerOption('after', input.after, 0, 0)
    const limit = integerOption('limit', input.limit, DEFAULT_EVENT_LIMIT, 1, this.maxEvents)
    return {
      flowId: record.flowId,
      events: record.events.filter((event) => event.sequence > after).slice(0, limit),
      nextSequence: record.nextSequence,
    }
  }

  /** Resolve exactly the currently displayed prompt. The value is not returned or stored. */
  async respond(input: RespondToProviderLoginPromptInput): Promise<ProviderLoginFlowStatus> {
    const record = await this.loadOwned(input)
    await this.expireIfNeeded(record)
    const active = this.active.get(record.flowId)
    if (record.phase === 'expired') {
      throw new ProviderLoginFlowError('FLOW_EXPIRED', 'Login flow expired')
    }
    if (!active || record.phase !== 'pending' || !active.currentPrompt) {
      throw new ProviderLoginFlowError('FLOW_NOT_ACTIVE', 'The login flow has no pending prompt')
    }
    const prompt = active.currentPrompt
    if (prompt.promptId !== requiredString('promptId', input.promptId)) {
      throw new ProviderLoginFlowError('PROMPT_MISMATCH', 'The prompt is no longer current')
    }
    const value = requiredString('value', input.value)
    const currentPrompt = record.currentPrompt?.prompt
    if (currentPrompt?.type === 'select' && !currentPrompt.options.some((option) => option.id === value)) {
      throw new ProviderLoginFlowError('INVALID_PROMPT_RESPONSE', 'value must be one of the select option ids')
    }

    record.currentPrompt = undefined
    record.updatedAt = this.now()
    active.currentPrompt = undefined
    await this.persist(active)
    prompt.settled = true
    prompt.cleanup()
    prompt.resolve(value)
    return publicStatus(record)
  }

  /** Cancel is idempotent for an already terminal flow and aborts provider I/O. */
  async cancel(input: ProviderLoginFlowReference): Promise<ProviderLoginFlowStatus> {
    const record = await this.loadOwned(input)
    await this.expireIfNeeded(record)
    const active = this.active.get(record.flowId)
    if (record.phase !== 'pending' || !active) return publicStatus(record)

    record.phase = 'cancelled'
    record.updatedAt = this.now()
    record.currentPrompt = undefined
    const currentPrompt = active.currentPrompt
    if (currentPrompt) {
      currentPrompt.settled = true
      currentPrompt.cleanup()
      currentPrompt.reject(new ProviderLoginFlowError('FLOW_CANCELLED', 'The login flow was cancelled'))
    }
    active.currentPrompt = undefined
    active.abortController.abort()
    await this.persist(active)
    this.stopActive(active)
    return publicStatus(record)
  }

  async getStatus(input: ProviderLoginFlowReference): Promise<ProviderLoginFlowStatus> {
    const record = await this.loadOwned(input)
    await this.expireIfNeeded(record)
    return publicStatus(record)
  }

  /** Returns metadata only after successful login; it never returns Credential. */
  async getResult(input: ProviderLoginFlowReference): Promise<ProviderLoginFlowResult | undefined> {
    const record = await this.loadOwned(input)
    await this.expireIfNeeded(record)
    return record.phase === 'completed' && record.result ? structuredClone(record.result) : undefined
  }

  /** Short aliases for route handlers that prefer status/result naming. */
  status(input: ProviderLoginFlowReference): Promise<ProviderLoginFlowStatus> {
    return this.getStatus(input)
  }

  result(input: ProviderLoginFlowReference): Promise<ProviderLoginFlowResult | undefined> {
    return this.getResult(input)
  }

  private async resolveInstance(providerInstanceId: string, ownerId: string): Promise<ProviderInstanceMapping> {
    const resolved = this.resolveProviderInstance
      ? await this.resolveProviderInstance(providerInstanceId, ownerId)
      : this.providerInstances
        ? this.providerInstances instanceof Map
          ? this.providerInstances.get(providerInstanceId)
          : (this.providerInstances as Readonly<Record<string, ProviderInstanceMapping>>)[providerInstanceId]
        : { runtimeProviderId: providerInstanceId }
    if (!resolved || typeof resolved.runtimeProviderId !== 'string' || resolved.runtimeProviderId.trim() === '') {
      throw new ProviderLoginFlowError('INVALID_INPUT', `Unknown provider instance: ${providerInstanceId}`)
    }
    return resolved
  }

  private newFlowId(): string {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const flowId = requiredString('flowId', this.flowIdFactory())
      if (!this.active.has(flowId)) return flowId
    }
    throw new ProviderLoginFlowError('INVALID_INPUT', 'Could not allocate a unique flow id')
  }

  private async loadOwned(input: ProviderLoginFlowReference): Promise<StoredProviderLoginFlow> {
    const ownerId = requiredString('ownerId', input.ownerId)
    const flowId = requiredString('flowId', input.flowId)
    const active = this.active.get(flowId)
    const record = active?.record ?? await this.storage.get(flowId)
    if (!record || record.ownerId !== ownerId) {
      throw new ProviderLoginFlowError('FLOW_NOT_FOUND', 'Login flow not found')
    }
    return record
  }

  private async expireIfNeeded(record: StoredProviderLoginFlow): Promise<void> {
    if (record.phase === 'pending' && this.now() >= record.expiresAt) {
      await this.expire(this.active.get(record.flowId), record)
      return
    }
    if (record.phase !== 'pending' && record.phase !== 'expired' && this.now() >= record.expiresAt) {
      await this.removeExpired(record.flowId)
      throw new ProviderLoginFlowError('FLOW_NOT_FOUND', 'Login flow not found')
    }
  }

  private async expire(active: ActiveFlow | undefined, fallback?: StoredProviderLoginFlow): Promise<void> {
    const record = active?.record ?? fallback
    if (!record || record.phase !== 'pending') return
    record.phase = 'expired'
    record.updatedAt = this.now()
    record.currentPrompt = undefined
    const currentPrompt = active?.currentPrompt
    if (currentPrompt) {
      currentPrompt.settled = true
      currentPrompt.cleanup()
      currentPrompt.reject(new ProviderLoginFlowError('FLOW_EXPIRED', 'Login flow expired'))
    }
    if (active) {
      active.currentPrompt = undefined
      active.abortController.abort()
      await this.persist(active)
      this.stopActive(active)
    } else {
      await this.storage.set(copyStoredFlow(record))
    }
  }

  private async removeExpired(flowId: string): Promise<void> {
    const active = this.active.get(flowId)
    if (active) this.stopActive(active)
    if (this.storage.delete) await this.storage.delete(flowId)
  }

  private async run(active: ActiveFlow, mapping: ProviderInstanceMapping): Promise<void> {
    const { record } = active
    try {
      const runtime = await this.runtimeFactory({
        flowId: record.flowId,
        ownerId: record.ownerId,
        providerInstanceId: record.providerInstanceId,
        runtimeProviderId: record.runtimeProviderId,
        ...(active.displayName === undefined ? {} : { displayName: active.displayName }),
        ...(mapping.accountContext === undefined ? {} : { accountContext: mapping.accountContext }),
        type: record.type,
      })
      const interaction: AuthInteraction = {
        signal: active.abortController.signal,
        prompt: (prompt) => this.prompt(active, prompt),
        notify: (event) => this.notify(active, event),
      }
      const credential = await runtime.login(record.runtimeProviderId, record.type, interaction)
      if (record.phase !== 'pending') return
      if (!credential || !isAuthType(credential.type)) throw new Error('Provider returned an invalid credential')
      if (this.credentialSink) {
        await this.credentialSink({
          flowId: record.flowId,
          ownerId: record.ownerId,
          providerInstanceId: record.providerInstanceId,
          runtimeProviderId: record.runtimeProviderId,
          ...(active.displayName === undefined ? {} : { displayName: active.displayName }),
          type: record.type,
        }, credential)
      }
      const completedAt = this.now()
      record.phase = 'completed'
      record.updatedAt = completedAt
      record.currentPrompt = undefined
      record.result = {
        flowId: record.flowId,
        providerInstanceId: record.providerInstanceId,
        runtimeProviderId: record.runtimeProviderId,
        type: record.type,
        credentialType: credential.type,
        completedAt,
      }
      await this.persist(active)
    } catch (error) {
      if (record.phase === 'pending') {
        const currentPrompt = active.currentPrompt
        if (currentPrompt) {
          currentPrompt.settled = true
          currentPrompt.cleanup()
          currentPrompt.reject(error)
          active.currentPrompt = undefined
        }
        record.phase = 'failed'
        record.updatedAt = this.now()
        record.currentPrompt = undefined
        record.error = safeFailure(error)
        await this.persist(active)
      }
    } finally {
      if (record.phase !== 'pending') this.stopActive(active)
    }
  }

  private async prompt(active: ActiveFlow, input: AuthPrompt): Promise<string> {
    const { record } = active
    if (record.phase !== 'pending' || active.abortController.signal.aborted) {
      throw new ProviderLoginFlowError('FLOW_CANCELLED', 'The login flow is no longer active')
    }
    if (active.currentPrompt) {
      throw new ProviderLoginFlowError('FLOW_NOT_ACTIVE', 'The provider already has a pending prompt')
    }

    const promptId = `${record.flowId}:${record.nextSequence + 1}`
    const prompt = publicPrompt(input)
    let resolvePrompt!: (value: string) => void
    let rejectPrompt!: (reason: unknown) => void
    const answer = new Promise<string>((resolve, reject) => {
      resolvePrompt = resolve
      rejectPrompt = reject
    })
    const deferred: DeferredPrompt = {
      promptId,
      settled: false,
      resolve: resolvePrompt,
      reject: rejectPrompt,
      cleanup: () => undefined,
    }
    const abort = (reason: unknown) => {
      if (deferred.settled || active.currentPrompt !== deferred) return
      deferred.settled = true
      active.currentPrompt = undefined
      record.currentPrompt = undefined
      deferred.cleanup()
      deferred.reject(reason)
    }
    const listeners: Array<[AbortSignal, () => void]> = []
    const addAbortListener = (signal: AbortSignal | undefined, reason: unknown) => {
      if (deferred.settled || !signal) return
      const listener = () => abort(reason)
      if (signal.aborted) listener()
      else {
        signal.addEventListener('abort', listener, { once: true })
        listeners.push([signal, listener])
      }
    }
    deferred.cleanup = () => {
      for (const [signal, listener] of listeners) signal.removeEventListener('abort', listener)
    }
    active.currentPrompt = deferred
    record.currentPrompt = { promptId, prompt }
    this.appendEvent(active, { type: 'prompt', promptId, prompt })
    await this.persist(active)
    addAbortListener(active.abortController.signal, new ProviderLoginFlowError('FLOW_CANCELLED', 'The login flow was cancelled'))
    addAbortListener(input.signal, new ProviderLoginFlowError('PROMPT_NOT_FOUND', 'The provider cancelled the prompt'))
    return answer
  }

  private notify(active: ActiveFlow, event: AuthEvent): void {
    if (active.record.phase !== 'pending') return
    this.appendEvent(active, event)
    void this.persist(active).catch(() => undefined)
  }

  private appendEvent(active: ActiveFlow, event: AuthEvent | { type: 'prompt'; promptId: string; prompt: ProviderLoginFlowPrompt }): void {
    const record = active.record
    record.nextSequence += 1
    record.events.push({ sequence: record.nextSequence, timestamp: this.now(), ...event } as ProviderLoginFlowEvent)
    if (record.events.length > this.maxEvents) record.events.splice(0, record.events.length - this.maxEvents)
    record.updatedAt = this.now()
  }

  private persist(active: ActiveFlow): Promise<void> {
    const snapshot = copyStoredFlow(active.record)
    active.writes = active.writes.catch(() => undefined).then(() => this.storage.set(snapshot))
    return active.writes
  }

  private stopActive(active: ActiveFlow): void {
    clearTimeout(active.timer)
    if (this.active.get(active.record.flowId) === active) this.active.delete(active.record.flowId)
  }
}

export function createProviderLoginFlowController(
  options: CreateProviderLoginFlowControllerOptions,
): ProviderLoginFlowController {
  return new ProviderLoginFlowController(options)
}

export function createInMemoryProviderLoginFlowStorage(): InMemoryProviderLoginFlowStorage {
  return new InMemoryProviderLoginFlowStorage()
}
