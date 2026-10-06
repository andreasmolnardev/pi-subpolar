import { describe, expect, it } from 'vitest'
import { GitProviderError } from './provider-contracts.ts'
import { GiteaProvider, GitHubProvider, type GitProviderFetch } from './providers.ts'

const secret = 'test-token-that-must-never-escape'
const jsonResponse = (value: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' }, ...init })
const options = (fetch: GitProviderFetch, extra: { timeoutMs?: number; maxResponseBytes?: number } = {}) => ({ tokenSource: () => secret, fetch, ...extra })

describe('remote Git provider foundation', () => {
  it('exposes typed capabilities and maps GitHub repository metadata', async () => {
    let requestedUrl = ''
    const provider = new GitHubProvider(options(async (url) => {
      requestedUrl = url.toString()
      return jsonResponse({ id: 5, full_name: 'acme/project', name: 'project', owner: { login: 'acme' }, description: secret, default_branch: 'main', html_url: 'https://github.com/acme/project', private: true })
    }))
    expect(provider.discoverCapabilities()).toEqual({ repoMetadata: true, branches: true, issues: true, comments: true, pullRequests: true, statuses: true, createPullRequest: true })
    const repository = await provider.getRepository({ owner: 'acme', repo: 'project' })
    expect(repository).toMatchObject({ owner: 'acme', name: 'project', defaultBranch: 'main', description: '[REDACTED]' })
    expect(JSON.stringify(repository)).not.toContain(secret)
    expect(new URL(requestedUrl).host).toBe('api.github.com')
    expect(requestedUrl).not.toContain(secret)
  })

  it('uses the Gitea v1 API, token authorization, and Gitea response fields', async () => {
    let requestUrl = ''
    let authorization = ''
    const provider = new GiteaProvider(options(async (url, init) => {
      requestUrl = url.toString()
      authorization = new Headers(init?.headers).get('authorization') ?? ''
      return jsonResponse([{ name: 'main', commit: { id: 'abc' }, protected: false }])
    }))
    const branches = await provider.listBranches({ owner: 'team', repo: 'repo' })
    expect(branches).toEqual([{ name: 'main', sha: 'abc', protected: false }])
    expect(JSON.stringify(branches)).not.toContain(secret)
    expect(new URL(requestUrl).host).toBe('gitea.com')
    expect(new URL(requestUrl).pathname).toBe('/api/v1/repos/team/repo/branches')
    expect(new URL(requestUrl).searchParams.get('limit')).toBe('50')
    expect(authorization).toBe(`token ${secret}`)
  })

  it('maps Gitea repository and issue usernames', async () => {
    const provider = new GiteaProvider(options(async (url) => url.pathname.endsWith('/issues')
      ? jsonResponse([{ id: 4, number: 3, title: 'Issue', body: null, state: 'open', html_url: 'https://gitea.com/team/repo/issues/3', user: { username: 'reporter' } }])
      : jsonResponse({ id: 9, full_name: 'team/repo', name: 'repo', owner: { username: 'team' }, description: null, default_branch: 'main', html_url: 'https://gitea.com/team/repo', private: false })))
    expect(await provider.getRepository({ owner: 'team', repo: 'repo' })).toMatchObject({ owner: 'team', fullName: 'team/repo' })
    expect(await provider.listIssues({ owner: 'team', repo: 'repo' })).toMatchObject([{ user: 'reporter', number: 3 }])
  })

  it('supports create-PR without accepting a remote URL as repository identity', async () => {
    let posted: unknown
    const provider = new GitHubProvider(options(async (url, init) => {
      expect(url.host).toBe('api.github.com')
      posted = JSON.parse(String(init?.body))
      return jsonResponse({ id: 1, number: 2, title: 'Change', body: null, state: 'open', html_url: 'https://github.com/o/r/pull/2', head: { ref: 'feature', sha: 'head-sha' }, base: { ref: 'main' }, merged: false })
    }))
    const result = await provider.createPullRequest({ owner: 'o', repo: 'r' }, { title: 'Change', head: 'feature', base: 'main' })
    expect(result.number).toBe(2)
    expect(result.headSha).toBe('head-sha')
    expect(posted).toEqual({ title: 'Change', head: 'feature', base: 'main', body: '', draft: false })
    await expect(provider.getRepository({ owner: 'https://evil.test', repo: 'r' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  })

  it('sanitizes upstream failures and token-source errors without leaking the token', async () => {
    for (const fetch of [
      async () => { throw new Error(`fetch exposed ${secret}`) },
      async () => new Response('redirect', { status: 302, headers: { location: 'https://evil.test' } }),
    ] as GitProviderFetch[]) {
      const provider = new GitHubProvider(options(fetch))
      let caught: unknown
      try { await provider.getRepository({ owner: 'o', repo: 'r' }) } catch (error) { caught = error }
      expect(caught).toBeInstanceOf(GitProviderError)
      expect(String(caught)).not.toContain(secret)
    }
    for (const failure of [new Error(secret), new GitProviderError('UNAUTHORIZED', `credential failure ${secret}`)]) {
      const provider = new GitHubProvider({ tokenSource: () => { throw failure }, fetch: async () => jsonResponse({}) })
      let caught: unknown
      try { await provider.getRepository({ owner: 'o', repo: 'r' }) } catch (error) { caught = error }
      expect(caught).toMatchObject({ code: 'UNAUTHORIZED', message: 'Git provider credentials are unavailable' })
      expect(String(caught)).not.toContain(secret)
    }
  })

  it('bounds response size and request time, returning only sanitized errors', async () => {
    const oversized = new GitHubProvider(options(async () => jsonResponse({ payload: 'x'.repeat(100) }), { maxResponseBytes: 32 }))
    await expect(oversized.getRepository({ owner: 'o', repo: 'r' })).rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE' })
    const hanging = new GitHubProvider(options((_url, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error(secret)), { once: true })), { timeoutMs: 5 }))
    let error: unknown
    try { await hanging.getRepository({ owner: 'o', repo: 'r' }) } catch (caught) { error = caught }
    expect(error).toMatchObject({ code: 'TIMEOUT' })
    expect(String(error)).not.toContain(secret)
  })
})
