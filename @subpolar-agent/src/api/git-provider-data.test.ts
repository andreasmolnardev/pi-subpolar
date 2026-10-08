import { describe, expect, it, vi } from 'vitest'

const fetchMock = vi.hoisted(() => vi.fn(async (url: string) => ({ url })))
vi.mock('./fetchWrapper', () => ({ fetchWrapper: fetchMock }))

import { API_BASE_URL } from '@/config'
import { gitProviderDataApi } from './git-provider-data'

describe('gitProviderDataApi', () => {
  it('encodes account, repository, issue, and SHA path segments for read-only routes', async () => {
    const mapping = { accountId: 'account/id', owner: 'org name', repo: 'repo/name' }
    await gitProviderDataApi.repository(mapping)
    await gitProviderDataApi.branches(mapping)
    await gitProviderDataApi.issues(mapping)
    await gitProviderDataApi.pulls(mapping)
    await gitProviderDataApi.comments(mapping, 42)
    await gitProviderDataApi.statuses(mapping, 'sha/a b')
    const root = `${API_BASE_URL}/api/git/provider-accounts/account%2Fid/repos/org%20name/repo%2Fname`
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `${root}/repository`, `${root}/branches`, `${root}/issues`, `${root}/pulls`,
      `${root}/issues/42/comments`, `${root}/statuses/sha%2Fa%20b`,
    ])
    expect(fetchMock).toHaveBeenCalledTimes(6)
  })
})
