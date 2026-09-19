import type PocketBase from 'pocketbase'
import { escapeFilter } from './pocketbase'

export const APPROVAL_COLLECTION = 'tool_approvals'
export const DEFAULT_APPROVAL_EXPIRATION_MS = 5 * 60 * 1000

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired'

export type ApprovalOwner = {
  userId: string
  agentId?: string
  sessionId?: string
}

export type CreateApprovalInput = {
  userId: string
  agentId: string
  sessionId?: string
  toolId: string
  input: unknown
  reason: string
}

/**
 * The approval record returned by this module. `expires_at` is derived from
 * `created_at` when the existing PocketBase collection has no expiry field.
 */
export type ApprovalFlowApproval = {
  id: string
  user_id: string
  agent_id: string
  session_id?: string
  tool_id: string
  input: unknown
  status: ApprovalStatus
  reason: string
  created_at: number
  resolved_at?: number
  expires_at: number
}

export type ApprovalFlowErrorCode =
  | 'APPROVAL_NOT_FOUND'
  | 'APPROVAL_FORBIDDEN'
  | 'APPROVAL_INVALID_DECISION'

export type ApprovalFlowError = {
  code: ApprovalFlowErrorCode
  message: string
}

export type ApprovalFlowFailure = {
  ok: false
  state: 'not_found' | 'forbidden' | 'invalid'
  error: ApprovalFlowError
}

export type ApprovalCreateResult = {
  ok: true
  state: 'pending'
  approval: ApprovalFlowApproval
  approvalId: string
}

export type ApprovalPendingResult = {
  ok: true
  approvals: ApprovalFlowApproval[]
}

export type ApprovalTerminalResult = {
  ok: true
  state: 'approved' | 'rejected' | 'expired'
  approval: ApprovalFlowApproval
}

export type ApprovalResolveResult = ApprovalTerminalResult | ApprovalFlowFailure

export type ApprovalContinueResult<T> =
  | ApprovalFlowFailure
  | { ok: true; state: 'pending'; approval: ApprovalFlowApproval }
  | { ok: true; state: 'approved'; approval: ApprovalFlowApproval }
  | { ok: true; state: 'continued'; approval: ApprovalFlowApproval; result: T }
  | { ok: true; state: 'rejected' | 'expired'; approval: ApprovalFlowApproval }

export type ApprovalFlowOptions = {
  /**
   * The TTL used for records that do not have a persisted `expires_at` field.
   * All bridge processes handling the same approval store should use the same
   * value because the current collection stores `created_at`, not the TTL.
   */
  expirationMs?: number
  now?: () => number
}

export type ContinueApproval = <T>(
  owner: ApprovalOwner,
  approvalId: string,
  resume?: (approval: ApprovalFlowApproval) => Promise<T> | T,
) => Promise<ApprovalContinueResult<T>>

type PocketBaseRecord = Record<string, unknown> & { id?: unknown }
export type ApprovalDecision = boolean | 'approve' | 'approved' | 'reject' | 'rejected'
type ExistingApproval = { record: PocketBaseRecord } | { record: null; state: 'not_found' | 'forbidden' }

function recordObject(value: unknown): PocketBaseRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as PocketBaseRecord
    : {}
}

function isNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const candidate = error as { status?: unknown; message?: unknown }
  if (candidate.status === 404) return true
  return typeof candidate.message === 'string' && /not found|does not exist/i.test(candidate.message)
}

function statusOf(record: PocketBaseRecord): ApprovalStatus {
  const status = String(record.status ?? '')
  return status === 'approved' || status === 'rejected' || status === 'expired' ? status : 'pending'
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function ownerIsValid(owner: ApprovalOwner): boolean {
  return owner.userId.trim().length > 0
}

function recordBelongsToOwner(record: PocketBaseRecord, owner: ApprovalOwner): boolean {
  if (String(record.user_id ?? '') !== owner.userId) return false
  if (owner.agentId !== undefined && String(record.agent_id ?? '') !== owner.agentId) return false
  if (owner.sessionId !== undefined && String(record.session_id ?? '') !== owner.sessionId) return false
  return true
}

function decisionValue(decision: ApprovalDecision): boolean | null {
  if (decision === true || decision === 'approve' || decision === 'approved') return true
  if (decision === false || decision === 'reject' || decision === 'rejected') return false
  return null
}

function failure(state: ApprovalFlowFailure['state'], code: ApprovalFlowErrorCode, message: string): ApprovalFlowFailure {
  return { ok: false, state, error: { code, message } }
}

export class ApprovalFlowService {
  private readonly expirationMs: number
  private readonly now: () => number

  constructor(private readonly client: PocketBase, options: ApprovalFlowOptions = {}) {
    this.expirationMs = options.expirationMs ?? DEFAULT_APPROVAL_EXPIRATION_MS
    if (!Number.isFinite(this.expirationMs) || this.expirationMs <= 0) {
      throw new RangeError('Approval expirationMs must be a positive finite number')
    }
    this.now = options.now ?? Date.now
  }

  /** Create a durable pending approval and return immediately. */
  async create(input: CreateApprovalInput): Promise<ApprovalCreateResult> {
    if (!input.userId.trim() || !input.agentId.trim() || !input.toolId.trim()) {
      throw new TypeError('Approval userId, agentId, and toolId are required')
    }

    const createdAt = this.now()
    const data = {
      user_id: input.userId,
      agent_id: input.agentId,
      ...(input.sessionId === undefined ? {} : { session_id: input.sessionId }),
      tool_id: input.toolId,
      input: input.input,
      status: 'pending',
      reason: input.reason,
      created_at: createdAt,
    }
    const record = await this.client.collection(APPROVAL_COLLECTION).create(data)
    const approval = this.toApproval(record)
    return { ok: true, state: 'pending', approval, approvalId: approval.id }
  }

  /**
   * List only pending approvals visible to the owner. Expired records are
   * transitioned in PocketBase and omitted from the response.
   */
  async pending(owner: ApprovalOwner, sessionId = owner.sessionId): Promise<ApprovalPendingResult> {
    this.assertOwner(owner)
    const filters = [`user_id = "${escapeFilter(owner.userId)}"`, 'status = "pending"']
    if (sessionId !== undefined) filters.push(`session_id = "${escapeFilter(sessionId)}"`)

    const records = await this.client.collection(APPROVAL_COLLECTION).getFullList({
      filter: filters.join(' && '),
      sort: '-created_at',
    })
    const approvals: ApprovalFlowApproval[] = []
    for (const value of records) {
      const record = recordObject(value)
      if (!recordBelongsToOwner(record, { ...owner, ...(sessionId === undefined ? {} : { sessionId }) })) continue
      if (this.isExpired(record)) {
        const expired = await this.expire(record)
        if (expired) continue
      }
      approvals.push(this.toApproval(record))
    }
    return { ok: true, approvals }
  }

  /** Resolve a pending approval without waiting for the caller that created it. */
  async resolve(owner: ApprovalOwner, approvalId: string, decision: ApprovalDecision): Promise<ApprovalResolveResult> {
    this.assertOwner(owner)
    const existing = await this.findOwned(owner, approvalId)
    if (!existing.record) return this.ownerFailure(existing.state)

    const record = existing.record
    const currentStatus = statusOf(record)
    if (currentStatus !== 'pending') return this.terminalResult(record, currentStatus)
    if (this.isExpired(record)) {
      const expired = await this.expire(record)
      return this.terminalResult(expired ?? record, 'expired')
    }

    const approved = decisionValue(decision)
    if (approved === null) return failure('invalid', 'APPROVAL_INVALID_DECISION', 'Approval decision must be approve or reject')

    const updated = await this.client.collection(APPROVAL_COLLECTION).update(String(record.id), {
      status: approved ? 'approved' : 'rejected',
      resolved_at: this.now(),
    })
    return this.terminalResult(updated, approved ? 'approved' : 'rejected')
  }

  /**
   * Re-read an approval once and resume the suspended operation if approved.
   * This method deliberately performs no polling. A pending result tells the
   * caller to return control to its transport and call `continue` later.
   *
   * If `resume` is supplied, it receives the original stored tool request;
   * its return value is wrapped in `state: 'continued'`. Errors from the
   * operation are intentionally allowed to propagate to the integration so
   * tool execution errors retain their normal handling.
   */
  async continue<T>(owner: ApprovalOwner, approvalId: string, resume?: (approval: ApprovalFlowApproval) => Promise<T> | T): Promise<ApprovalContinueResult<T>> {
    this.assertOwner(owner)
    const existing = await this.findOwned(owner, approvalId)
    if (!existing.record) return this.ownerFailure(existing.state)

    const record = existing.record
    const currentStatus = statusOf(record)
    if (currentStatus === 'pending') {
      if (this.isExpired(record)) {
        const expired = await this.expire(record)
        return { ok: true, state: 'expired', approval: this.toApproval(expired ?? record) }
      }
      return { ok: true, state: 'pending', approval: this.toApproval(record) }
    }
    if (currentStatus !== 'approved') return { ok: true, state: currentStatus, approval: this.toApproval(record) }

    const approval = this.toApproval(record)
    if (!resume) return { ok: true, state: 'approved', approval }
    const result = await resume(approval)
    return { ok: true, state: 'continued', approval, result }
  }

  private assertOwner(owner: ApprovalOwner): void {
    if (!ownerIsValid(owner)) throw new TypeError('Approval owner userId is required')
  }

  private async findOwned(owner: ApprovalOwner, approvalId: string): Promise<ExistingApproval> {
    const record = await this.client.collection(APPROVAL_COLLECTION).getOne(approvalId).catch((error: unknown) => {
      if (isNotFoundError(error)) return null
      throw error
    })
    if (!record) return { record: null, state: 'not_found' }
    const normalized = recordObject(record)
    return recordBelongsToOwner(normalized, owner)
      ? { record: normalized }
      : { record: null, state: 'forbidden' }
  }

  private isExpired(record: PocketBaseRecord): boolean {
    const createdAt = numberValue(record.created_at, this.now())
    const persistedExpiry = numberValue(record.expires_at, Number.NaN)
    const expiresAt = Number.isFinite(persistedExpiry) ? persistedExpiry : createdAt + this.expirationMs
    return this.now() >= expiresAt
  }

  private async expire(record: PocketBaseRecord): Promise<PocketBaseRecord | null> {
    if (statusOf(record) !== 'pending') return record
    try {
      return recordObject(await this.client.collection(APPROVAL_COLLECTION).update(String(record.id), {
        status: 'expired',
        resolved_at: this.now(),
      }))
    } catch (error) {
      // A concurrent resolver may have completed the record. Re-read it so
      // callers receive the durable terminal state rather than masking it.
      if (!isNotFoundError(error)) throw error
      return null
    }
  }

  private toApproval(value: unknown): ApprovalFlowApproval {
    const record = recordObject(value)
    const createdAt = numberValue(record.created_at, this.now())
    const persistedExpiry = numberValue(record.expires_at, Number.NaN)
    return {
      id: String(record.id ?? ''),
      user_id: String(record.user_id ?? ''),
      agent_id: String(record.agent_id ?? ''),
      ...(typeof record.session_id === 'string' ? { session_id: record.session_id } : {}),
      tool_id: String(record.tool_id ?? ''),
      input: record.input,
      status: statusOf(record),
      reason: String(record.reason ?? ''),
      created_at: createdAt,
      ...(typeof record.resolved_at === 'number' ? { resolved_at: record.resolved_at } : {}),
      expires_at: Number.isFinite(persistedExpiry) ? persistedExpiry : createdAt + this.expirationMs,
    }
  }

  private terminalResult(record: PocketBaseRecord, status: Exclude<ApprovalStatus, 'pending'>): ApprovalTerminalResult {
    return { ok: true, state: status, approval: this.toApproval({ ...record, status }) }
  }

  private ownerFailure(state: 'not_found' | 'forbidden'): ApprovalFlowFailure {
    return state === 'forbidden'
      ? failure('forbidden', 'APPROVAL_FORBIDDEN', 'Approval does not belong to the requesting owner')
      : failure('not_found', 'APPROVAL_NOT_FOUND', 'Approval was not found')
  }
}

export function createApprovalFlow(client: PocketBase, options?: ApprovalFlowOptions): ApprovalFlowService {
  return new ApprovalFlowService(client, options)
}

export type { PocketBase }
