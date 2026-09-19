import type {
  ApprovalCallback,
  AuditEvent,
  AuditRecord,
  DomainEvent,
  EventSink,
  ExecutionContext,
  InputValidator,
  JsonValue,
  PolicyDecision,
  PolicyResolver,
  ToolDefinition,
  ToolError,
  ToolExecutor,
  ToolFailure,
  ToolResult,
  ToolSuccess,
  ToolCall,
} from "../../subpolar-contracts/src/index.ts";

export interface GatewayOptions {
  tools: readonly ToolDefinition[];
  validateInput: InputValidator;
  resolvePolicy: PolicyResolver;
  execute: ToolExecutor;
  approve?: ApprovalCallback;
  emitEvent?: EventSink;
  redact?: (value: unknown) => JsonValue;
  now?: () => Date;
}

export interface GatewayCapabilities {
  idempotency: "in-memory-per-gateway";
  multiProcessGuarantee: false;
}

export type GatewayStatus =
  | "unknown_tool"
  | "disabled"
  | "validation_failed"
  | "denied"
  | "approval_required"
  | "approval_denied"
  | "executed"
  | "failed";

export interface GatewaySuccess<T = unknown> {
  ok: true;
  status: "executed";
  callId: string;
  toolId: string;
  value: T;
}

export interface GatewayFailure {
  ok: false;
  status: Exclude<GatewayStatus, "executed">;
  callId: string;
  toolId: string;
  error: ToolError;
  approvalId?: string;
}

export type GatewayResult<T = unknown> = GatewaySuccess<T> | GatewayFailure;

export interface ToolGateway {
  readonly tools: readonly ToolDefinition[];
  readonly capabilities: GatewayCapabilities;
  lookup(toolId: string): ToolDefinition | undefined;
  call(call: ToolCall, context: ExecutionContext): Promise<GatewayResult>;
}

const sensitiveKey = /(access[_-]?token|api[_-]?key|authorization|bearer|client[_-]?secret|cookie|credential|password|private[_-]?key|secret|session[_-]?token|set-cookie|token)/i;
const safeErrorCode = /^[A-Z][A-Z0-9_.-]{0,63}$/;

function redactSensitiveString(value: string): string {
  let redacted = value;

  try {
    let parsed: unknown = value;
    for (let depth = 0; depth < 2 && typeof parsed === "string"; depth += 1) {
      parsed = JSON.parse(parsed);
      if (parsed !== null && typeof parsed === "object") return JSON.stringify(redactAuditValue(parsed));
    }
  } catch {
    // This is an ordinary string, so continue with embedded key/value redaction.
  }

  redacted = redacted.replace(
    /\b(authorization|bearer)\s*[:=]\s*(?:bearer\s+)?[^\s,;}&\]]+/gi,
    "$1: [REDACTED]",
  );
  redacted = redacted.replace(
    /(["'])(access[_-]?token|api[_-]?key|authorization|bearer|client[_-]?secret|cookie|credential|password|private[_-]?key|secret|session[_-]?token|set-cookie|token)\1\s*([:=])\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}&\]]+)/gi,
    (_match, quote: string, key: string, operator: string) => `${quote}${key}${quote}${operator}"[REDACTED]"`,
  );
  redacted = redacted.replace(
    /\b(access[_-]?token|api[_-]?key|authorization|bearer|client[_-]?secret|cookie|credential|password|private[_-]?key|secret|session[_-]?token|set-cookie|token)\b\s*([:=])\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}&\]]+)/gi,
    (_match, key: string, operator: string) => `${key}${operator}"[REDACTED]"`,
  );

  return redacted;
}

export function redactAuditValue(value: unknown): JsonValue {
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") return redactSensitiveString(value);
  if (Array.isArray(value)) {
    return value.map((entry) => redactAuditValue(entry));
  }
  if (typeof value === "object") {
    const result = Object.create(null) as { [key: string]: JsonValue };
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      result[key] = sensitiveKey.test(key) ? "[REDACTED]" : redactAuditValue(entry);
    }
    return result;
  }
  return `[${typeof value}]`;
}

function redactedText(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  return redactSensitiveString(value);
}

function sanitizeExecutorError(error: unknown): ToolError {
  if (!error || typeof error !== "object") {
    return { code: "EXECUTION_FAILED", message: "Tool execution failed" };
  }
  const candidate = error as { code?: unknown; message?: unknown; details?: unknown };
  const code = typeof candidate.code === "string" && safeErrorCode.test(candidate.code) ? candidate.code : "EXECUTION_FAILED";
  const message = redactedText(candidate.message, "Tool execution failed");
  const details = candidate.details === undefined ? undefined : redactAuditValue(candidate.details);
  return { code, message, details };
}

function policyDecision(rules: { deny?: boolean; requiresApproval?: boolean; allow?: boolean; reason?: string }): PolicyDecision {
  if (rules.deny) return { kind: "deny", reason: rules.reason ?? "Tool denied by policy" };
  if (rules.requiresApproval) return { kind: "approval_required", reason: rules.reason ?? "Tool approval is required" };
  if (rules.allow) return { kind: "allow", reason: rules.reason ?? "Tool allowed by policy" };
  return { kind: "deny", reason: rules.reason ?? "Tool is not allowed by policy" };
}

export function createPolicyGateway(options: GatewayOptions): ToolGateway {
  const tools = [...options.tools];
  const definitions = new Map<string, ToolDefinition>();
  for (const definition of tools) {
    if (!definition.id || definitions.has(definition.id)) {
      throw new Error(`Tool definitions must have unique canonical IDs: ${definition.id}`);
    }
    definitions.set(definition.id, definition);
  }

  const now = options.now ?? (() => new Date());
  const redact = (value: unknown): JsonValue => redactAuditValue(options.redact ? options.redact(value) : value);
  const completedResults = new Map<string, GatewayResult>();
  const inFlightResults = new Map<string, Promise<GatewayResult>>();

  async function emitAudit(
    call: ToolCall,
    context: ExecutionContext,
    status: GatewayStatus,
    decision: AuditRecord["decision"],
    reason?: string,
    result?: unknown,
  ): Promise<boolean> {
    if (!options.emitEvent) return true;
    try {
      const occurredAt = now().toISOString();
      const safeCallId = redactedText(call.callId, "[REDACTED]");
      const record: AuditRecord = {
        auditId: `audit-${safeCallId}`,
        callId: safeCallId,
        toolId: redactedText(call.toolId, "[REDACTED]"),
        principalId: redactedText(context.principal.id, "[REDACTED]"),
        sessionId: context.sessionId === undefined ? undefined : redactedText(context.sessionId, "[REDACTED]"),
        requestId: redactedText(context.requestId, "[REDACTED]"),
        decision,
        status,
        input: redact(call.input),
        result: result === undefined ? undefined : redact(result),
        reason: reason === undefined ? undefined : redactedText(reason, "[REDACTED]"),
        occurredAt,
      };
      const event: AuditEvent = {
        eventId: `event-${record.auditId}`,
        type: "tool.audit",
        occurredAt,
        data: record,
      };
      await options.emitEvent(event as DomainEvent);
      return true;
    } catch {
      return false;
    }
  }

  async function failure(
    call: ToolCall,
    context: ExecutionContext,
    status: GatewayFailure["status"],
    code: string,
    message: string,
    decision: AuditRecord["decision"],
    details?: JsonValue,
    approvalId?: string,
  ): Promise<GatewayFailure> {
    const error: ToolError = {
      code,
      message: redactedText(message, "Tool request failed"),
      details: details === undefined ? undefined : redact(details),
    };
    await emitAudit(call, context, status, decision, message, error);
    return {
      ok: false,
      status,
      callId: redactedText(call.callId, "[REDACTED]"),
      toolId: redactedText(call.toolId, "[REDACTED]"),
      error,
      approvalId: approvalId === undefined ? undefined : redactedText(approvalId, "[REDACTED]"),
    };
  }

  async function executeCall(call: ToolCall, context: ExecutionContext): Promise<GatewayResult> {
    const definition = definitions.get(call.toolId);
    if (!definition) {
      return failure(call, context, "unknown_tool", "UNKNOWN_TOOL", `Unknown tool: ${call.toolId}`, "not_evaluated");
    }
    if (!definition.enabled) {
      return failure(call, context, "disabled", "TOOL_DISABLED", `Tool is disabled: ${call.toolId}`, "not_evaluated");
    }

    const validation = await options.validateInput(call.input, definition);
    if (!validation.valid) {
      return failure(
        call,
        context,
        "validation_failed",
        "INVALID_TOOL_INPUT",
        "Tool input failed validation",
        "not_evaluated",
        validation.errors,
      );
    }

    const decision = policyDecision(await options.resolvePolicy(definition, context, call.input));
    if (decision.kind === "deny") {
      return failure(call, context, "denied", "POLICY_DENIED", decision.reason, decision.kind);
    }

    if (decision.kind === "approval_required") {
      const approvalId = `approval-${call.callId}`;
      if (!options.approve) {
        return failure(
          call,
          context,
          "approval_required",
          "APPROVAL_REQUIRED",
          decision.reason,
          decision.kind,
          undefined,
          approvalId,
        );
      }
      const approval = await options.approve({ approvalId, call, definition, context, decision });
      if (!approval.approved) {
        return failure(
          call,
          context,
          "approval_denied",
          "APPROVAL_DENIED",
          approval.reason ?? "Approval was denied",
          decision.kind,
          undefined,
          approvalId,
        );
      }
    }

    let execution: ToolResult;
    try {
      execution = await options.execute(call, definition, context);
    } catch {
      execution = { ok: false, error: { code: "EXECUTION_FAILED", message: "Tool execution failed" } };
    }
    if (!execution.ok) {
      const error = sanitizeExecutorError(execution.error);
      await emitAudit(call, context, "failed", decision.kind, error.message, error);
      return {
        ok: false,
        status: "failed",
        callId: redactedText(call.callId, "[REDACTED]"),
        toolId: redactedText(call.toolId, "[REDACTED]"),
        error,
      };
    }

    const auditSucceeded = await emitAudit(call, context, "executed", decision.kind, decision.reason, execution.value);
    if (!auditSucceeded) {
      return {
        ok: false,
        status: "failed",
        callId: redactedText(call.callId, "[REDACTED]"),
        toolId: redactedText(call.toolId, "[REDACTED]"),
        error: { code: "AUDIT_FAILED", message: "Tool execution completed but audit emission failed" },
      };
    }
    return { ok: true, status: "executed", callId: call.callId, toolId: call.toolId, value: execution.value };
  }

  async function runCall(call: ToolCall, context: ExecutionContext): Promise<GatewayResult> {
    try {
      return await executeCall(call, context);
    } catch {
      return failure(call, context, "failed", "GATEWAY_FAILED", "Tool gateway failed", "not_evaluated");
    }
  }

  return {
    tools,
    capabilities: { idempotency: "in-memory-per-gateway", multiProcessGuarantee: false },
    lookup: (toolId) => definitions.get(toolId),
    async call(call, context) {
      const completed = completedResults.get(call.callId);
      if (completed) return completed;

      const inFlight = inFlightResults.get(call.callId);
      if (inFlight) return inFlight;

      const resultPromise = runCall(call, context);
      inFlightResults.set(call.callId, resultPromise);
      const result = await resultPromise;
      completedResults.set(call.callId, result);
      inFlightResults.delete(call.callId);
      return result;
    },
  };
}

export type { ToolFailure, ToolSuccess };
