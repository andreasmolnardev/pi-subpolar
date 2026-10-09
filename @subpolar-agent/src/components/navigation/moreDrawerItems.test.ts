import { describe, it, expect } from 'vitest'
import { buildMoreItems, buildNavModel } from './moreDrawerItems'

describe('buildMoreItems', () => {
  it('returns the history item on the project list route', () => {
    const items = buildMoreItems('/')
    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({ key: 'history', label: 'History', to: '/history' })
    expect(items[1]).toMatchObject({ key: 'automations', label: 'Automations', to: '/automations' })
  })

  it('returns the history item for project and session routes', () => {
    expect(buildMoreItems('/projects/42')).toEqual(buildMoreItems('/projects/42/sessions/abc'))
    expect(buildMoreItems('/projects/42')[0]).toMatchObject({ key: 'history', to: '/history' })
  })

  it('keeps Automations available in the more drawer', () => {
    expect(buildMoreItems('/history')).toMatchObject([{ key: 'automations', to: '/automations' }])
    expect(buildMoreItems('/automations')).toMatchObject([{ key: 'automations', to: '/automations' }])
    expect(buildMoreItems('/unknown/path')).toMatchObject([{ key: 'automations', to: '/automations' }])
  })
})

describe('buildNavModel', () => {
  it('returns the new-project CTA for the project list route', () => {
    const model = buildNavModel('/')
    expect(model.primary).toHaveLength(1)
    expect(model.primary[0]).toMatchObject({ key: 'new-project', onSelect: 'new-repo', variant: 'primary' })
  })

  it('returns the new-session CTA for project and session routes', () => {
    for (const pathname of ['/projects/5', '/projects/5/sessions/abc', '/history']) {
      const model = buildNavModel(pathname)
      expect(model.primary).toHaveLength(1)
      expect(model.primary[0]).toMatchObject({ key: 'new-session', onSelect: 'new-session', variant: 'primary' })
    }
  })

  it('returns no primary CTA for other routes', () => {
    expect(buildNavModel('/automations').primary).toEqual([])
    expect(buildNavModel('/unknown/path').primary).toEqual([])
  })

  it('preserves the buildMoreItems compatibility wrapper', () => {
    expect(buildNavModel('/projects/42').items).toEqual(buildMoreItems('/projects/42'))
  })
})
