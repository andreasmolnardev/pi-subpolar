export type Decision = 'deny' | 'approval' | 'allow'

export type AuditEntry = {
  callId: string
  userId: string
  toolId: string
  decision: Decision
  outcome: 'not-run' | 'approved' | 'executed'
}

type RecordSet = {
  projectId?: string
  sessionId?: string
}

/** A small protocol fake. It intentionally models contracts, not PocketBase internals. */
export class ContractFake {
  readonly audit: AuditEntry[] = []
  readonly approvals = new Set<string>()
  private readonly calls = new Map<string, { decision: Decision; result?: string }>()
  private nextId = 0

  health() {
    return { status: 'ok', version: 'v1' }
  }

  capabilities() {
    return { version: 'v1', capabilities: ['auth', 'projects', 'sessions', 'tools', 'audit'] }
  }

  authConfig() {
    return { enabledProviders: ['credentials'], registrationEnabled: true, isFirstUser: true }
  }

  authenticate(email: string, password: string) {
    if (email !== 'e2e@example.test' || password !== 'e2e-password-16') throw new Error('AUTH_FAILED')
    return { userId: 'user-e2e', token: 'e2e-token' }
  }

  createProjectAndSession(): Required<RecordSet> {
    this.nextId += 1
    return { projectId: `project-${this.nextId}`, sessionId: `session-${this.nextId}` }
  }

  discoverTools() {
    return [
      { id: 'read', permission: 'allow' },
      { id: 'write', permission: 'approval' },
      { id: 'dangerous', permission: 'deny' },
    ]
  }

  callTool(toolId: string, userId: string, callId: string): { decision: Decision; approvalId?: string; result?: string } {
    const existing = this.calls.get(callId)
    if (existing) return { decision: existing.decision, result: existing.result }

    const decision: Decision = toolId === 'dangerous' ? 'deny' : toolId === 'write' ? 'approval' : 'allow'
    if (decision === 'approval') this.approvals.add(callId)
    const result = decision === 'allow' ? 'fake-result' : undefined
    this.calls.set(callId, { decision, result })
    this.audit.push({ callId, userId, toolId, decision, outcome: decision === 'allow' ? 'executed' : 'not-run' })
    return { decision, ...(decision === 'approval' ? { approvalId: callId } : {}), ...(result ? { result } : {}) }
  }

  approve(callId: string, userId: string) {
    if (!this.approvals.delete(callId)) throw new Error('APPROVAL_NOT_FOUND')
    const entry = this.audit.find((item) => item.callId === callId && item.userId === userId)
    if (!entry) throw new Error('AUDIT_NOT_FOUND')
    entry.outcome = 'approved'
    return { decision: 'allow' as const, result: 'fake-result' }
  }
}
