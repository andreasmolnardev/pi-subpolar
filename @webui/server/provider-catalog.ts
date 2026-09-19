import type {
  Api,
  AuthCheck,
  Model as PiModel,
  Provider as PiProvider,
} from '@earendil-works/pi-ai'
import type { ModelRuntime } from '@earendil-works/pi-coding-agent'

/** The three auth choices a client may present for a provider. */
export type ProviderAuthMethodKind = 'api_key' | 'oauth' | 'subscription'

/** Deliberately finite public status vocabulary; secrets and provider errors are not DTO data. */
export type ProviderAuthState =
  | 'authenticated'
  | 'expired'
  | 'unconfigured'
  | 'error'
  | 'unknown'

export type ProviderCatalogSource = 'runtime' | 'pocketbase' | 'mixed'

export interface ProviderAuthStatusDto {
  state: ProviderAuthState
  configured: boolean
  method?: ProviderAuthMethodKind
  source?: string
  label?: string
}

export interface ProviderAuthMethodDto {
  kind: ProviderAuthMethodKind
  label: string
  available: boolean
  status: ProviderAuthStatusDto
}

/** Non-secret PocketBase/account input. Unknown fields are ignored. */
export type ProviderAccountRecord = Readonly<Record<string, unknown>>

/** A sanitized account instance; credential material is intentionally absent. */
export interface ProviderAccountDto {
  /** Same value as `instanceId`; retained as a convenient record-like alias. */
  id: string
  instanceId: string
  providerId: string
  label: string
  email?: string
  source: 'runtime' | 'pocketbase'
  authMethod?: ProviderAuthMethodKind
  status: ProviderAuthStatusDto
}

/** Model metadata safe for a selector or ModelRuntime adapter. */
export interface ProviderModelDto {
  /** Qualified, stable selection ID: `instanceId/modelId`. */
  id: string
  instanceId: string
  providerId: string
  modelId: string
  name: string
  api: Api
  reasoning: boolean
  input: readonly ('text' | 'image')[]
  cost: {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
  }
  contextWindow: number
  maxTokens: number
}

export interface ProviderCatalogProviderDto {
  id: string
  name: string
  source: ProviderCatalogSource
  authMethods: readonly ProviderAuthMethodDto[]
  authStatus: ProviderAuthStatusDto
  instances: readonly ProviderAccountDto[]
  models: readonly ProviderModelDto[]
}

export interface ProviderCatalogDto {
  providers: readonly ProviderCatalogProviderDto[]
  accounts: readonly ProviderAccountDto[]
  models: readonly ProviderModelDto[]
}

/**
 * The injectable subset used by this module. A real `ModelRuntime` satisfies it;
 * tests and alternate hosts can provide only the members they need.
 */
export interface ProviderCatalogRuntime {
  getProviders(): readonly PiProvider[]
  getModels(providerId?: string): readonly PiModel<Api>[]
  getProviderAuthStatus?(providerId: string): RuntimeAuthStatus | undefined
  checkAuth?(providerId: string, options?: { signal?: AbortSignal }): Promise<AuthCheck | undefined>
  isUsingOAuth?(providerId: string): boolean
  isUsingSubscription?(providerId: string): boolean
}

/** Structural alias for callers that want the installed Pi type explicitly. */
export type PiModelRuntime = Pick<
  ModelRuntime,
  'getProviders' | 'getModels' | 'getProviderAuthStatus' | 'checkAuth' | 'isUsingOAuth' | 'isUsingSubscription'
>

export interface RuntimeAuthStatus {
  configured: boolean
  source?: string
  label?: string
}

export interface ProviderCatalogOptions {
  /** PocketBase records or equivalent injected account records. */
  accounts?: readonly ProviderAccountRecord[]
  /** Include the runtime's provider-level instance even when PocketBase accounts exist. Defaults true. */
  includeRuntimeInstance?: boolean
  /** Optional status snapshot for hosts that already performed an auth check. */
  authStatus?: Readonly<Record<string, RuntimeAuthStatus | undefined>>
  /** Optional clock for deterministic tests; currently reserved for host status policy. */
  now?: () => number
}

export interface AsyncProviderCatalogOptions extends ProviderCatalogOptions {
  signal?: AbortSignal
}

interface InternalBuildOptions extends ProviderCatalogOptions {
  checkedAuth?: Readonly<Record<string, AuthCheck | undefined>>
}

const SECRET_FIELD = /(?:api.?key|access.?token|refresh.?token|id.?token|secret|password|credential|authorization|cookie|header)/i
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g

function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const result = value.trim()
  return result ? result : undefined
}

function safeText(value: unknown, fallback: string, maxLength = 200): string {
  const result = (text(value) ?? fallback).replace(CONTROL_CHARS, '').trim()
  return result.slice(0, maxLength) || fallback
}

function firstText(record: ProviderAccountRecord, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    if (SECRET_FIELD.test(key)) continue
    const value = text(record[key])
    if (value) return value
  }
  return undefined
}

function booleanValue(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value !== 'string') return undefined
  if (value.toLowerCase() === 'true' || value === '1') return true
  if (value.toLowerCase() === 'false' || value === '0') return false
  return undefined
}

function normalizeProviderId(value: unknown): string | undefined {
  return text(value)
}

function normalizeAuthMethod(value: unknown): ProviderAuthMethodKind | undefined {
  const method = text(value)?.toLowerCase().replace(/[ -]/g, '_')
  if (!method) return undefined
  if (method === 'api_key' || method === 'apikey' || method === 'api') return 'api_key'
  if (method === 'oauth' || method === 'oauth2') return 'oauth'
  if (method === 'subscription' || method === 'subscribed' || method === 'oauth_subscription') return 'subscription'
  return undefined
}

function normalizeState(value: unknown, enabled?: boolean): ProviderAuthState | undefined {
  if (enabled === false) return 'unconfigured'
  if (typeof value === 'boolean') return value ? 'authenticated' : 'unconfigured'
  const state = text(value)?.toLowerCase().replace(/[ -]/g, '_')
  if (!state) return undefined
  if (['authenticated', 'connected', 'active', 'ready', 'valid', 'configured', 'linked'].includes(state)) return 'authenticated'
  if (['expired', 'stale', 'token_expired'].includes(state)) return 'expired'
  if (['error', 'failed', 'invalid', 'revoked'].includes(state)) return 'error'
  if (['unconfigured', 'disconnected', 'disabled', 'logged_out', 'unauthenticated'].includes(state)) return 'unconfigured'
  return 'unknown'
}

function configuredState(state: ProviderAuthState | undefined): boolean {
  return state === 'authenticated'
}

function statusDto(
  state: ProviderAuthState,
  method?: ProviderAuthMethodKind,
  source?: string,
  label?: string,
): ProviderAuthStatusDto {
  return {
    state,
    configured: configuredState(state),
    ...(method ? { method } : {}),
    ...(source ? { source: safeText(source, source, 120) } : {}),
    ...(label ? { label: safeText(label, label, 200) } : {}),
  }
}

function runtimeStatus(runtime: ProviderCatalogRuntime, providerId: string, options: InternalBuildOptions): RuntimeAuthStatus | undefined {
  return options.authStatus?.[providerId] ?? runtime.getProviderAuthStatus?.(providerId)
}

function methodLabel(kind: ProviderAuthMethodKind, provider: PiProvider | undefined): string {
  if (kind === 'api_key') return safeText(provider?.auth.apiKey?.name, 'API key')
  if (kind === 'subscription') return safeText(provider?.auth.oauth?.name, 'Subscription')
  return safeText(provider?.auth.oauth?.name, 'OAuth')
}

function runtimeMethodKinds(runtime: ProviderCatalogRuntime, provider: PiProvider | undefined, providerId: string): ProviderAuthMethodKind[] {
  const kinds: ProviderAuthMethodKind[] = []
  if (provider?.auth.apiKey) kinds.push('api_key')
  if (provider?.auth.oauth) {
    if (runtime.isUsingSubscription?.(providerId) || provider.auth.oauth.isSubscription) kinds.push('subscription')
    else kinds.push('oauth')
  }
  return kinds
}

function authMethods(
  runtime: ProviderCatalogRuntime,
  provider: PiProvider | undefined,
  providerId: string,
  accountMethods: readonly ProviderAuthMethodKind[],
  options: InternalBuildOptions,
): ProviderAuthMethodDto[] {
  const kinds = new Set<ProviderAuthMethodKind>([
    ...runtimeMethodKinds(runtime, provider, providerId),
    ...accountMethods,
  ])
  const runtimeAuth = runtimeStatus(runtime, providerId, options)
  const checked = options.checkedAuth?.[providerId]
  const configuredKind = runtime.isUsingSubscription?.(providerId) || provider?.auth.oauth?.isSubscription
    ? 'subscription'
    : runtime.isUsingOAuth?.(providerId)
      ? 'oauth'
      : 'api_key'
  const checkedKind = checked?.type === 'oauth'
    ? (runtime.isUsingSubscription?.(providerId) || provider?.auth.oauth?.isSubscription ? 'subscription' : 'oauth')
    : checked?.type === 'api_key' ? 'api_key' : undefined

  return [...kinds].sort().map((kind) => {
    let state: ProviderAuthState = 'unknown'
    if (checkedKind) state = checkedKind === kind ? 'authenticated' : 'unconfigured'
    else if (runtimeAuth) state = runtimeAuth.configured ? (configuredKind === kind ? 'authenticated' : 'unconfigured') : 'unconfigured'
    return {
      kind,
      label: methodLabel(kind, provider),
      available: true,
      status: statusDto(state, kind, runtimeAuth?.source, runtimeAuth?.label),
    }
  })
}

function providerOverallStatus(methods: readonly ProviderAuthMethodDto[], accounts: readonly ProviderAccountDto[]): ProviderAuthStatusDto {
  const authenticated = methods.find((method) => method.status.configured)
  if (authenticated) return authenticated.status
  const account = accounts.find((item) => item.status.configured)
  if (account) return account.status
  const problem = methods.find((method) => method.status.state === 'error' || method.status.state === 'expired')
  if (problem) return problem.status
  if (methods.length > 0) return methods[0].status
  return statusDto('unknown')
}

function getAccountId(record: ProviderAccountRecord): string | undefined {
  return firstText(record, ['id', 'accountId', 'account_id', 'instanceId', 'instance_id', 'externalId', 'external_id'])
}

function encodeIdPart(value: string): string {
  return encodeURIComponent(value).replaceAll('~', '%7E')
}

/** Compose the stable instance ID used by all qualified model selections. */
export function composeProviderInstanceId(providerId: string, accountId?: string): string {
  const provider = encodeIdPart(providerId.trim())
  const account = accountId?.trim()
  return account ? `${provider}~${encodeIdPart(account)}` : provider
}

/** Parse an instance ID produced by `composeProviderInstanceId`. */
export function parseProviderInstanceId(instanceId: string): { providerId: string; accountId?: string } | undefined {
  const value = text(instanceId)
  if (!value) return undefined
  const separator = value.indexOf('~')
  try {
    if (separator < 0) return { providerId: decodeURIComponent(value) }
    const providerId = decodeURIComponent(value.slice(0, separator))
    const accountId = decodeURIComponent(value.slice(separator + 1))
    return providerId && accountId ? { providerId, accountId } : undefined
  } catch {
    return undefined
  }
}

/** Compose a selection safe for model IDs containing `/` or other delimiters. */
export function composeModelSelection(instanceId: string, modelId: string): string {
  return `${encodeURIComponent(instanceId)}/${encodeURIComponent(modelId)}`
}

/** Parse a `composeModelSelection` value. Splitting only on the first slash preserves model IDs. */
export function parseModelSelection(selection: string): { instanceId: string; modelId: string } | undefined {
  const value = text(selection)
  if (!value) return undefined
  const separator = value.indexOf('/')
  if (separator <= 0 || separator === value.length - 1) return undefined
  try {
    const instanceId = decodeURIComponent(value.slice(0, separator))
    const modelId = decodeURIComponent(value.slice(separator + 1))
    return instanceId && modelId ? { instanceId, modelId } : undefined
  } catch {
    return undefined
  }
}

/** Short aliases useful in route/adapter code. */
export const composeSelection = composeModelSelection
export const parseSelection = parseModelSelection
export const composeProviderModelId = composeModelSelection
export const parseProviderModelId = parseModelSelection

/** Convert a PocketBase record into a non-secret account DTO. */
export function sanitizeProviderAccount(
  record: ProviderAccountRecord,
  providerIdOverride?: string,
): ProviderAccountDto | undefined {
  const providerId = normalizeProviderId(providerIdOverride) ?? normalizeProviderId(
    firstText(record, ['providerId', 'provider_id', 'provider', 'providerName']),
  )
  if (!providerId) return undefined

  const accountId = getAccountId(record)
  const instanceId = composeProviderInstanceId(providerId, accountId)
  const kind = normalizeAuthMethod(firstText(record, ['authMethod', 'auth_method', 'authType', 'auth_type', 'method']))
  const enabled = booleanValue(record.enabled)
  const state = normalizeState(record.status ?? record.authStatus ?? record.auth_status, enabled) ?? 'unknown'
  const email = firstText(record, ['email', 'accountEmail', 'account_email'])
  const label = safeText(
    firstText(record, ['label', 'displayName', 'display_name', 'name', 'accountName', 'account_name']) ?? email,
    accountId ? `Account ${accountId}` : providerId,
  )
  return {
    id: instanceId,
    instanceId,
    providerId,
    label,
    ...(email ? { email: safeText(email, email, 320) } : {}),
    source: 'pocketbase',
    ...(kind ? { authMethod: kind } : {}),
    status: statusDto(state, kind),
  }
}

/** Sanitize and de-duplicate injected PocketBase account records. */
export function sanitizeProviderAccounts(records: readonly ProviderAccountRecord[]): ProviderAccountDto[] {
  const accounts = new Map<string, ProviderAccountDto>()
  for (const record of records) {
    const account = sanitizeProviderAccount(record)
    if (account) accounts.set(account.instanceId, account)
  }
  return [...accounts.values()].sort((a, b) => a.instanceId.localeCompare(b.instanceId))
}

function sanitizeModel(model: PiModel<Api>, instanceId: string, providerId: string): ProviderModelDto {
  const cost = model.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  return {
    id: composeModelSelection(instanceId, model.id),
    instanceId,
    providerId,
    modelId: model.id,
    name: safeText(model.name, model.id),
    api: model.api,
    reasoning: model.reasoning === true,
    input: [...(Array.isArray(model.input) ? model.input : ['text'])].filter((item): item is 'text' | 'image' => item === 'text' || item === 'image'),
    cost: {
      input: Number.isFinite(cost.input) ? cost.input : 0,
      output: Number.isFinite(cost.output) ? cost.output : 0,
      cacheRead: Number.isFinite(cost.cacheRead) ? cost.cacheRead : 0,
      cacheWrite: Number.isFinite(cost.cacheWrite) ? cost.cacheWrite : 0,
    },
    contextWindow: Number.isFinite(model.contextWindow) ? model.contextWindow : 0,
    maxTokens: Number.isFinite(model.maxTokens) ? model.maxTokens : 0,
  }
}

function makeRuntimeAccount(
  runtime: ProviderCatalogRuntime,
  providerId: string,
  provider: PiProvider | undefined,
  options: InternalBuildOptions,
): ProviderAccountDto {
  const instanceId = composeProviderInstanceId(providerId)
  const runtimeAuth = runtimeStatus(runtime, providerId, options)
  const checked = options.checkedAuth?.[providerId]
  const methods = runtimeMethodKinds(runtime, provider, providerId)
  const checkedMethod = checked?.type === 'oauth'
    ? (runtime.isUsingSubscription?.(providerId) || provider?.auth.oauth?.isSubscription ? 'subscription' : 'oauth')
    : checked?.type === 'api_key' ? 'api_key' : undefined
  const method = checkedMethod ?? (methods.length === 1 ? methods[0] : undefined)
  const state: ProviderAuthState = checkedMethod
    ? 'authenticated'
    : runtimeAuth?.configured ? 'authenticated' : runtimeAuth ? 'unconfigured' : 'unknown'
  return {
    id: instanceId,
    instanceId,
    providerId,
    label: safeText(provider?.name, providerId),
    source: 'runtime',
    ...(method ? { authMethod: method } : {}),
    status: statusDto(state, method, runtimeAuth?.source, runtimeAuth?.label),
  }
}

interface ProviderAccumulator {
  id: string
  name: string
  provider?: PiProvider
  models: readonly PiModel<Api>[]
  accounts: ProviderAccountDto[]
  source: ProviderCatalogSource
}

/**
 * Build a sanitized synchronous snapshot. This never resolves credentials and
 * never copies model/provider headers, options, env values, keys, or tokens.
 */
function createProviderCatalogSnapshot(
  runtime: ProviderCatalogRuntime,
  options: InternalBuildOptions = {},
): ProviderCatalogDto {
  const accumulators = new Map<string, ProviderAccumulator>()
  const ensure = (providerId: string, name = providerId): ProviderAccumulator => {
    const existing = accumulators.get(providerId)
    if (existing) return existing
    const created: ProviderAccumulator = { id: providerId, name, models: [], accounts: [], source: 'runtime' }
    accumulators.set(providerId, created)
    return created
  }

  for (const provider of runtime.getProviders()) {
    const providerId = normalizeProviderId(provider.id)
    if (!providerId) continue
    const entry = ensure(providerId, safeText(provider.name, providerId))
    entry.provider = provider
    entry.source = 'runtime'
    try {
      entry.models = [...runtime.getModels(providerId)]
    } catch {
      entry.models = []
    }
  }

  let allModels: readonly PiModel<Api>[] = []
  try {
    allModels = runtime.getModels()
  } catch {
    allModels = []
  }
  for (const model of allModels) {
    const providerId = normalizeProviderId(model.provider)
    if (!providerId) continue
    const entry = ensure(providerId)
    if (!entry.models.some((candidate) => candidate.id === model.id)) entry.models = [...entry.models, model]
  }

  const accountDtos = sanitizeProviderAccounts(options.accounts ?? [])
  for (const account of accountDtos) {
    const entry = ensure(account.providerId)
    entry.accounts.push(account)
    entry.source = entry.provider ? 'mixed' : 'pocketbase'
  }

  const includeRuntimeInstance = options.includeRuntimeInstance !== false
  const providers: ProviderCatalogProviderDto[] = []
  const models: ProviderModelDto[] = []
  const accounts: ProviderAccountDto[] = []

  for (const entry of [...accumulators.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    const accountMap = new Map<string, ProviderAccountDto>()
    if (includeRuntimeInstance && entry.provider) {
      const runtimeAccount = makeRuntimeAccount(runtime, entry.id, entry.provider, options)
      accountMap.set(runtimeAccount.instanceId, runtimeAccount)
    }
    for (const account of entry.accounts) accountMap.set(account.instanceId, account)
    const instances = [...accountMap.values()].sort((a, b) => a.instanceId.localeCompare(b.instanceId))
    const accountMethods = instances.flatMap((account) => account.authMethod ? [account.authMethod] : [])
    const methods = authMethods(runtime, entry.provider, entry.id, accountMethods, options)
    const providerModels = instances.flatMap((instance) => entry.models.map((model) => sanitizeModel(model, instance.instanceId, entry.id)))
    const uniqueModels = [...new Map(providerModels.map((model) => [model.id, model])).values()].sort((a, b) => a.id.localeCompare(b.id))
    const authStatus = providerOverallStatus(methods, instances)
    providers.push({
      id: entry.id,
      name: safeText(entry.name, entry.id),
      source: entry.source,
      authMethods: methods,
      authStatus,
      instances,
      models: uniqueModels,
    })
    accounts.push(...instances)
    models.push(...uniqueModels)
  }

  return { providers, accounts, models: models.sort((a, b) => a.id.localeCompare(b.id)) }
}

/** Build a sanitized synchronous snapshot from a Pi `ModelRuntime`-compatible source. */
export function createProviderCatalog(
  runtime: ProviderCatalogRuntime,
  options: ProviderCatalogOptions = {},
): ProviderCatalogDto {
  return createProviderCatalogSnapshot(runtime, options)
}

/** Alias emphasizing that this consumes a Pi `ModelRuntime`. */
export const buildProviderCatalog = createProviderCatalog

/**
 * Build a snapshot after Pi's side-effect-free `checkAuth` calls. The calls may
 * consult the injected credential/environment stores, but their results—not
 * credentials—are the only auth data retained.
 */
export async function createProviderCatalogAsync(
  runtime: ProviderCatalogRuntime,
  options: AsyncProviderCatalogOptions = {},
): Promise<ProviderCatalogDto> {
  if (!runtime.checkAuth) return createProviderCatalogSnapshot(runtime, options)
  const providerIds = runtime.getProviders().map((provider) => provider.id)
  const checked = await Promise.all(providerIds.map(async (providerId) => {
    try {
      return [providerId, await runtime.checkAuth?.(providerId, { signal: options.signal })] as const
    } catch {
      return [providerId, undefined] as const
    }
  }))
  return createProviderCatalogSnapshot(runtime, { ...options, checkedAuth: Object.fromEntries(checked) })
}

export const buildProviderCatalogAsync = createProviderCatalogAsync

/** Merge PocketBase instances into an already-built catalog without rebuilding runtime data. */
export function mergeProviderAccounts(
  catalog: ProviderCatalogDto,
  records: readonly ProviderAccountRecord[],
): ProviderCatalogDto {
  const accountDtos = sanitizeProviderAccounts(records)
  if (accountDtos.length === 0) return catalog
  const byProvider = new Map(catalog.providers.map((provider) => [provider.id, provider]))
  const byModelId = new Map(catalog.models.map((model) => [model.id, model]))
  const nextProviders = [...catalog.providers]

  for (const account of accountDtos) {
    let provider = byProvider.get(account.providerId)
    if (!provider) {
      provider = {
        id: account.providerId,
        name: account.providerId,
        source: 'pocketbase',
        authMethods: account.authMethod ? [{ kind: account.authMethod, label: account.authMethod, available: true, status: account.status }] : [],
        authStatus: account.status,
        instances: [],
        models: [],
      }
      byProvider.set(provider.id, provider)
      nextProviders.push(provider)
    }
    const currentProvider = provider
    const instances = [...currentProvider.instances.filter((item) => item.instanceId !== account.instanceId), account]
    const methods = [...currentProvider.authMethods]
    if (account.authMethod && !methods.some((method) => method.kind === account.authMethod)) {
      methods.push({ kind: account.authMethod, label: account.authMethod, available: true, status: account.status })
    }
    const providerModels = currentProvider.models.length > 0
      ? currentProvider.models.filter((model) => model.instanceId === currentProvider.id).map((model) => {
        const next = { ...model, instanceId: account.instanceId, id: composeModelSelection(account.instanceId, model.modelId) }
        byModelId.set(next.id, next)
        return next
      })
      : []
    provider = {
      ...currentProvider,
      source: 'mixed',
      authMethods: methods.sort((a, b) => a.kind.localeCompare(b.kind)),
      authStatus: currentProvider.authStatus.configured ? currentProvider.authStatus : account.status,
      instances: instances.sort((a, b) => a.instanceId.localeCompare(b.instanceId)),
      models: [...currentProvider.models, ...providerModels].filter((model, index, all) => all.findIndex((candidate) => candidate.id === model.id) === index),
    }
    byProvider.set(provider.id, provider)
    const index = nextProviders.findIndex((candidate) => candidate.id === provider?.id)
    if (index >= 0) nextProviders[index] = provider
  }

  const nextModels = [...byModelId.values()]
  return {
    providers: nextProviders.sort((a, b) => a.id.localeCompare(b.id)),
    accounts: nextProviders.flatMap((provider) => provider.instances),
    models: nextModels.sort((a, b) => a.id.localeCompare(b.id)),
  }
}

export const mergePocketBaseProviderAccounts = mergeProviderAccounts

/** Minimal PocketBase shape accepted by the optional collection reader. */
export interface PocketBaseProviderAccountClient {
  collection(name: string): {
    getFullList(options?: { fields?: string }): Promise<readonly ProviderAccountRecord[]>
  }
}

/**
 * Read only non-secret fields from a PocketBase provider-account collection.
 * The returned records are still sanitized by `sanitizeProviderAccounts`.
 */
export async function readPocketBaseProviderAccounts(
  client: PocketBaseProviderAccountClient,
  collection = 'provider_accounts',
): Promise<ProviderAccountDto[]> {
  const fields = [
    'id', 'provider_id', 'providerId', 'provider', 'name', 'label', 'display_name',
    'account_name', 'accountName', 'account_id', 'accountId', 'instance_id', 'instanceId',
    'email', 'auth_method', 'authMethod', 'auth_type', 'authType', 'method', 'status',
    'auth_status', 'authStatus', 'enabled',
  ].join(',')
  const records = await client.collection(collection).getFullList({ fields })
  return sanitizeProviderAccounts(records)
}

export const listPocketBaseProviderAccounts = readPocketBaseProviderAccounts
