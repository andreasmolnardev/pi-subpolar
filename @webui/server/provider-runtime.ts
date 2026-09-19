import type {
  Api,
  ApiStreamOptions,
  AssistantMessageEventStream,
  AuthContext,
  AuthOperationOptions,
  Credential,
  CredentialInfo,
  Context,
  DeferredCancelOptions,
  DeferredFetchOptions,
  DeferredHandle,
  Model,
  Provider,
  CredentialStore,
  ProviderAuth,
  RefreshModelsContext,
  SimpleStreamOptions,
} from '@earendil-works/pi-ai'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'

import type { ProviderRuntimeFactory } from './provider-login-flow.ts'
import type { ProviderAccount, ProviderAccountService } from './provider-accounts.ts'

/** The service operations needed by this adapter. The concrete service is PocketBase-backed. */
export type ProviderRuntimeAccountService = Pick<
  ProviderAccountService,
  'listAccounts' | 'getAccount' | 'loadCredential' | 'updateAccount' | 'deleteAccount'
>

export type RemoveProviderCredential = (userId: string, instanceId: string) => Promise<void>

export interface ProviderRuntimeCredentialStoreOptions {
  userId: string
  accountService: ProviderRuntimeAccountService
  accounts: readonly ProviderAccount[]
  /**
   * Optional true credential-removal operation. The current ProviderAccountService
   * has no clear-credential method, so the default removes the whole account.
   */
  removeCredential?: RemoveProviderCredential
}

export interface CreateProviderRuntimeOptions {
  /** The authenticated PocketBase user that owns every account in this runtime. */
  userId: string
  accountService: ProviderRuntimeAccountService
  /** Use a prebuilt provider runtime as the implementation source for custom providers. */
  baseRuntime?: ModelRuntime
  /** Avoids a second account-list request when the caller already has the snapshot. */
  accounts?: readonly ProviderAccount[]
  /** Refresh static/dynamic Pi catalogs after account providers are registered. Defaults false. */
  refreshOnCreate?: boolean
  /** Network permission for the optional create-time refresh. Defaults false. */
  allowModelNetwork?: boolean
  /** See {@link RemoveProviderCredential}; useful once the service supports clearing in place. */
  removeCredential?: RemoveProviderCredential
}

/** A real Pi ModelRuntime with all providers scoped to one authenticated user. */
export type ProviderRuntime = ModelRuntime

/**
 * Make the stable runtime id used for an account provider. Encoding keeps custom
 * provider/account ids from colliding with the separator or model-selection syntax.
 */
export function composeProviderRuntimeId(providerType: string, instanceId: string): string {
  return `${encodeIdPart(requiredPart(providerType, 'providerType'))}~${encodeIdPart(requiredPart(instanceId, 'instanceId'))}`
}

/** Parse an id produced by {@link composeProviderRuntimeId}. */
export function parseProviderRuntimeId(runtimeProviderId: string): { providerType: string; instanceId: string } | undefined {
  if (typeof runtimeProviderId !== 'string' || !runtimeProviderId) return undefined
  const separator = runtimeProviderId.indexOf('~')
  if (separator <= 0 || separator === runtimeProviderId.length - 1) return undefined
  try {
    const providerType = decodeURIComponent(runtimeProviderId.slice(0, separator))
    const instanceId = decodeURIComponent(runtimeProviderId.slice(separator + 1))
    return providerType && instanceId ? { providerType, instanceId } : undefined
  } catch {
    return undefined
  }
}

function encodeIdPart(value: string): string {
  return encodeURIComponent(value).replaceAll('~', '%7E')
}

function requiredPart(value: string, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${name} is required`)
  return value.trim()
}

function assertUserId(userId: string): void {
  requiredPart(userId, 'userId')
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  signal?.throwIfAborted()
}

const EMPTY_AUTH_CONTEXT: AuthContext = {
  env: async () => undefined,
  fileExists: async () => false,
}

/**
 * CredentialStore implementation backed by ProviderAccountService. It never
 * falls back to AuthStorage, ~/.pi, process.env, or filesystem credentials.
 */
export class ProviderRuntimeCredentialStore implements CredentialStore {
  private readonly accountsByRuntimeId: ReadonlyMap<string, ProviderAccount>
  private readonly chains = new Map<string, Promise<void>>()
  private readonly loggedOut = new Set<string>()
  private readonly removeCredential: RemoveProviderCredential

  constructor(private readonly options: ProviderRuntimeCredentialStoreOptions) {
    assertUserId(options.userId)
    const accounts = new Map<string, ProviderAccount>()
    for (const account of options.accounts) {
      const runtimeProviderId = composeProviderRuntimeId(account.providerType, account.instanceId)
      if (accounts.has(runtimeProviderId)) throw new Error(`Duplicate provider runtime id: ${runtimeProviderId}`)
      accounts.set(runtimeProviderId, account)
    }
    this.accountsByRuntimeId = accounts
    this.removeCredential = options.removeCredential ?? (async (userId, instanceId) => {
      await options.accountService.deleteAccount(userId, instanceId)
    })
  }

  async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    throwIfAborted(options?.signal)
    const account = this.accountsByRuntimeId.get(providerId)
    if (!account || this.loggedOut.has(providerId)) return undefined
    const current = await this.currentAccount(account)
    throwIfAborted(options?.signal)
    if (!current || current.status !== 'active' || !current.hasCredential) return undefined
    const credential = await this.options.accountService.loadCredential(this.options.userId, account.instanceId)
    throwIfAborted(options?.signal)
    return credential ?? undefined
  }

  async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    throwIfAborted(options?.signal)
    const currentAccounts = await this.options.accountService.listAccounts(this.options.userId)
    const currentByInstanceId = new Map(currentAccounts.map((account) => [account.instanceId, account]))
    return [...this.accountsByRuntimeId.entries()]
      .flatMap(([providerId, original]) => {
        const account = currentByInstanceId.get(original.instanceId)
        if (!account || account.status !== 'active' || !account.hasCredential || this.loggedOut.has(providerId)) return []
        return [{ providerId, type: account.authType }]
      })
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    const account = this.accountFor(providerId)
    const previous = this.chains.get(providerId) ?? Promise.resolve()
    let operation!: Promise<Credential | undefined>
    operation = (async () => {
      await previous.catch(() => undefined)
      throwIfAborted(options?.signal)
      const current = await this.read(providerId, options)
      const next = await fn(current)
      throwIfAborted(options?.signal)
      if (next === undefined) return current
      const updated = await this.options.accountService.updateAccount(this.options.userId, account.instanceId, {
        authType: next.type,
        credential: next,
      })
      if (!updated) throw new Error(`Provider account not found: ${account.instanceId}`)
      this.loggedOut.delete(providerId)
      return next
    })()
    const tail = operation.then(() => undefined, () => undefined)
    this.chains.set(providerId, tail)
    void tail.then(() => {
      if (this.chains.get(providerId) === tail) this.chains.delete(providerId)
    })
    return operation
  }

  async delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
    const account = this.accountFor(providerId)
    const previous = this.chains.get(providerId) ?? Promise.resolve()
    const operation = (async () => {
      await previous.catch(() => undefined)
      throwIfAborted(options?.signal)
      await this.removeCredential(this.options.userId, account.instanceId)
      this.loggedOut.add(providerId)
    })()
    const tail = operation.then(() => undefined, () => undefined)
    this.chains.set(providerId, tail)
    void tail.then(() => {
      if (this.chains.get(providerId) === tail) this.chains.delete(providerId)
    })
    await operation
  }

  private accountFor(providerId: string): ProviderAccount {
    const account = this.accountsByRuntimeId.get(providerId)
    if (!account) throw new Error(`Unknown provider runtime id: ${providerId}`)
    return account
  }

  private async currentAccount(account: ProviderAccount): Promise<ProviderAccount | null> {
    const current = await this.options.accountService.getAccount(this.options.userId, account.instanceId)
    if (!current || current.providerType !== account.providerType) return null
    return current
  }
}

function scopedProviderAuth(auth: ProviderAuth): ProviderAuth {
  const baseApiKey = auth.apiKey
  const apiKey = baseApiKey
    ? {
        ...baseApiKey,
        ...(baseApiKey.check
          ? {
              check: (input: Parameters<NonNullable<typeof baseApiKey.check>>[0]) =>
                baseApiKey.check!({ ...input, ctx: EMPTY_AUTH_CONTEXT }),
            }
          : {}),
        resolve: (input: Parameters<typeof baseApiKey.resolve>[0]) =>
          baseApiKey.resolve({ ...input, ctx: EMPTY_AUTH_CONTEXT }),
      }
    : undefined
  return {
    ...(apiKey ? { apiKey } : {}),
    ...(auth.oauth ? { oauth: auth.oauth } : {}),
  }
}

function runtimeModel(model: Model<Api>, providerId: string): Model<Api> {
  return { ...model, provider: providerId }
}

function baseModel(model: Model<Api>, providerId: string): Model<Api> {
  return { ...model, provider: providerId }
}

function delegatedProvider(base: Provider, runtimeProviderId: string, displayName?: string): Provider {
  const delegated: Provider = {
    id: runtimeProviderId,
    name: displayName ? `${base.name} (${displayName})` : base.name,
    ...(base.baseUrl === undefined ? {} : { baseUrl: base.baseUrl }),
    ...(base.headers === undefined ? {} : { headers: base.headers }),
    auth: scopedProviderAuth(base.auth),
    getModels: () => base.getModels().map((model) => runtimeModel(model, runtimeProviderId)),
    filterModels: base.filterModels
      ? (models, credential) => base.filterModels!(models.map((model) => baseModel(model, base.id)), credential).map((model) => runtimeModel(model, runtimeProviderId))
      : undefined,
    stream<T extends Api>(model: Model<T>, context: Context, options?: ApiStreamOptions<T>): AssistantMessageEventStream {
      return base.stream(model, context, options)
    },
    streamSimple(model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
      return base.streamSimple(model, context, options)
    },
    ...(base.fetchDeferred
      ? {
          fetchDeferred(model: Model<Api>, handle: DeferredHandle, options?: DeferredFetchOptions): AssistantMessageEventStream {
            return base.fetchDeferred!(model, handle, options)
          },
        }
      : {}),
    ...(base.cancelDeferred
      ? {
          cancelDeferred(model: Model<Api>, handle: DeferredHandle, options?: DeferredCancelOptions): Promise<void> {
            return base.cancelDeferred!(model, handle, options)
          },
        }
      : {}),
  }

  if (base.refreshModels) {
    delegated.refreshModels = async (context: RefreshModelsContext) => {
      await base.refreshModels!({ ...context })
    }
  }
  return delegated
}

/**
 * Create an isolated, account-scoped ModelRuntime. The returned object is the
 * installed SDK class, so it can be passed directly to createAgentSession.
 */
export async function createProviderRuntime(options: CreateProviderRuntimeOptions): Promise<ProviderRuntime> {
  assertUserId(options.userId)
  const accounts = options.accounts ? [...options.accounts] : await options.accountService.listAccounts(options.userId)
  const credentialStore = new ProviderRuntimeCredentialStore({
    userId: options.userId,
    accountService: options.accountService,
    accounts,
    removeCredential: options.removeCredential,
  })
  const runtime = await ModelRuntime.create({
    credentials: credentialStore,
    modelsPath: null,
    refreshOnCreate: false,
    allowModelNetwork: false,
  })
  const sourceRuntime = options.baseRuntime ?? runtime
  const sourceProviders = new Map(sourceRuntime.getProviders().map((provider) => [provider.id, provider]))
  const initialProviderIds = runtime.getProviders().map((provider) => provider.id)

  for (const account of accounts) {
    const base = sourceProviders.get(account.providerType)
    if (!base) throw new Error(`Pi provider implementation not found: ${account.providerType}`)
    if (account.authType === 'oauth' && !base.auth.oauth) throw new Error(`Pi provider does not support OAuth: ${account.providerType}`)
    if (account.authType === 'api_key' && !base.auth.apiKey) throw new Error(`Pi provider does not support API keys: ${account.providerType}`)
    const runtimeProviderId = composeProviderRuntimeId(account.providerType, account.instanceId)
    runtime.registerNativeProvider(delegatedProvider(base, runtimeProviderId, account.displayName))
  }
  // ModelRuntime has no public deleteProvider API. Replace built-ins with empty,
  // credential-isolated masks; the proxy below hides these implementation details.
  for (const providerId of initialProviderIds) {
    const base = sourceProviders.get(providerId) ?? runtime.getProvider(providerId)
    if (!base) continue
    const masked = delegatedProvider(base, providerId)
    masked.getModels = () => []
    masked.refreshModels = undefined
    runtime.registerNativeProvider(masked)
  }

  // Synchronizes getProviderAuthStatus/getAvailableSnapshot without network access.
  await runtime.refresh({ allowNetwork: false })
  if (options.refreshOnCreate) {
    await runtime.refresh({ allowNetwork: options.allowModelNetwork === true })
  }
  const visibleProviderIds = new Set(accounts.map((account) => composeProviderRuntimeId(account.providerType, account.instanceId)))
  return new Proxy(runtime, {
    get(target, property, receiver) {
      if (property === 'getProviders') {
        return () => target.getProviders().filter((provider) => visibleProviderIds.has(provider.id))
      }
      if (property === 'getProvider') {
        return (providerId: string) => visibleProviderIds.has(providerId) ? target.getProvider(providerId) : undefined
      }
      if (property === 'getModels') {
        return (providerId?: string) => providerId === undefined
          ? target.getModels().filter((model) => visibleProviderIds.has(model.provider))
          : visibleProviderIds.has(providerId) ? target.getModels(providerId) : []
      }
      if (property === 'getModel') {
        return (providerId: string, modelId: string) => visibleProviderIds.has(providerId) ? target.getModel(providerId, modelId) : undefined
      }
      if (property === 'getAvailableSnapshot') {
        return () => target.getAvailableSnapshot().filter((model) => visibleProviderIds.has(model.provider))
      }
      return Reflect.get(target, property, receiver)
    },
  })
}

/** Alias for callers that prefer an explicit user-oriented name. */
export const createUserProviderRuntime = createProviderRuntime

/**
 * Adapt this module to ProviderLoginFlowController's runtimeFactory contract.
 * A new runtime is created per flow, so each flow has no mutable global auth state.
 */
export function createProviderRuntimeFactory(options: Omit<CreateProviderRuntimeOptions, 'userId'>): ProviderRuntimeFactory {
  return async (context) => {
    const runtime = await createProviderRuntime({ ...options, userId: context.ownerId })
    if (!runtime.getProvider(context.runtimeProviderId)) {
      throw new Error(`Provider runtime is not available: ${context.runtimeProviderId}`)
    }
    return runtime
  }
}

/**
 * Helper for callers that need the existing login-flow mapping without exposing
 * credentials or depending on a provider catalog DTO.
 */
export function providerRuntimeMapping(account: Pick<ProviderAccount, 'providerType' | 'instanceId'>): {
  runtimeProviderId: string
  accountContext: { providerType: string; instanceId: string }
} {
  const runtimeProviderId = composeProviderRuntimeId(account.providerType, account.instanceId)
  return {
    runtimeProviderId,
    accountContext: { providerType: account.providerType, instanceId: account.instanceId },
  }
}
