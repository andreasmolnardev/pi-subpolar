import type { BridgeRequestContext } from '../bridge-route-context.ts'
import { GitProviderError, type GitProviderId, type GitProviderRepositoryRef } from '../git/provider-contracts.ts'
import { GiteeProvider, GitHubProvider, type GitProviderFetch } from '../git/providers.ts'

const providerId = (value: unknown): GitProviderId | undefined => value === 'git:github' ? 'github' : value === 'git:gitee' ? 'gitee' : undefined
const segmentPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/
const accountIdPattern = /^[A-Za-z0-9_-]{1,300}$/
const shaPattern = /^[A-Za-z0-9._-]{1,128}$/
const PAGE_CAP = 100

type Operation = 'repository' | 'branches' | 'issues' | 'pulls' | 'comments' | 'statuses'

function decodeSegment(value: string | undefined): string | null {
  if (typeof value !== 'string') return null
  try {
    const decoded = decodeURIComponent(value)
    return decoded === value && segmentPattern.test(decoded) ? decoded : null
  } catch {
    return null
  }
}

function providerErrorResponse(deps: BridgeRequestContext['deps'], error: unknown): Response {
  if (error instanceof GitProviderError) {
    const statuses: Record<GitProviderError['code'], number> = {
      INVALID_REQUEST: 400, UNAUTHORIZED: 502, NOT_FOUND: 404, RATE_LIMITED: 429,
      UPSTREAM_ERROR: 502, TIMEOUT: 504, RESPONSE_TOO_LARGE: 502, INVALID_RESPONSE: 502,
    }
    return deps.json({ error: { code: error.code, message: error.message } }, statuses[error.code])
  }
  return deps.json({ error: { code: 'GIT_PROVIDER_UNAVAILABLE', message: 'Git provider data is unavailable' } }, 503)
}

export async function handleGitProviderDataRoute(context: BridgeRequestContext): Promise<Response | undefined> {
  const { request, path, deps, authenticatedUser } = context
  if (path[1] !== 'git' || path[2] !== 'provider-accounts' || path[4] !== 'repos') return undefined
  if (request.method !== 'GET') return deps.json({ error: { code: 'METHOD_NOT_ALLOWED', message: 'Read-only GET access is required' } }, 405)
  const ownerId = authenticatedUser?.id
  if (!ownerId) return deps.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401)

  const accountId = path[3] ?? ''
  const owner = decodeSegment(path[5])
  const repo = decodeSegment(path[6])
  if (!accountIdPattern.test(accountId) || !owner || !repo) {
    return deps.json({ error: { code: 'INVALID_REQUEST', message: 'Invalid Git repository reference' } }, 400)
  }

  let operation: Operation
  let extra: string | undefined
  if (path.length === 8 && ['repository', 'branches', 'issues', 'pulls'].includes(path[7] ?? '')) {
    operation = path[7] as Operation
  } else if (path.length === 10 && path[7] === 'issues' && path[9] === 'comments') {
    operation = 'comments'
    extra = path[8]
    if (!/^[1-9][0-9]{0,8}$/.test(extra)) return deps.json({ error: { code: 'INVALID_REQUEST', message: 'Invalid issue number' } }, 400)
  } else if (path.length === 9 && path[7] === 'statuses') {
    operation = 'statuses'
    extra = path[8]
    if (!shaPattern.test(extra ?? '')) return deps.json({ error: { code: 'INVALID_REQUEST', message: 'Invalid commit identifier' } }, 400)
  } else {
    return deps.json({ error: { code: 'NOT_FOUND', message: 'Not found' } }, 404)
  }

  try {
    const accounts = await deps.providerAccountService()
    const account = await accounts.getAccount(ownerId, accountId)
    const provider = providerId(account?.providerType)
    if (!account || !provider || account.status !== 'active' || account.authType !== 'api_key' || !account.hasCredential) {
      return deps.json({ error: { code: 'NOT_FOUND', message: 'Git provider account not found' } }, 404)
    }
    const credential = await accounts.loadCredential(ownerId, accountId)
    if (!credential || credential.type !== 'api_key' || typeof credential.key !== 'string' || !credential.key.trim()) {
      return deps.json({ error: { code: 'NOT_FOUND', message: 'Git provider account not found' } }, 404)
    }

    const token = credential.key
    const options = { tokenSource: (requested: GitProviderId) => requested === provider ? token : undefined, ...(deps.gitProviderFetch ? { fetch: deps.gitProviderFetch as GitProviderFetch } : {}) }
    const adapter = provider === 'github' ? new GitHubProvider(options) : new GiteeProvider(options)
    const ref: GitProviderRepositoryRef = { owner, repo }
    if (operation === 'repository') return deps.json({ repository: await adapter.getRepository(ref, request.signal) })
    const items = operation === 'branches' ? await adapter.listBranches(ref, request.signal)
      : operation === 'issues' ? await adapter.listIssues(ref, request.signal)
      : operation === 'pulls' ? await adapter.listPullRequests(ref, request.signal)
      : operation === 'comments' ? await adapter.listComments(ref, Number(extra), request.signal)
      : await adapter.listStatuses(ref, extra!, request.signal)
    const collectionKey = operation === 'branches' ? 'branches' : operation === 'issues' ? 'issues' : operation === 'pulls' ? 'pulls' : operation === 'comments' ? 'comments' : 'statuses'
    return deps.json({ [collectionKey]: items, truncated: items.length >= PAGE_CAP })
  } catch (error) {
    return providerErrorResponse(deps, error)
  }
}
