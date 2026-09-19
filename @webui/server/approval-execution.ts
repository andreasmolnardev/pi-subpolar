type PendingApproval = { input: unknown; consumed: boolean }

// This map is deliberately not persisted. A process restart makes the input
// unavailable, so an approved record cannot accidentally execute redacted data.
const pending = new Map<string, PendingApproval>()

export function retainPendingApprovalInput(approvalId: string, input: unknown): void {
  pending.set(approvalId, { input: structuredClone(input), consumed: false })
}

export function takePendingApprovalInput(approvalId: string): unknown | undefined {
  const entry = pending.get(approvalId)
  if (!entry || entry.consumed) return undefined
  entry.consumed = true
  return entry.input
}

export function discardPendingApprovalInput(approvalId: string): void {
  pending.delete(approvalId)
}
