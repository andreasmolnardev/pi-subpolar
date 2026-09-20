import { describe, expect, it } from 'vitest'
import { mergeStoredSessionPages } from '../History'

describe('History pagination', () => {
  it('merges pages without duplicate session cards', () => {
    const session = (id: string) => ({ id, projectId: null, directory: null, title: id, createdAt: 1, updatedAt: 1, archived: false, tags: [] })

    expect(mergeStoredSessionPages([{ sessions: [session('one'), session('two')] }, { sessions: [session('two'), session('three')] }]).map((item) => item.id))
      .toEqual(['one', 'two', 'three'])
  })
})
