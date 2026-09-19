export type TranscriptMessage = { info: Record<string, any>; parts: Record<string, any>[] }

type Obj = Record<string, any>
const obj = (v: unknown): Obj => v && typeof v === 'object' && !Array.isArray(v) ? v as Obj : {}
const textOf = (v: unknown): string => typeof v === 'string' ? v : Array.isArray(v) ? v.map((p) => { const x = obj(p); return typeof x.text === 'string' ? x.text : typeof x.thinking === 'string' ? x.thinking : '' }).join('') : ''
const argumentsOf = (v: unknown): Obj => { if (typeof v === 'string') { try { return obj(JSON.parse(v)) } catch { return { value: v } } } return obj(v) }

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
  if (!result) return { status: 'pending', input, raw: JSON.stringify(input) }
  const output = textOf(result.content) || (typeof result.output === 'string' ? result.output : '')
  const metadata = obj(result.details)
  const start = typeof result.startTime === 'number' ? result.startTime : timestamp
  const end = typeof result.endTime === 'number' ? result.endTime : timestamp
  if (result.isError) return { status: 'error', input, error: output || 'Tool execution failed', metadata, time: { start, end } }
  return { status: 'completed', input, output, title: typeof result.title === 'string' ? result.title : '', metadata, time: { start, end } }
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
  branch.forEach((entry, branchIndex) => {
    const message = obj(entry.message); const role = message.role
    if (role !== 'user' && role !== 'assistant') return
    const id = typeof entry.id === 'string' ? entry.id : `${sessionId}:entry:${branchIndex}`
    const created = typeof message.timestamp === 'number' ? message.timestamp : (typeof entry.timestamp === 'number' ? entry.timestamp : Date.now())
    const parts: Obj[] = []; const content = Array.isArray(message.content) ? message.content : []
    content.forEach((raw: unknown, index: number) => {
      const block = obj(raw); const partId = `${id}:content:${index}`
      if (block.type === 'text' && typeof block.text === 'string') {
        parts.push({ id: partId, sessionID: sessionId, messageID: id, type: 'text', text: block.text })
      }
      else if ((block.type === 'thinking' || block.type === 'reasoning') && typeof (block.thinking ?? block.text) === 'string') parts.push({ id: partId, sessionID: sessionId, messageID: id, type: 'reasoning', text: block.thinking ?? block.text, time: { start: created, end: created } })
      else if (block.type === 'toolCall') {
        const callID = typeof block.id === 'string' ? block.id : `${id}:tool:${index}`
        const input = argumentsOf(block.arguments)
        parts.push({ id: partId, sessionID: sessionId, messageID: id, type: 'tool', callID, tool: typeof block.name === 'string' ? block.name : 'unknown', state: toolState(results.get(callID), input, created) })
      }
    })
    const metadata = obj(message.metadata)
    const info: Obj = { id, sessionID: sessionId, role, time: { created }, ...metadata }
    if (role === 'user' && branchIndex === latestUser) {
      if (selection?.profile && !info.agent) info.agent = selection.profile
      if (selection?.model && !info.model) { const [providerID, ...rest] = selection.model.split('/'); info.model = { providerID, modelID: rest.join('/') } }
    }
    if (role === 'assistant') {
      info.time = { created, completed: typeof message.completedAt === 'number' ? message.completedAt : created }
      if (message.modelID) info.modelID = message.modelID
      if (message.providerID) info.providerID = message.providerID
      const usage = obj(message.usage); const cache = obj(usage.cache)
      const finish = typeof message.stopReason === 'string' ? message.stopReason : typeof message.finish === 'string' ? message.finish : 'stop'
      parts.push({ id: `${id}:step-finish`, sessionID: sessionId, messageID: id, type: 'step-finish', reason: finish, cost: typeof message.cost === 'number' ? message.cost : 0, tokens: { input: usage.input ?? 0, output: usage.output ?? 0, reasoning: usage.reasoning ?? 0, cache: { read: usage.cacheRead ?? cache.read ?? 0, write: usage.cacheWrite ?? cache.write ?? 0 } } })
    }
    messages.push({ info: { ...info, ...(role === 'user' ? { content: textOf(message.content) } : {}) }, parts })
  })
  return messages
}

export function entriesPayload(value: unknown): { entries: unknown[]; leafId: string | null } {
  const root = obj(value); const data = obj(root.data ?? value)
  return { entries: Array.isArray(data.entries) ? data.entries : [], leafId: typeof data.leafId === 'string' ? data.leafId : null }
}
