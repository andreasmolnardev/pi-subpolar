import { describe, expect, test } from "bun:test";
import { createPolicyGateway, redactAuditValue } from "../src/index.ts";
import type { DomainEvent, ExecutionContext, ToolDefinition } from "../../subpolar-contracts/src/index.ts";

const context: ExecutionContext = {
  requestId: "request-1",
  principal: { id: "local-user", kind: "local" },
  sessionId: "session-1",
};

const tools: ToolDefinition[] = [
  { id: "safe.echo", namespace: "safe", description: "Echo", inputSchema: {}, enabled: true, risk: "low" },
  { id: "danger.write", namespace: "danger", description: "Write", inputSchema: {}, enabled: true, risk: "high" },
  { id: "manual.deploy", namespace: "manual", description: "Deploy", inputSchema: {}, enabled: true, risk: "high" },
  { id: "disabled.tool", namespace: "disabled", description: "Disabled", inputSchema: {}, enabled: false, risk: "low" },
];

function makeGateway(policy: (toolId: string) => { allow?: boolean; deny?: boolean; requiresApproval?: boolean }, events: DomainEvent[] = []) {
  return createPolicyGateway({
    tools,
    validateInput: async (input) => (typeof input === "object" && input !== null && "value" in input ? { valid: true } : { valid: false, errors: ["value is required"] }),
    resolvePolicy: (definition) => policy(definition.id),
    execute: async (call) => ({ ok: true, value: call.input }),
    emitEvent: (event) => events.push(event),
    now: () => new Date("2026-01-01T00:00:00.000Z"),
  });
}

describe("subpolar-core policy gateway", () => {
  test("redacts embedded and JSON-encoded secrets from audit values", () => {
    const value = redactAuditValue({
      message: 'request failed: apiKey=plain-secret; body={"password":"json-secret"}',
      payload: '{"nested":{"access_token":"encoded-secret"}}',
      escapedPayload: JSON.stringify('{"token":"escaped-secret"}'),
    });

    expect(JSON.stringify(value)).not.toContain("plain-secret");
    expect(JSON.stringify(value)).not.toContain("json-secret");
    expect(JSON.stringify(value)).not.toContain("encoded-secret");
    expect(JSON.stringify(value)).not.toContain("escaped-secret");
    expect(JSON.stringify(value)).toContain("[REDACTED]");
  });

  test("allows a validated tool and emits a redacted audit", async () => {
    const events: DomainEvent[] = [];
    const gateway = makeGateway(() => ({ allow: true }), events);
    const result = await gateway.call({ callId: "call-allow", toolId: "safe.echo", input: { value: "ok", apiKey: "secret" } }, context);

    expect(result).toEqual({ ok: true, status: "executed", callId: "call-allow", toolId: "safe.echo", value: { value: "ok", apiKey: "secret" } });
    expect(events[0]?.type).toBe("tool.audit");
    expect((events[0]?.data as { input: { apiKey: string } }).input.apiKey).toBe("[REDACTED]");
  });

  test("deny takes precedence over approval and allow", async () => {
    let executed = false;
    const gateway = createPolicyGateway({
      tools,
      validateInput: () => ({ valid: true }),
      resolvePolicy: () => ({ deny: true, requiresApproval: true, allow: true }),
      execute: async () => {
        executed = true;
        return { ok: true, value: "should not run" };
      },
    });

    const result = await gateway.call({ callId: "call-deny", toolId: "safe.echo", input: {} }, context);
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ status: "denied", error: { code: "POLICY_DENIED" } });
    expect(executed).toBe(false);
  });

  test("requires approval before execution", async () => {
    let approved = false;
    const gateway = createPolicyGateway({
      tools,
      validateInput: () => ({ valid: true }),
      resolvePolicy: () => ({ requiresApproval: true }),
      approve: async (request) => {
        approved = request.approvalId === "approval-call-approval";
        return { approved: true };
      },
      execute: async () => ({ ok: true, value: "ran" }),
    });

    const result = await gateway.call({ callId: "call-approval", toolId: "manual.deploy", input: {} }, context);
    expect(approved).toBe(true);
    expect(result).toMatchObject({ ok: true, status: "executed" });
  });

  test("returns approval required without silently allowing", async () => {
    const gateway = makeGateway(() => ({ requiresApproval: true, allow: true }));
    const result = await gateway.call({ callId: "call-pending", toolId: "manual.deploy", input: { value: true } }, context);

    expect(result).toMatchObject({ ok: false, status: "approval_required", error: { code: "APPROVAL_REQUIRED" }, approvalId: "approval-call-pending" });
  });

  test("rejects unknown, disabled, and invalid calls", async () => {
    const gateway = makeGateway(() => ({ allow: true }));
    await expect(gateway.call({ callId: "call-unknown", toolId: "missing", input: {} }, context)).resolves.toMatchObject({ status: "unknown_tool" });
    await expect(gateway.call({ callId: "call-disabled", toolId: "disabled.tool", input: { value: true } }, context)).resolves.toMatchObject({ status: "disabled" });
    await expect(gateway.call({ callId: "call-invalid", toolId: "safe.echo", input: {} }, context)).resolves.toMatchObject({ status: "validation_failed", error: { code: "INVALID_TOOL_INPUT" } });
  });

  test("executes a callId once, including concurrent duplicates", async () => {
    let executionCount = 0;
    const gateway = createPolicyGateway({
      tools,
      validateInput: () => ({ valid: true }),
      resolvePolicy: () => ({ allow: true }),
      execute: async (call) => {
        executionCount += 1;
        await Promise.resolve();
        return { ok: true, value: { attempt: executionCount, input: call.input } };
      },
    });

    const calls = await Promise.all([
      gateway.call({ callId: "call-once", toolId: "safe.echo", input: { value: "first" } }, context),
      gateway.call({ callId: "call-once", toolId: "safe.echo", input: { value: "second" } }, context),
    ]);

    expect(executionCount).toBe(1);
    expect(calls[0]).toEqual(calls[1]);
    expect(gateway.capabilities).toEqual({ idempotency: "in-memory-per-gateway", multiProcessGuarantee: false });
  });

  test("returns a stable cached failure when audit emission fails after execution", async () => {
    let executionCount = 0;
    const gateway = createPolicyGateway({
      tools,
      validateInput: () => ({ valid: true }),
      resolvePolicy: () => ({ allow: true }),
      execute: async () => {
        executionCount += 1;
        return { ok: true, value: "completed" };
      },
      emitEvent: () => {
        throw new Error("audit sink unavailable");
      },
    });

    const first = await gateway.call({ callId: "call-audit-failure", toolId: "safe.echo", input: { value: true } }, context);
    const second = await gateway.call({ callId: "call-audit-failure", toolId: "safe.echo", input: { value: false } }, context);

    expect(first).toEqual({
      ok: false,
      status: "failed",
      callId: "call-audit-failure",
      toolId: "safe.echo",
      error: { code: "AUDIT_FAILED", message: "Tool execution completed but audit emission failed" },
    });
    expect(second).toEqual(first);
    expect(executionCount).toBe(1);
  });

  test("does not return thrown executor secrets", async () => {
    const gateway = createPolicyGateway({
      tools,
      validateInput: () => ({ valid: true }),
      resolvePolicy: () => ({ allow: true }),
      execute: async () => {
        throw new Error('executor failed with apiKey=executor-secret');
      },
    });

    const result = await gateway.call({ callId: "call-executor-error", toolId: "safe.echo", input: { value: true } }, context);

    expect(result).toEqual({
      ok: false,
      status: "failed",
      callId: "call-executor-error",
      toolId: "safe.echo",
      error: { code: "EXECUTION_FAILED", message: "Tool execution failed" },
    });
    expect(JSON.stringify(result)).not.toContain("executor-secret");
  });
});
