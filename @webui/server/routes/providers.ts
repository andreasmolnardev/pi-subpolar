/* Domain route extracted from bridge-request-handler.ts. */
// @ts-nocheck
import type { BridgeRequestContext } from '../bridge-route-context.ts'

export async function handleProvidersRoute(context: BridgeRequestContext): Promise<Response | undefined> {
  const { request, url, path, correlationId, deps, gatewayCredential, internalRequest } = context
  let authenticatedUser = context.authenticatedUser
  if (path[1] === 'providers' && authenticatedUser) {
    try {
      const userId = authenticatedUser.id

      if (path[2] === 'custom') {
        const customProviders = deps.createCustomProviderService(await deps.applicationDatabase())
        if (path.length === 3 && request.method === 'GET') return deps.json({ providers: await customProviders.list(userId) })
        if (path.length === 3 && request.method === 'POST') {
          const input = deps.object(await deps.body(request))
          const id = typeof input.id === 'string' ? input.id.trim() : ''
          const name = typeof input.name === 'string' ? input.name.trim() : ''
          const baseUrl = typeof input.baseUrl === 'string' ? input.baseUrl.trim() : ''
          if (!id || !/^[a-zA-Z0-9_-]+$/.test(id) || !name || !baseUrl) return deps.json({ message: 'id, name, and baseUrl are required' }, 400)
          const saved = await customProviders.save(userId, input)
          return deps.json({ provider: saved.provider }, saved.created ? 201 : 200)
        }
        if (path.length === 4 && request.method === 'DELETE') {
          const id = decodeURIComponent(path[3] ?? '')
          await customProviders.delete(userId, id)
          return deps.json({ ok: true })
        }
        if (path.length === 4 && path[3] === 'discover-models' && request.method === 'POST') {
          try {
            const input = deps.object(await deps.body(request))
            const baseUrl = typeof input.baseUrl === 'string' ? input.baseUrl.trim() : ''
            if (!baseUrl) return deps.json({ message: 'baseUrl is required' }, 400)
            const discoveryUrl = deps.customProviderDiscoveryUrl(baseUrl)
            const headers: Record<string, string> = { Accept: 'application/deps.json' }
            if (typeof input.apiKey === 'string' && input.apiKey) headers.Authorization = `Bearer ${input.apiKey}`
            const networkPolicy = deps.networkPolicyFromMetadata(input)
            const response = await deps.fetchWithNetworkPolicy(discoveryUrl, { headers }, networkPolicy)
            if (!response.ok) return deps.json({ message: `Model discovery failed with HTTP ${response.status}` }, 502)
            const payload = deps.object(JSON.parse(await deps.readBoundedResponse(response, networkPolicy.maxResponseBytes ?? 4 * 1024 * 1024)))
            const models = Array.isArray(payload.data)
              ? payload.data.map((model) => deps.object(model)).map((model) => model.id).filter((id): id is string => typeof id === 'string')
              : []
            return deps.json({ models })
          } catch (error) {
            if (error instanceof deps.CustomProviderValidationError) return deps.json({ message: error.message }, 400)
            if (error instanceof deps.RequestSecurityError) return deps.json({ message: error.message }, error.status)
            console.warn(`Custom provider discovery failed: ${deps.redactedDiagnostic(error)}`)
            return deps.json({ message: 'Model discovery failed' }, 502)
          }
        }
        return deps.json({ message: 'Not found' }, 404)
      }

      const accountService = await deps.providerAccountService()

      if (path[2] === 'catalog' && request.method === 'GET' && path.length === 3) {
        const query = new URL(request.url).searchParams
        const shouldRefresh = query.get('refresh') !== 'false'
        const forceRefresh = query.get('force') === 'true' || query.get('force') === '1'
        const accounts = await accountService.listAccounts(userId)
        // Use the global catalog here so unconfigured providers remain visible
        // and users can start a login flow. The account records are still
        // scoped to this user and are the only account instances returned.
        const runtime = await deps.modelRuntimePromise

        if (shouldRefresh) {
          // Refresh the shared provider catalog when possible. A failed
          // provider refresh must not hide models already in the local catalog.
          try {
            await runtime.refresh({
              allowNetwork: true,
              force: forceRefresh,
              signal: AbortSignal.timeout(15_000),
            })
          } catch (error) {
            console.warn(`Provider catalog refresh failed: ${deps.redactedDiagnostic(error)}`)
          }
        }

        const catalog = await deps.createProviderCatalogAsync(runtime, {
          accounts: accounts.map(deps.providerCatalogAccount),
          includeRuntimeInstance: false,
          signal: AbortSignal.timeout(15_000),
        })
        return deps.json({ catalog })
      }

      if (path[2] === 'accounts') {
        if (path.length === 3 && request.method === 'GET') {
          const accounts = await accountService.listAccounts(userId)
          return deps.json({ accounts: accounts.map(deps.providerAccountInstance) })
        }
        if (path.length >= 4) {
          const wireInstanceId = path[3]
          const owned = await deps.ownedProviderAccount(userId, wireInstanceId)
          if (!owned) return deps.json({ message: 'Provider account not found' }, 404)
          if (path[4] === 'status' && request.method === 'GET' && path.length === 5) {
            const status = await accountService.getAccountStatus(userId, owned.account.instanceId)
            return deps.json({ status })
          }
          if (path.length === 4 && request.method === 'GET') return deps.json({ account: deps.providerAccountInstance(owned.account) })
          if (path.length === 4 && request.method === 'PATCH') {
            const input = await deps.body(request)
            const update: { displayName?: string; status?: 'active' | 'disabled' } = {
              ...(typeof input.displayName === 'string' ? { displayName: input.displayName } : {}),
              ...(input.status === 'active' || input.status === 'disabled' ? { status: input.status } : {}),
            }
            const updated = await accountService.updateAccount(userId, owned.account.instanceId, update)
            return updated ? deps.json({ account: deps.providerAccountInstance(updated) }) : deps.json({ message: 'Provider account not found' }, 404)
          }
          if (path.length === 4 && request.method === 'DELETE') {
            await accountService.deleteAccount(userId, owned.account.instanceId)
            return deps.json({ ok: true })
          }
        }
      }

      if (path[2] === 'login-flows') {
        const controller = await deps.providerLoginFlowController()
        if (path.length === 3 && request.method === 'POST') {
          const input = await deps.body(request)
          if (typeof input.providerInstanceId !== 'string' || typeof input.type !== 'string') return deps.json({ message: 'providerInstanceId and type are required' }, 400)
          if (input.type !== 'api_key' && input.type !== 'oauth') return deps.json({ message: 'type must be api_key or oauth' }, 400)
          const providerInstanceId = input.providerInstanceId.trim()
          if (!providerInstanceId) return deps.json({ message: 'providerInstanceId is required' }, 400)
          const parsed = deps.parseProviderRuntimeId(providerInstanceId)
          if (parsed) {
            if (!(await deps.ownedProviderAccount(userId, providerInstanceId))) return deps.json({ message: 'Provider account not found' }, 404)
          } else if (!(await deps.modelRuntimePromise).getProvider(providerInstanceId)) {
            return deps.json({ message: 'Provider not found' }, 404)
          }
          const flow = await controller.start({
            ownerId: userId,
            providerInstanceId,
            type: input.type,
            ...(typeof input.displayName === 'string' && input.displayName.trim() ? { displayName: input.displayName } : {}),
          })
          return deps.json({ flow }, 201)
        }
        if (path.length >= 4) {
          const flowId = decodeURIComponent(path[3] ?? '')
          if (path.length === 4 && request.method === 'GET') return deps.json({ status: await controller.status({ ownerId: userId, flowId }) })
          if (path.length === 5 && path[4] === 'events' && request.method === 'GET') {
            const after = url.searchParams.get('after')
            const limit = url.searchParams.get('limit')
            return deps.json(await controller.getEvents({
              ownerId: userId,
              flowId,
              ...(after === null ? {} : { after: Number(after) }),
              ...(limit === null ? {} : { limit: Number(limit) }),
            }))
          }
          if (path.length === 5 && path[4] === 'respond' && request.method === 'POST') {
            const input = await deps.body(request)
            if (typeof input.promptId !== 'string' || typeof input.value !== 'string') return deps.json({ message: 'promptId and value are required' }, 400)
            return deps.json({ status: await controller.respond({ ownerId: userId, flowId, promptId: input.promptId, value: input.value }) })
          }
          if (path.length === 5 && path[4] === 'cancel' && request.method === 'POST') {
            return deps.json({ status: await controller.cancel({ ownerId: userId, flowId }) })
          }
        }
      }
    } catch (error) {
      if (error instanceof deps.CustomProviderValidationError) return deps.json({ message: error.message }, 400)
      if (error instanceof deps.RequestSecurityError) return deps.json({ message: error.message }, error.status)
      if (error instanceof deps.ProviderLoginFlowError) {
        const status = error.code === 'FLOW_NOT_FOUND' ? 404
          : error.code === 'FLOW_EXPIRED' ? 410
            : error.code === 'INVALID_INPUT' || error.code === 'INVALID_PROMPT_RESPONSE' ? 400 : 409
        return deps.json({ message: 'Provider login request failed', code: error.code }, status)
      }
      const storageError = deps.providerLoginFlowStorageError(error)
      console.error('Provider login flow request failed', deps.redactSensitive(storageError))
      return deps.json({ message: 'Provider login storage unavailable' }, 503)
    }
  }
  return undefined
}
