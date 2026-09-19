export type AttachmentKind = 'file' | 'image' | 'website' | 'text'
export type AttachmentStatus = 'loading' | 'ready' | 'error'

export type ChatAttachment = {
  id: string
  kind: AttachmentKind
  name: string
  status: AttachmentStatus
  error?: string
  size?: number
  mime?: string
  path?: string
  dataUrl?: string
  content?: string
  url?: string
  contextOnly?: boolean
}

export const ATTACHMENT_LIMITS = {
  maxCount: 8,
  maxFileBytes: 10 * 1024 * 1024,
  maxTotalBytes: 25 * 1024 * 1024,
  largePasteChars: 500,
} as const

const ALLOWED_FILE_TYPES = /^(text\/|application\/(json|javascript|xml|pdf)|image\/)/i

export function validateAttachmentLimits(
  candidate: Pick<ChatAttachment, 'size' | 'mime'>,
  existing: readonly Pick<ChatAttachment, 'size'>[],
): string | undefined {
  if (existing.length >= ATTACHMENT_LIMITS.maxCount) return `At most ${ATTACHMENT_LIMITS.maxCount} attachments are allowed`
  if ((candidate.size ?? 0) > ATTACHMENT_LIMITS.maxFileBytes) return 'Attachment exceeds the 10 MB limit'
  const total = existing.reduce((sum, item) => sum + (item.size ?? 0), 0) + (candidate.size ?? 0)
  if (total > ATTACHMENT_LIMITS.maxTotalBytes) return 'Attachments exceed the 25 MB total limit'
  if (candidate.mime && !ALLOWED_FILE_TYPES.test(candidate.mime)) return 'This file type is not supported'
  return undefined
}

export function validateProjectPath(path: string, projectDirectory: string): string | undefined {
  const candidate = path.trim()
  if (!candidate || candidate.includes('\0')) return 'A file path is required'
  const root = projectDirectory.replace(/[\\/]+$/, '')
  const normalized = candidate.replaceAll('\\', '/')
  const absolute = normalized.startsWith('/') ? normalized : `${root}/${normalized}`
  const parts: string[] = []
  for (const part of absolute.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (!parts.length) return 'File path must stay inside the selected project'
      parts.pop()
    } else parts.push(part)
  }
  const resolved = `/${parts.join('/')}`
  const rootResolved = `/${root.replace(/^\/+/, '').replaceAll('\\', '/')}`
  if (resolved !== rootResolved && !resolved.startsWith(`${rootResolved}/`)) return 'File path must stay inside the selected project'
  return resolved
}

export function validateWebsiteUrl(value: string): string | undefined {
  try {
    const url = new URL(value.trim())
    if (!['http:', 'https:'].includes(url.protocol)) return 'Only HTTP(S) websites are allowed'
    if (url.username || url.password) return 'Website URLs cannot contain credentials'
    return undefined
  } catch {
    return 'Enter a valid website URL'
  }
}

export function attachmentToParts(attachments: readonly ChatAttachment[]) {
  return attachments.filter((item) => item.status === 'ready').flatMap((item) => {
    if (item.kind === 'image' && item.dataUrl) return [{ type: 'image' as const, id: item.id, filename: item.name, mime: item.mime ?? 'image/*', dataUrl: item.dataUrl }]
    if (item.kind === 'file' && item.path) return [{ type: 'file' as const, path: item.path, name: item.name }]
    if ((item.kind === 'text' || item.kind === 'website') && item.content) {
      return [{ type: 'text' as const, content: `<context name="${item.name}">\n${item.content}\n</context>` }]
    }
    return []
  })
}
