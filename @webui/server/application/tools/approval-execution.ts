// This map is deliberately not persisted. A process restart makes the input
// unavailable, so an approved record cannot accidentally execute redacted data.
type PendingApprovalInput = { input: unknown; consumed: boolean }
export type ApprovalResolution = 'approved' | 'rejected' | 'expired'

type ApprovalWaiter = {
  resolve: (resolution: ApprovalResolution) => void
  timer: ReturnType<typeof setTimeout>
}

const pending = new Map<string, PendingApprovalInput>()
const waiters = new Map<string, ApprovalWaiter>()

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

/**
 * Register a process-local waiter for an in-flight model tool call. The
 * approval itself remains durable in PocketBase; this only avoids polling when
 * the original bridge process is still serving the call.
 */
export function waitForApprovalResolution(approvalId: string, expiresAt: number): Promise<ApprovalResolution> {
  const existing = waiters.get(approvalId)
  if (existing) throw new Error(`Approval ${approvalId} already has a waiting execution`)

  return new Promise<ApprovalResolution>((resolve) => {
    const delay = Math.max(0, expiresAt - Date.now())
    const timer = setTimeout(() => {
      if (waiters.get(approvalId)?.resolve !== resolve) return
      waiters.delete(approvalId)
      resolve('expired')
    }, delay)
    timer.unref?.()
    waiters.set(approvalId, { resolve, timer })
  })
}

export function hasPendingApprovalWaiter(approvalId: string): boolean {
  return waiters.has(approvalId)
}

export function notifyApprovalResolution(approvalId: string, resolution: ApprovalResolution): boolean {
  const waiter = waiters.get(approvalId)
  if (!waiter) return false
  waiters.delete(approvalId)
  clearTimeout(waiter.timer)
  waiter.resolve(resolution)
  return true
}
