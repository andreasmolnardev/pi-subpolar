export const CONTRACT_VERSION = "0.1";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type PrincipalKind = "user" | "service" | "local";

export interface Principal {
  id: string;
  kind: PrincipalKind;
  displayName?: string;
}

export interface ExecutionContext {
  requestId: string;
  principal: Principal;
  sessionId?: string;
  runId?: string;
  agentId?: string;
  cwd?: string;
  metadata?: Record<string, string>;
}

export interface ToolDefinition {
  id: string;
  namespace: string;
  description: string;
  inputSchema: JsonValue;
  enabled: boolean;
  risk: "low" | "medium" | "high";
  metadata?: Record<string, string>;
}

export interface ToolCall {
  callId: string;
  toolId: string;
  input: unknown;
}

export interface PolicyRules {
  deny?: boolean;
  requiresApproval?: boolean;
  allow?: boolean;
  reason?: string;
}

export type PolicyDecisionKind = "deny" | "approval_required" | "allow";

export interface PolicyDecision {
  kind: PolicyDecisionKind;
  reason: string;
}

export type PolicyResolver = (
  definition: ToolDefinition,
  context: ExecutionContext,
  input: unknown,
) => PolicyRules | Promise<PolicyRules>;

export type ValidationResult =
  | { valid: true }
  | { valid: false; errors: string[] };

export type InputValidator = (
  input: unknown,
  definition: ToolDefinition,
) => ValidationResult | Promise<ValidationResult>;

export interface ApprovalRequest {
  approvalId: string;
  call: ToolCall;
  definition: ToolDefinition;
  context: ExecutionContext;
  decision: PolicyDecision;
}

export type ApprovalDecision =
  | { approved: true; decidedBy?: string }
  | { approved: false; reason?: string; decidedBy?: string };

export type ApprovalCallback = (
  request: ApprovalRequest,
) => ApprovalDecision | Promise<ApprovalDecision>;

export interface ToolSuccess<T = unknown> {
  ok: true;
  value: T;
}

export interface ToolFailure {
  ok: false;
  error: ToolError;
}

export type ToolResult<T = unknown> = ToolSuccess<T> | ToolFailure;

export interface ToolError {
  code: string;
  message: string;
  details?: JsonValue;
}

export type ToolExecutor = (
  call: ToolCall,
  definition: ToolDefinition,
  context: ExecutionContext,
) => ToolResult | Promise<ToolResult>;

export type AuditStatus =
  | "unknown_tool"
  | "disabled"
  | "validation_failed"
  | "denied"
  | "approval_required"
  | "approval_denied"
  | "executed"
  | "failed";

export interface AuditRecord {
  auditId: string;
  callId: string;
  toolId: string;
  principalId: string;
  sessionId?: string;
  requestId: string;
  decision: PolicyDecisionKind | "not_evaluated";
  status: AuditStatus;
  input: JsonValue;
  result?: JsonValue;
  reason?: string;
  occurredAt: string;
}

export interface DomainEvent<T = JsonValue> {
  eventId: string;
  type: string;
  occurredAt: string;
  data: T;
}

export type AuditEvent = DomainEvent<AuditRecord> & { type: "tool.audit" };
export type EventSink = (event: DomainEvent) => void | Promise<void>;

export type AdapterCapability =
  | "session.persistence"
  | "event.replay"
  | "multi-process-concurrency"
  | "durable-approvals";

export interface AdapterCapabilities {
  adapter: string;
  durability: "ephemeral" | "json-file";
  supports: Readonly<Record<AdapterCapability, boolean>>;
}

export class UnsupportedCapabilityError extends Error {
  readonly code = "UNSUPPORTED_CAPABILITY";
  readonly capability: AdapterCapability;
  readonly adapter: string;

  constructor(capability: AdapterCapability, adapter: string, message?: string) {
    super(message ?? `${adapter} does not support ${capability}`);
    this.name = "UnsupportedCapabilityError";
    this.capability = capability;
    this.adapter = adapter;
  }
}

export interface SessionTranscriptEntry {
  role: "user" | "assistant" | "tool";
  content: string;
  occurredAt: string;
}

export interface SessionRecord {
  sessionId: string;
  transcript: SessionTranscriptEntry[];
  updatedAt: string;
}

export interface SessionStore {
  readonly capabilities: AdapterCapabilities;
  load(sessionId: string): Promise<SessionRecord | undefined>;
  append(sessionId: string, entries: SessionTranscriptEntry[]): Promise<SessionRecord>;
}
