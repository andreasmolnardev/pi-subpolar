import { redactSensitive, redactSensitiveText } from '../server/core/security-redaction'

export type TranscriptMessage = { info: Record<string, any>; parts: Record<string, any>[] }

type Obj = Record<string, any>
const obj = (v: unknown): Obj => v && typeof v === 'object' && !Array.isArray(v) ? v as Obj : {}
const textOf = (v: unknown): string => typeof v === 'string' ? redactSensitiveText(v) : Array.isArray(v) ? v.map((p) => { const x = obj(p); return typeof x.text === 'string' ? redactSensitiveText(x.text) : typeof x.thinking === 'string' ? redactSensitiveText(x.thinking) : '' }).join('') : ''
const argumentsOf = (v: unknown): Obj => { if (typeof v === 'string') { try { return obj(JSON.parse(v)) } catch { return { value: v } } } return obj(v) }

export function redactTranscriptPayload(value: unknown): unknown {
  const safe = redactSensitive(value)
  if (Array.isArray(safe)) return safe.map(redactTranscriptPayload)
  if (safe && typeof safe === 'object') return Object.fromEntries(Object.entries(safe).map(([key, item]) => [key, redactTranscriptPayload(item)]))
  return typeof safe === 'string' ? redactSensitiveText(safe) : safe
}

export function activeBranch(entries: unknown[], leafId: string | null | undefined): Obj[] {
  const map = new Map<string, Obj>()
  for (const value of entries) { const entry = obj(value); if (typeof entry.id === 'string') map.set(entry.id, entry) }
  const result: Obj[] = []; const seen = new Set<string>(); let id = leafId
  while (id && !seen.has(id)) {
    seen.add(id); const entry = map.get(id); if (!entry) break
    result.push(entry); id = typeof entry.parentId === 'string' ? entry.parentId : undefined
  }
  return result.reverse()
}

function toolState(result: Obj | undefined, input: Obj, timestamp: number) {
  const safeInput = redactSensitive(input) as Obj
  if (!result) return { status: 'pending', input: safeInput, raw: JSON.stringify(safeInput) }
  const output = redactSensitiveText(textOf(result.content) || (typeof result.output === 'string' ? result.output : ''))
  const metadata = redactSensitive(obj(result.details))
  const start = typeof result.startTime === 'number' ? result.startTime : timestamp
  const end = typeof result.endTime === 'number' ? result.endTime : timestamp
  if (result.isError) return { status: 'error', input: safeInput, error: output || 'Tool execution failed', metadata, time: { start, end } }
  return { status: 'completed', input: safeInput, output, title: typeof result.title === 'string' ? redactSensitiveText(result.title) : '', metadata, time: { start, end } }
}

export function projectEntries(entries: unknown[], leafId: string | null | undefined, sessionId: string, selection?: { profile?: string; model?: string }): TranscriptMessage[] {
  const branch = activeBranch(entries, leafId)
  const results = new Map<string, Obj>()
  for (const entry of branch) {
    const message = obj(entry.message)
    if (message.role === 'toolResult' && typeof message.toolCallId === 'string') results.set(message.toolCallId, message)
  }

  const messages: TranscriptMessage[] = []
  let latestUser = -1
  branch.forEach((entry, i) => { if (obj(entry.message).role === 'user') latestUser = i })

  type AssistantGroup = {
    id: string
    created: number
    completed: number
    info: Obj
    parts: Obj[]
    finish: string
    cost: number
    tokens: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number }
  }
  let assistantGroup: AssistantGroup | undefined

  const projectAssistantParts = (message: Obj, messageId: string, created: number): Obj[] => {
    const parts: Obj[] = []
    const content = Array.isArray(message.content) ? message.content : []
    content.forEach((raw: unknown, index: number) => {
      const block = obj(raw); const partId = `${messageId}:content:${index}`
      if (block.type === 'text' && typeof block.text === 'string') {
        parts.push({ id: partId, sessionID: sessionId, messageID: assistantGroup?.id ?? messageId, type: 'text', text: redactSensitiveText(block.text) })
      } else if ((block.type === 'thinking' || block.type === 'reasoning') && typeof (block.thinking ?? block.text) === 'string') {
        parts.push({ id: partId, sessionID: sessionId, messageID: assistantGroup?.id ?? messageId, type: 'reasoning', text: redactSensitiveText(block.thinking ?? block.text), time: { start: created, end: created } })
      } else if (block.type === 'toolCall') {
        const callID = typeof block.id === 'string' ? block.id : `${messageId}:tool:${index}`
        const input = argumentsOf(block.arguments)
        parts.push({ id: partId, sessionID: sessionId, messageID: assistantGroup?.id ?? messageId, type: 'tool', callID, tool: typeof block.name === 'string' ? redactSensitiveText(block.name) : 'unknown', state: toolState(results.get(callID), input, created) })
      }
    })
    return parts
  }

  const flushAssistant = () => {
    if (!assistantGroup) return
    const { id, info, parts, finish, cost, tokens } = assistantGroup
    parts.push({
      id: `${id}:step-finish`, sessionID: sessionId, messageID: id, type: 'step-finish', reason: finish, cost,
      tokens: { input: tokens.input, output: tokens.output, reasoning: tokens.reasoning, cache: { read: tokens.cacheRead, write: tokens.cacheWrite } },
    })
    messages.push({ info, parts })
    assistantGroup = undefined
  }

  branch.forEach((entry, branchIndex) => {
    const message = obj(entry.message); const role = message.role
    const id = typeof entry.id === 'string' ? entry.id : `${sessionId}:entry:${branchIndex}`
    const created = typeof message.timestamp === 'number' ? message.timestamp : (typeof entry.timestamp === 'number' ? entry.timestamp : Date.now())

    if (role === 'user') {
      flushAssistant()
      const metadata = redactSensitive(obj(message.metadata)) as Obj
      const info: Obj = { id, sessionID: sessionId, role, time: { created }, ...metadata }
      if (branchIndex === latestUser) {
        if (selection?.profile && !info.agent) info.agent = selection.profile
        if (selection?.model && !info.model) { const [providerID, ...rest] = selection.model.split('/'); info.model = { providerID, modelID: rest.join('/') } }
      }
      messages.push({ info: { ...info, content: textOf(message.content) }, parts: [{ id: `${id}:content:0`, sessionID: sessionId, messageID: id, type: 'text', text: textOf(message.content) }] })
      return
    }
    if (role !== 'assistant') return

    const metadata = redactSensitive(obj(message.metadata)) as Obj
    if (!assistantGroup) {
      assistantGroup = {
        id, created, completed: created, info: { id, sessionID: sessionId, role, time: { created } }, parts: [],
        finish: 'stop', cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      }
    }
    assistantGroup.info = { ...assistantGroup.info, ...metadata }
    assistantGroup.completed = typeof message.completedAt === 'number' ? message.completedAt : created
    if (message.modelID) assistantGroup.info.modelID = message.modelID
    if (message.providerID) assistantGroup.info.providerID = message.providerID
    assistantGroup.finish = typeof message.stopReason === 'string' ? message.stopReason : typeof message.finish === 'string' ? message.finish : assistantGroup.finish
    assistantGroup.cost += typeof message.cost === 'number' ? message.cost : 0
    const usage = obj(message.usage); const cache = obj(usage.cache)
    assistantGroup.tokens.input += typeof usage.input === 'number' ? usage.input : 0
    assistantGroup.tokens.output += typeof usage.output === 'number' ? usage.output : 0
    assistantGroup.tokens.reasoning += typeof usage.reasoning === 'number' ? usage.reasoning : 0
    assistantGroup.tokens.cacheRead += typeof usage.cacheRead === 'number' ? usage.cacheRead : typeof cache.read === 'number' ? cache.read : 0
    assistantGroup.tokens.cacheWrite += typeof usage.cacheWrite === 'number' ? usage.cacheWrite : typeof cache.write === 'number' ? cache.write : 0
    assistantGroup.parts.push(...projectAssistantParts(message, id, created))
    assistantGroup.info.time = { created: assistantGroup.created, completed: assistantGroup.completed }
  })

  flushAssistant()
  return messages
}

export function entriesPayload(value: unknown): { entries: unknown[]; leafId: string | null } {
  const root = obj(value); const data = obj(root.data ?? value)
  return { entries: Array.isArray(data.entries) ? data.entries : [], leafId: typeof data.leafId === 'string' ? data.leafId : null }
}
