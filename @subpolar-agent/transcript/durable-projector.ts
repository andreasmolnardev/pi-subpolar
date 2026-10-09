import type { PiDurableTranscriptEntry } from '../../packages/subpolar-adapter-pi-durable/src/index.ts'

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

function durableEntries(transcript: readonly PiDurableTranscriptEntry[], sessionId: string): Record<string, unknown>[] {
  const projected: Record<string, unknown>[] = []
  for (const entry of transcript) {
    if (entry.kind === 'pi.system') continue
    entry.messages.forEach((message, index) => {
      const role = object(message).role
      if (role !== 'user' && role !== 'assistant' && role !== 'toolResult') return
      projected.push({
        type: 'message',
        id: `pi-durable:${sessionId}:${String(entry.id)}:${index}`,
        message,
      })
    })
  }
  return projected
}

/** Appends Durable messages after the current application transcript without replacing legacy history. */
export function mergeDurableTranscript(
  entries: readonly unknown[],
  leafId: string | null,
  transcript: readonly PiDurableTranscriptEntry[],
  sessionId: string,
): { entries: Record<string, unknown>[]; leafId: string | null } {
  const merged = entries.map((value) => object(value))
  const ids = new Set(merged.map((entry) => entry.id).filter((id): id is string => typeof id === 'string'))
  let parentId = leafId
  for (const entry of durableEntries(transcript, sessionId)) {
    if (typeof entry.id !== 'string' || ids.has(entry.id)) continue
    entry.parentId = parentId
    merged.push(entry)
    ids.add(entry.id)
    parentId = entry.id
  }
  return { entries: merged, leafId: parentId }
}
