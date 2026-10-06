import type { MessageWithParts, Session, Part } from '@/api/types'

export type TranscriptExportFormat = 'markdown' | 'text' | 'json'

type ExportTool = {
  name: string
  callId: string
  status: string
  input?: unknown
  result?: string
  error?: string
}

type ExportMessage = {
  id: string
  role: string
  created: number
  completed?: number
  content: string
  toolCalls: ExportTool[]
}

export type TranscriptExport = {
  session: { id: string; title: string; created: number; updated: number }
  messages: ExportMessage[]
}

const SECRET_KEY = /(pass(word)?|secret|token|api[-_]?key|authorization|cookie|credential)/i
const BEARER_TEXT = /bearer\s+[^\s,;]+/gi
const SECRET_TEXT = /((?:password|secret|token|api[-_]?key|authorization|cookie|credential)\s*[:=]\s*)[^\s,;]+/gi

function redactText(value: string): string {
  return value.replace(BEARER_TEXT, 'Bearer [REDACTED]').replace(SECRET_TEXT, '$1[REDACTED]')
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact)
  if (typeof value === 'string') return redactText(value)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, SECRET_KEY.test(key) ? '[REDACTED]' : redact(item)]))
}

function partText(parts: Part[]): string {
  return parts.filter((part) => part.type === 'text').map((part) => part.text).join('\n\n').trim()
}

function toolParts(parts: Part[]): ExportTool[] {
  return parts.filter((part): part is Extract<Part, { type: 'tool' }> => part.type === 'tool').map((part) => {
    const state = part.state
    return {
      name: part.tool,
      callId: part.callID,
      status: state.status,
      input: redact(state.input),
      ...('output' in state ? { result: redact(state.output) as string } : {}),
      ...('error' in state ? { error: redact(state.error) as string } : {}),
    }
  })
}

export function buildTranscriptExport(session: Session, messages: MessageWithParts[]): TranscriptExport {
  return {
    session: { id: session.id, title: session.title || 'Untitled Session', created: session.time.created, updated: session.time.updated },
    messages: messages.map(({ info, parts }) => ({
      id: info.id,
      role: info.role,
      created: info.time.created,
      ...('completed' in info.time && info.time.completed ? { completed: info.time.completed } : {}),
      content: partText(parts),
      toolCalls: toolParts(parts),
    })),
  }
}

const date = (value: number) => new Date(value).toISOString()

export function serializeTranscript(value: TranscriptExport, format: TranscriptExportFormat): string {
  if (format === 'json') return `${JSON.stringify(value, null, 2)}\n`
  const lines = [`${value.session.title}`, `Session: ${value.session.id}`, `Created: ${date(value.session.created)}`, '']
  value.messages.forEach((message) => {
    lines.push(`${message.role === 'user' ? 'User' : 'Assistant'} (${date(message.created)})`)
    if (message.content) lines.push(message.content)
    message.toolCalls.forEach((tool) => {
      lines.push(`Tool: ${tool.name} [${tool.status}]`)
      if (tool.input !== undefined) lines.push(`Input: ${JSON.stringify(tool.input)}`)
      if (tool.result) lines.push(`Result: ${tool.result}`)
      if (tool.error) lines.push(`Error: ${tool.error}`)
    })
    lines.push('')
  })
  if (format === 'text') return `${lines.join('\n').trim()}\n`
  return [`# ${value.session.title}`, '', `**Session:** ${value.session.id}`, `**Created:** ${date(value.session.created)}`, '', ...value.messages.flatMap((message) => [
    `## ${message.role === 'user' ? 'User' : 'Assistant'} - ${date(message.created)}`, '', message.content, ...message.toolCalls.flatMap((tool) => [
      '', `### Tool: ${tool.name}`, `Status: ${tool.status}`, tool.input === undefined ? '' : `\n**Input**\n\n\`\`\`json\n${JSON.stringify(tool.input, null, 2)}\n\`\`\``, tool.result ? `\n**Result**\n\n\`\`\`\n${tool.result}\n\`\`\`` : '', tool.error ? `\n**Error**\n\n\`\`\`\n${tool.error}\n\`\`\`` : '',
    ]), '',
  ])].join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n'
}

export function sanitizeTranscriptFilename(name: string): string {
  const safe = name.normalize('NFKD').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80)
  return safe || 'session'
}

export function downloadTranscript(content: string, filename: string, format: TranscriptExportFormat): void {
  const mime = format === 'json' ? 'application/json' : format === 'markdown' ? 'text/markdown' : 'text/plain'
  const url = URL.createObjectURL(new Blob([content], { type: `${mime};charset=utf-8` }))
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

export function exportTranscript(session: Session, messages: MessageWithParts[], format: TranscriptExportFormat) {
  const extension = format === 'text' ? 'txt' : format
  const title = sanitizeTranscriptFilename(session.title || session.id)
  const data = buildTranscriptExport(session, messages)
  return { content: serializeTranscript(data, format), filename: `${title}-${sanitizeTranscriptFilename(session.id)}.${extension}` }
}
