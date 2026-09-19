import { describe, expect, it } from 'vitest'
import { attachmentToParts, ATTACHMENT_LIMITS, validateAttachmentLimits, validateProjectPath, validateWebsiteUrl } from './attachments'

describe('attachment helpers', () => {
  it('enforces count, type, size, and total limits', () => {
    const existing = Array.from({ length: ATTACHMENT_LIMITS.maxCount }, () => ({ size: 1 }))
    expect(validateAttachmentLimits({ size: 1, mime: 'text/plain' }, existing)).toContain('At most')
    expect(validateAttachmentLimits({ size: ATTACHMENT_LIMITS.maxFileBytes + 1, mime: 'text/plain' }, [])).toContain('10 MB')
    expect(validateAttachmentLimits({ size: 1, mime: 'application/octet-stream' }, [])).toContain('supported')
    expect(validateAttachmentLimits({ size: 2 * 1024 * 1024, mime: 'text/plain' }, [{ size: 12 * 1024 * 1024 }, { size: 12 * 1024 * 1024 }])).toContain('total')
  })

  it('rejects project paths outside the selected project', () => {
    expect(validateProjectPath('notes/readme.md', '/work/project')).toBe('/work/project/notes/readme.md')
    expect(validateProjectPath('../secrets.txt', '/work/project')).toContain('inside')
  })

  it('validates website URLs without authorizing network access in the browser', () => {
    expect(validateWebsiteUrl('javascript:alert(1)')).toContain('HTTP')
    expect(validateWebsiteUrl('https://example.com/docs')).toBeUndefined()
    expect(validateWebsiteUrl('https://user:pass@example.com')).toContain('credentials')
  })

  it('removes failed attachments by leaving conversion to ready parts only', () => {
    const parts = attachmentToParts([
      { id: 'failed', kind: 'text', name: 'bad', status: 'error', content: 'ignored' },
      { id: 'image', kind: 'image', name: 'shot.png', status: 'ready', mime: 'image/png', dataUrl: 'data:image/png;base64,AA==' },
    ])
    expect(parts).toHaveLength(1)
    expect(parts[0].type).toBe('image')
  })
})
