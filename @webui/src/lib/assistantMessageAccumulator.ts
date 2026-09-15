export type AssistantContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'toolCall'; id?: string; name?: string; arguments: Record<string, unknown> | string }

export type AssistantMessage = {
  role: 'assistant'
  content: AssistantContentBlock[]
  [key: string]: unknown
}

export type AssistantMessageEvent = {
  type?: string
  contentIndex?: number
  delta?: string
  text?: string
  thinking?: string
  toolCall?: { id?: string; name?: string; arguments?: Record<string, unknown> | string }
  toolCallId?: string
  toolName?: string
  name?: string
  [key: string]: unknown
}

const streamTypes = new Set(['text_start', 'text_delta', 'text_end', 'thinking_start', 'thinking_delta', 'thinking_end', 'toolcall_start', 'toolcall_delta', 'toolcall_end'])
const object = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {}

/** Reconstructs Pi's incremental assistant message without inspecting its words. */
export class AssistantMessageAccumulator {
  private message: AssistantMessage = { role: 'assistant', content: [] }
  private blocks = new Map<number, AssistantContentBlock>()
  private order: number[] = []

  constructor(initial?: AssistantMessage) { this.reset(initial) }

  reset(initial?: AssistantMessage): AssistantMessage {
    this.message = { role: 'assistant', ...(initial ?? {}), content: [] }
    this.blocks.clear(); this.order = []
    if (Array.isArray(initial?.content)) initial.content.forEach((block, index) => this.setBlock(index, block))
    return this.value()
  }

  apply(event: AssistantMessageEvent): AssistantMessage {
    if (!streamTypes.has(String(event.type))) {
      const cumulative = object(event.message)
      if (Array.isArray(cumulative.content)) this.reset(cumulative as AssistantMessage)
      return this.value()
    }
    const index = typeof event.contentIndex === 'number' ? event.contentIndex : 0
    const type = String(event.type)
    let block = this.blocks.get(index)
    if (type.startsWith('thinking')) {
      if (!block || block.type !== 'thinking') block = { type: 'thinking', thinking: '' }
      if (type === 'thinking_delta') block = { ...block, thinking: block.thinking + String(event.delta ?? '') }
      if (type === 'thinking_end' && event.thinking !== undefined) block = { ...block, thinking: String(event.thinking) }
    } else if (type.startsWith('text')) {
      if (!block || block.type !== 'text') block = { type: 'text', text: '' }
      if (type === 'text_delta') block = { ...block, text: block.text + String(event.delta ?? '') }
      if (type === 'text_end' && event.text !== undefined) block = { ...block, text: String(event.text) }
    } else {
      const call = object(event.toolCall)
      if (!block || block.type !== 'toolCall') block = { type: 'toolCall', id: undefined, name: undefined, arguments: '' }
      const argumentDelta = type === 'toolcall_delta' ? String(event.delta ?? '') : ''
      const existing = typeof block.arguments === 'string' ? block.arguments : JSON.stringify(block.arguments)
      const args = type === 'toolcall_end' && call.arguments !== undefined ? call.arguments : existing + argumentDelta
      block = { ...block, id: call.id ?? event.toolCallId ?? block.id, name: call.name ?? event.toolName ?? event.name ?? block.name, arguments: args }
      if (type === 'toolcall_start' && call.arguments !== undefined) block = { ...block, arguments: call.arguments }
    }
    this.setBlock(index, block)
    return this.value()
  }

  finalize(message: AssistantMessage): AssistantMessage { return this.reset(message) }

  value(): AssistantMessage {
    return { ...this.message, content: this.order.map(index => this.blocks.get(index)!).filter(Boolean) }
  }

  private setBlock(index: number, block: AssistantContentBlock): void {
    if (!this.blocks.has(index)) {
      this.order.push(index)
      this.order.sort((a, b) => a - b)
    }
    this.blocks.set(index, block)
  }
}

export function createAssistantMessageAccumulator(initial?: AssistantMessage) { return new AssistantMessageAccumulator(initial) }
