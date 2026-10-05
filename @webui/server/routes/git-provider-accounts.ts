import type { BridgeRequestContext } from '../bridge-route-context.ts'
import { GitProviderAccounts } from '../git/provider-accounts.ts'
import type { GitProviderId } from '../git/provider-contracts.ts'

const validProvider = (value: unknown): value is GitProviderId => value === 'github' || value === 'gitee'

export async function handleGitProviderAccountsRoute(context: BridgeRequestContext): Promise<Response | undefined> {
  const { request, path, deps } = context
  if (path[1] !== 'git' || path[2] !== 'provider-accounts') return undefined
  const owner = context.authenticatedUser?.id
  if (!owner) return deps.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401)
  try {
    const service = new GitProviderAccounts({ store: await deps.providerAccountService() })
    if (path.length === 3 && request.method === 'GET') return deps.json({ accounts: await service.list(owner) })
    if (path.length === 3 && request.method === 'POST') {
      const input = await deps.body(request)
      if (!validProvider(input.provider) || typeof input.token !== 'string') return deps.json({ error: { code: 'INVALID_REQUEST', message: 'Provider and access token are required' } }, 400)
      return deps.json({ account: await service.connect(owner, input.provider, input.token) }, 201)
    }
    if (path.length === 5 && path[4] === 'status' && request.method === 'GET') {
      const status = await service.status(owner, decodeURIComponent(path[3] ?? ''))
      return status ? deps.json({ status }) : deps.json({ error: { code: 'NOT_FOUND', message: 'Git provider account not found' } }, 404)
    }
    if (path.length === 4 && request.method === 'DELETE') {
      const removed = await service.revoke(owner, decodeURIComponent(path[3] ?? ''))
      return removed ? deps.json({ ok: true }) : deps.json({ error: { code: 'NOT_FOUND', message: 'Git provider account not found' } }, 404)
    }
    return deps.json({ error: { code: 'NOT_FOUND', message: 'Not found' } }, 404)
  } catch {
    return deps.json({ error: { code: 'GIT_PROVIDER_AUTH_FAILED', message: 'Git provider authentication failed' } }, 400)
  }
}
