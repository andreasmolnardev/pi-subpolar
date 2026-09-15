import type PocketBase from 'pocketbase'
import type { RecordModel } from 'pocketbase'
import type {
  ProviderLoginFlowEvent,
  ProviderLoginFlowErrorInfo,
  ProviderLoginFlowPrompt,
  ProviderLoginFlowResult,
  ProviderLoginFlowStorage,
  StoredProviderLoginFlow,
} from './provider-login-flow'

/** The durable, non-secret provider login flow collection. */
export const PROVIDER_LOGIN_FLOWS_COLLECTION = 'provider_login_flows'

export type ProviderLoginFlowSchema = {
  name: typeof PROVIDER_LOGIN_FLOWS_COLLECTION
  fields: readonly Record<string, unknown>[]
  indexes: readonly string[]
}

/**
 * This collection contains replayable login UX state only. It deliberately has
 * no field for a prompt answer, Credential, account context, or provider error.
 */
export const PROVIDER_LOGIN_FLOW_SCHEMA: ProviderLoginFlowSchema = {
  name: PROVIDER_LOGIN_FLOWS_COLLECTION,
  fields: [
    { name: 'user_id', type: 'text', required: true },
    { name: 'flow_id', type: 'text', required: true },
    { name: 'provider_instance_id', type: 'text', required: true },
    { name: 'runtime_provider_id', type: 'text', required: true },
    { name: 'type', type: 'select', required: true, values: ['api_key', 'oauth'], maxSelect: 1 },
    { name: 'phase', type: 'select', required: true, values: ['pending', 'completed', 'failed', 'cancelled', 'expired'], maxSelect: 1 },
    { name: 'created_at', type: 'number', required: true },
    { name: 'updated_at', type: 'number', required: true },
    { name: 'expires_at', type: 'number', required: true },
    { name: 'next_sequence', type: 'number', required: true },
    { name: 'events', type: 'json', required: true },
    { name: 'current_prompt', type: 'json' },
    { name: 'result', type: 'json' },
    { name: 'error', type: 'json' },
  ],
  indexes: [
    'CREATE UNIQUE INDEX idx_provider_login_flows_flow ON provider_login_flows (flow_id)',
    'CREATE INDEX idx_provider_login_flows_owner_phase ON provider_login_flows (user_id, phase, expires_at)',
  ],
}

export interface PocketBaseProviderLoginFlowStorageOptions {
  client: PocketBase
  now?: () => number
  /** Maximum number of replayable events accepted from a stored record. */
  maxEvents?: number
}

type FlowRecord = RecordModel & Record<string, unknown>
type FlowCollection = {
  getFirstListItem: (filter: string) => Promise<FlowRecord>
  create: (data: Record<string, unknown>) => Promise<FlowRecord>
  update: (id: string, data: Record<string, unknown>) => Promise<FlowRecord>
  delete: (id: string) => Promise<boolean>
}
type CollectionManager = {
  getOne: (idOrName: string) => Promise<FlowRecord>
  create: (data: Record<string, unknown>) => Promise<FlowRecord>
  update: (id: string, data: Record<string, unknown>) => Promise<FlowRecord>
}

const DEFAULT_MAX_EVENTS = 1000
const MAX_TEXT_LENGTH = 4_000
const MAX_ID_LENGTH = 500
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g

type JsonRecord = Record<string, unknown>

function collection(client: PocketBase): FlowCollection {
  return client.collection(PROVIDER_LOGIN_FLOWS_COLLECTION) as unknown as FlowCollection
}

function collectionManager(client: PocketBase): CollectionManager {
  return client.collections as unknown as CollectionManager
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'status' in error && (error as { status?: unknown }).status === 404
}

async function firstOrNull(operation: () => Promise<FlowRecord>): Promise<FlowRecord | null> {
  try {
    return await operation()
  } catch (error) {
    if (isNotFound(error)) return null
    throw error
  }
}

function escapeFilterValue(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
}

function equals(field: string, value: string): string {
  return `${field} = "${escapeFilterValue(value)}"`
}

function flowFilter(flowId: string): string {
  return equals('flow_id', flowId)
}

function ownedFlowFilter(ownerId: string, flowId: string): string {
  return `${equals('user_id', ownerId)} && ${flowFilter(flowId)}`
}

function text(value: unknown, field: string, maxLength = MAX_TEXT_LENGTH): string {
  if (typeof value !== 'string') throw new Error(`PocketBase provider login flow ${field} is invalid`)
  const normalized = value.replace(CONTROL_CHARS, '').trim()
  if (!normalized || normalized.length > maxLength) throw new Error(`PocketBase provider login flow ${field} is invalid`)
  return normalized
}

function optionalText(value: unknown, field: string, maxLength = MAX_TEXT_LENGTH): string | undefined {
  if (value === undefined || value === null) return undefined
  return text(value, field, maxLength)
}

function finiteNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`PocketBase provider login flow ${field} is invalid`)
  return value
}

function integer(value: unknown, field: string, minimum = 0): number {
  const result = finiteNumber(value, field)
  if (!Number.isInteger(result) || result < minimum) throw new Error(`PocketBase provider login flow ${field} is invalid`)
  return result
}

function authType(value: unknown): StoredProviderLoginFlow['type'] {
  if (value !== 'api_key' && value !== 'oauth') throw new Error('PocketBase provider login flow type is invalid')
  return value
}

function phase(value: unknown): StoredProviderLoginFlow['phase'] {
  if (value !== 'pending' && value !== 'completed' && value !== 'failed' && value !== 'cancelled' && value !== 'expired') {
    throw new Error('PocketBase provider login flow phase is invalid')
  }
  return value
}

function recordValue(value: unknown, field: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`PocketBase provider login flow ${field} is invalid`)
  return value as JsonRecord
}

function sanitizePrompt(value: unknown): ProviderLoginFlowPrompt {
  const input = recordValue(value, 'prompt')
  const type = input.type
  const message = text(input.message, 'prompt.message')
  if (type === 'text' || type === 'secret' || type === 'manual_code') {
    const placeholder = optionalText(input.placeholder, 'prompt.placeholder')
    return { type, message, ...(placeholder === undefined ? {} : { placeholder }) }
  }
  if (type === 'select') {
    if (!Array.isArray(input.options) || input.options.length === 0 || input.options.length > 100) {
      throw new Error('PocketBase provider login flow prompt.options is invalid')
    }
    const options = input.options.map((item) => {
      const option = recordValue(item, 'prompt option')
      const id = text(option.id, 'prompt option id', 500)
      const label = text(option.label, 'prompt option label')
      const description = optionalText(option.description, 'prompt option description')
      return { id, label, ...(description === undefined ? {} : { description }) }
    })
    return { type, message, options }
  }
  throw new Error('PocketBase provider login flow prompt type is invalid')
}

function sanitizeCurrentPrompt(value: unknown): StoredProviderLoginFlow['currentPrompt'] | undefined {
  if (value === undefined || value === null) return undefined
  const input = recordValue(value, 'current_prompt')
  return {
    promptId: text(input.promptId, 'current_prompt.promptId', MAX_ID_LENGTH),
    prompt: sanitizePrompt(input.prompt),
  }
}

function sanitizeEvent(value: unknown): ProviderLoginFlowEvent {
  const input = recordValue(value, 'event')
  const sequence = integer(input.sequence, 'event.sequence', 1)
  const timestamp = finiteNumber(input.timestamp, 'event.timestamp')
  const type = input.type

  if (type === 'prompt') {
    return {
      sequence,
      timestamp,
      type,
      promptId: text(input.promptId, 'event.promptId', MAX_ID_LENGTH),
      prompt: sanitizePrompt(input.prompt),
    }
  }
  if (type === 'info' || type === 'progress') {
    return { sequence, timestamp, type, message: text(input.message, `event.${type}.message`) }
  }
  if (type === 'auth_url') {
    const instructions = optionalText(input.instructions, 'event.auth_url.instructions')
    return {
      sequence,
      timestamp,
      type,
      url: text(input.url, 'event.auth_url.url'),
      ...(instructions === undefined ? {} : { instructions }),
    }
  }
  if (type === 'device_code') {
    const intervalSeconds = input.intervalSeconds === undefined ? undefined : finiteNumber(input.intervalSeconds, 'event.device_code.intervalSeconds')
    const expiresInSeconds = input.expiresInSeconds === undefined ? undefined : finiteNumber(input.expiresInSeconds, 'event.device_code.expiresInSeconds')
    return {
      sequence,
      timestamp,
      type,
      userCode: text(input.userCode, 'event.device_code.userCode', 500),
      verificationUri: text(input.verificationUri, 'event.device_code.verificationUri'),
      ...(intervalSeconds === undefined ? {} : { intervalSeconds }),
      ...(expiresInSeconds === undefined ? {} : { expiresInSeconds }),
    }
  }
  throw new Error('PocketBase provider login flow event type is invalid')
}

function sanitizeEvents(value: unknown, maxEvents: number): ProviderLoginFlowEvent[] {
  if (!Array.isArray(value) || value.length > Math.max(maxEvents, 1) * 2) {
    throw new Error('PocketBase provider login flow events are invalid')
  }
  const events = value.map(sanitizeEvent)
  return events.length <= maxEvents ? events : events.slice(-maxEvents)
}

function sanitizeResult(value: unknown, flowId: string): ProviderLoginFlowResult | undefined {
  if (value === undefined || value === null) return undefined
  const input = recordValue(value, 'result')
  const resultFlowId = text(input.flowId, 'result.flowId', MAX_ID_LENGTH)
  if (resultFlowId !== flowId) throw new Error('PocketBase provider login flow result is invalid')
  const resultType = authType(input.type)
  const credentialType = authType(input.credentialType)
  return {
    flowId: resultFlowId,
    providerInstanceId: text(input.providerInstanceId, 'result.providerInstanceId', MAX_ID_LENGTH),
    runtimeProviderId: text(input.runtimeProviderId, 'result.runtimeProviderId', MAX_ID_LENGTH),
    type: resultType,
    credentialType,
    completedAt: finiteNumber(input.completedAt, 'result.completedAt'),
  }
}

function sanitizeError(value: unknown): ProviderLoginFlowErrorInfo | undefined {
  if (value === undefined || value === null) return undefined
  const input = recordValue(value, 'error')
  // Never retain a provider-controlled message. This is the only public failure DTO.
  if (input.code !== 'LOGIN_FAILED' || input.message !== 'Provider login failed.') return undefined
  return { code: 'LOGIN_FAILED', message: 'Provider login failed.' }
}

function sanitizeFlow(value: unknown, maxEvents: number): StoredProviderLoginFlow {
  const input = recordValue(value, 'record')
  const flowId = text(input.flowId, 'flowId', MAX_ID_LENGTH)
  const flow: StoredProviderLoginFlow = {
    ownerId: text(input.ownerId, 'ownerId', MAX_ID_LENGTH),
    flowId,
    providerInstanceId: text(input.providerInstanceId, 'providerInstanceId', MAX_ID_LENGTH),
    runtimeProviderId: text(input.runtimeProviderId, 'runtimeProviderId', MAX_ID_LENGTH),
    type: authType(input.type),
    phase: phase(input.phase),
    createdAt: finiteNumber(input.createdAt, 'createdAt'),
    updatedAt: finiteNumber(input.updatedAt, 'updatedAt'),
    expiresAt: finiteNumber(input.expiresAt, 'expiresAt'),
    nextSequence: integer(input.nextSequence, 'nextSequence'),
    events: sanitizeEvents(input.events, maxEvents),
  }

  const currentPrompt = sanitizeCurrentPrompt(input.currentPrompt)
  const result = sanitizeResult(input.result, flowId)
  const error = sanitizeError(input.error)
  if (currentPrompt) flow.currentPrompt = currentPrompt
  if (result) flow.result = result
  if (error) flow.error = error

  const highestSequence = flow.events.reduce((highest, event) => Math.max(highest, event.sequence), 0)
  if (flow.nextSequence < highestSequence) flow.nextSequence = highestSequence
  return flow
}

function storageData(flow: StoredProviderLoginFlow): Record<string, unknown> {
  // Construct every field explicitly. In particular, never spread `flow` into a
  // PocketBase payload: callers cannot smuggle answers, credentials, or signals in.
  return {
    user_id: flow.ownerId,
    flow_id: flow.flowId,
    provider_instance_id: flow.providerInstanceId,
    runtime_provider_id: flow.runtimeProviderId,
    type: flow.type,
    phase: flow.phase,
    created_at: flow.createdAt,
    updated_at: flow.updatedAt,
    expires_at: flow.expiresAt,
    next_sequence: flow.nextSequence,
    events: flow.events,
    current_prompt: flow.currentPrompt ?? null,
    result: flow.result ?? null,
    error: flow.error ?? null,
  }
}

function flowFromRecord(record: FlowRecord, maxEvents: number): StoredProviderLoginFlow {
  return sanitizeFlow({
    ownerId: record.user_id,
    flowId: record.flow_id,
    providerInstanceId: record.provider_instance_id,
    runtimeProviderId: record.runtime_provider_id,
    type: record.type,
    phase: record.phase,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
    expiresAt: record.expires_at,
    nextSequence: record.next_sequence,
    events: record.events,
    currentPrompt: record.current_prompt,
    result: record.result,
    error: record.error,
  }, maxEvents)
}

function assertOwnerId(ownerId: string): void {
  text(ownerId, 'ownerId', MAX_ID_LENGTH)
}

function assertFlowId(flowId: string): void {
  text(flowId, 'flowId', MAX_ID_LENGTH)
}

async function ensureCollection(
  client: PocketBase,
  schema: ProviderLoginFlowSchema,
): Promise<void> {
  const manager = collectionManager(client)
  const existing = await firstOrNull(() => manager.getOne(schema.name))
  if (!existing) {
    try {
      await manager.create({
        name: schema.name,
        type: 'base',
        fields: [...schema.fields],
        indexes: [...schema.indexes],
        listRule: '@request.auth.id = user_id',
        viewRule: '@request.auth.id = user_id',
        createRule: '@request.auth.id = user_id',
        updateRule: '@request.auth.id = user_id',
        deleteRule: '@request.auth.id = user_id',
      })
    } catch (error) {
      const raced = await firstOrNull(() => manager.getOne(schema.name))
      if (!raced) throw error
      await extendCollection(manager, raced, schema)
    }
    return
  }
  await extendCollection(manager, existing, schema)
}

async function extendCollection(manager: CollectionManager, existing: FlowRecord, schema: ProviderLoginFlowSchema): Promise<void> {
  const currentFields = Array.isArray(existing.fields)
    ? existing.fields.filter((field): field is Record<string, unknown> => typeof field === 'object' && field !== null)
    : []
  const currentIndexes = Array.isArray(existing.indexes)
    ? existing.indexes.filter((index): index is string => typeof index === 'string')
    : []
  const knownFields = new Set(currentFields.map((field) => String(field.name)))
  const missingFields = schema.fields.filter((field) => !knownFields.has(String(field.name)))
  const missingIndexes = schema.indexes.filter((index) => !currentIndexes.includes(index))
  if (missingFields.length || missingIndexes.length) {
    await manager.update(existing.id, {
      ...(missingFields.length ? { fields: [...currentFields, ...missingFields] } : {}),
      ...(missingIndexes.length ? { indexes: [...currentIndexes, ...missingIndexes] } : {}),
    })
  }
}

/** Ensure the non-secret provider login flow collection exists and is owner-scoped. */
export async function ensureProviderLoginFlowCollection(client: PocketBase): Promise<void> {
  await ensureCollection(client, PROVIDER_LOGIN_FLOW_SCHEMA)
}

/** Alias for callers that provision all provider-related collections together. */
export const ensureProviderLoginFlowCollections = ensureProviderLoginFlowCollection

/**
 * PocketBase implementation of `ProviderLoginFlowStorage`.
 *
 * The controller remains the owner-aware public boundary: it supplies an owner
 * id and compares it with the server-owned `user_id` before returning anything.
 * `getOwned`/`deleteOwned` are provided for route layers that want the owner
 * constraint applied in the PocketBase query as well.
 */
export class PocketBaseProviderLoginFlowStorage implements ProviderLoginFlowStorage {
  private readonly now: () => number
  private readonly maxEvents: number

  constructor(private readonly client: PocketBase, options: Omit<PocketBaseProviderLoginFlowStorageOptions, 'client'> = {}) {
    this.now = options.now ?? Date.now
    const maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS
    if (!Number.isInteger(maxEvents) || maxEvents < 1) throw new Error('maxEvents must be a positive integer')
    this.maxEvents = maxEvents
  }

  async ensureCollection(): Promise<void> {
    await ensureProviderLoginFlowCollection(this.client)
  }

  async get(flowId: string): Promise<StoredProviderLoginFlow | undefined> {
    assertFlowId(flowId)
    const record = await firstOrNull(() => collection(this.client).getFirstListItem(flowFilter(flowId)))
    if (!record) return undefined
    return this.expireStale(record)
  }

  async getOwned(ownerId: string, flowId: string): Promise<StoredProviderLoginFlow | undefined> {
    assertOwnerId(ownerId)
    assertFlowId(flowId)
    const record = await firstOrNull(() => collection(this.client).getFirstListItem(ownedFlowFilter(ownerId, flowId)))
    if (!record) return undefined
    return this.expireStale(record)
  }

  async set(flow: StoredProviderLoginFlow): Promise<void> {
    const normalized = sanitizeFlow(flow, this.maxEvents)
    const safe = this.expireInMemoryIfNeeded(normalized)
    const flows = collection(this.client)
    const existing = await firstOrNull(() => flows.getFirstListItem(flowFilter(safe.flowId)))
    if (existing) {
      if (text(existing.user_id, 'user_id', MAX_ID_LENGTH) !== safe.ownerId) {
        throw new Error('PocketBase provider login flow is owned by another user')
      }
      await flows.update(existing.id, storageData(safe))
      return
    }
    try {
      await flows.create(storageData(safe))
    } catch (error) {
      // A concurrent writer may have won the unique flow_id race. Do not allow
      // that writer's owner to be overwritten by this update.
      const raced = await firstOrNull(() => flows.getFirstListItem(flowFilter(safe.flowId)))
      if (!raced) throw error
      if (text(raced.user_id, 'user_id', MAX_ID_LENGTH) !== safe.ownerId) {
        throw new Error('PocketBase provider login flow is owned by another user')
      }
      await flows.update(raced.id, storageData(safe))
    }
  }

  async delete(flowId: string): Promise<void> {
    assertFlowId(flowId)
    const record = await firstOrNull(() => collection(this.client).getFirstListItem(flowFilter(flowId)))
    if (record) await collection(this.client).delete(record.id)
  }

  async deleteOwned(ownerId: string, flowId: string): Promise<void> {
    assertOwnerId(ownerId)
    assertFlowId(flowId)
    const record = await firstOrNull(() => collection(this.client).getFirstListItem(ownedFlowFilter(ownerId, flowId)))
    if (record) await collection(this.client).delete(record.id)
  }

  private expireInMemoryIfNeeded(flow: StoredProviderLoginFlow): StoredProviderLoginFlow {
    if (flow.phase !== 'pending' || this.now() < flow.expiresAt) return flow
    const { currentPrompt: _currentPrompt, ...withoutPrompt } = flow
    return {
      ...withoutPrompt,
      phase: 'expired',
      updatedAt: this.now(),
    }
  }

  private async expireStale(record: FlowRecord): Promise<StoredProviderLoginFlow> {
    const flow = flowFromRecord(record, this.maxEvents)
    if (flow.phase !== 'pending' || this.now() < flow.expiresAt) return flow
    const expired = this.expireInMemoryIfNeeded(flow)
    await collection(this.client).update(record.id, storageData(expired))
    return expired
  }
}

/** Alias matching the collection-backed store terminology used by route code. */
export { PocketBaseProviderLoginFlowStorage as PocketBaseProviderLoginFlowStore }

export function createPocketBaseProviderLoginFlowStorage(
  options: PocketBaseProviderLoginFlowStorageOptions,
): PocketBaseProviderLoginFlowStorage {
  return new PocketBaseProviderLoginFlowStorage(options.client, options)
}

export const createProviderLoginFlowStorage = createPocketBaseProviderLoginFlowStorage
export const createProviderLoginFlowStore = createPocketBaseProviderLoginFlowStorage
