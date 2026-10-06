import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

// The map is only a fast path. Durable continuations use an encrypted payload
// stored beside the redacted approval projection in PocketBase.
type PendingApprovalInput = { input: unknown; consumed: boolean }

function approvalKey(): Buffer | undefined {
  const configured = process.env.SUBPOLAR_APPROVAL_KEY?.trim() || process.env.POCKETBASE_PASSWORD?.trim() || process.env.ADMIN_PASSWORD?.trim()
  return configured ? createHash('sha256').update(configured).digest() : undefined
}

export function encryptApprovalInput(input: unknown): string | undefined {
  const key = approvalKey()
  if (!key) return undefined
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(input), 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [iv, tag, ciphertext].map((value) => value.toString('base64url')).join('.')
}

export function decryptApprovalInput(value: unknown): unknown | undefined {
  const key = approvalKey()
  if (!key || typeof value !== 'string') return undefined
  try {
    const [ivText, tagText, ciphertextText] = value.split('.')
    if (!ivText || !tagText || !ciphertextText) return undefined
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivText, 'base64url'))
    decipher.setAuthTag(Buffer.from(tagText, 'base64url'))
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(ciphertextText, 'base64url')), decipher.final()]).toString('utf8'))
  } catch {
    return undefined
  }
}
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
