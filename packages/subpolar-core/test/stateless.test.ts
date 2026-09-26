import { describe, expect, test } from "bun:test";
import type {
  AdapterCapabilities,
  ApprovalDecision,
  ApprovalRecord,
  ApprovalRequest,
  EventReplayPort,
  IdempotencyPort,
  RunEvent,
  RunOutcome,
  RunStore,
  RuntimeContext,
  RuntimeContextPort,
  StatelessRunRequest,
} from "../../subpolar-contracts/src/index.ts";
import { createPolicyGateway, createStatelessSubpolarRuntime } from "../src/index.ts";

const request: StatelessRunRequest = {
  runId: "run-stateless",
  requestId: "request-stateless",
  sessionId: "session-stateless",
  prompt: "hello",
};

const context: RuntimeContext = {
  runId: request.runId,
  requestId: request.requestId,
  sessionId: request.sessionId,
  principal: { id: "user-stateless", kind: "user" },
};

const capabilities: AdapterCapabilities = {
  adapter: "test-durable",
  durability: "remote",
  supports: {
    "run.outcome.persistence": true,
    "event.replay": true,
    "durable-approvals": true,
    idempotency: true,
  },
};

function makeContextPort(calls: RuntimeContext[] = []): RuntimeContextPort {
  return {
    async load(input) {
      calls.push(context);
      return { ...context, runId: input.runId, requestId: input.requestId };
    },
  };
}

function makeRecoveryPorts() {
  const outcomes = new Map<string, RunOutcome>();
  const events: RunEvent[] = [];
  const runStore: RunStore = {
    capabilities,
    async load(runId) { return outcomes.get(runId); },
    async save(outcome) { outcomes.set(outcome.runId, outcome); },
  };
  const eventReplayPort: EventReplayPort = {
    capabilities,
    async append(event) { events.push(event); },
    async replay(runId) { return events.filter((event) => event.runId === runId); },
  };
  return { runStore, eventReplayPort, outcomes, events };
}

function makeIdempotency(): IdempotencyPort {
  const values = new Map<string, unknown>();
  return {
    async execute<T>(key: string, operation: () => Promise<T>): Promise<T> {
      if (values.has(key)) return values.get(key) as T;
      const value = await operation();
      values.set(key, value);
      return value;
    },
  };
}

function makeApprovalStore() {
  const records = new Map<string, ApprovalRecord>();
  const store = {
    async load(approvalId: string) { return records.get(approvalId); },
    async create(input: ApprovalRequest) {
      const record: ApprovalRecord = {
        approvalId: input.approvalId,
        callId: input.call.callId,
        toolId: input.call.toolId,
        runId: input.call.runId,
        request: { approvalId: input.approvalId, callId: input.call.callId, toolId: input.call.toolId },
        status: "pending" as const,
        createdAt: "2026-01-01T00:00:00.000Z",
      };
      records.set(record.approvalId, record);
      return record;
    },
    async decide(approvalId: string, decision: ApprovalDecision) {
      const current = records.get(approvalId);
      if (!current) throw new Error("approval not found");
      const next: ApprovalRecord = {
        ...current,
        status: decision.approved ? "approved" : "denied",
        ...(decision.decidedBy === undefined ? {} : { decidedBy: decision.decidedBy }),
        ...(!decision.approved && decision.reason === undefined ? {} : { reason: decision.approved ? undefined : decision.reason }),
        decidedAt: "2026-01-01T00:01:00.000Z",
      };
      records.set(approvalId, next);
      return next;
    },
  };
  return { records, store };
}

describe("StatelessSubpolarRuntime", () => {
  test("loads context and emits a durable lifecycle on each run", async () => {
    const contextLoads: RuntimeContext[] = [];
    const ports = makeRecoveryPorts();
    const runtime = createStatelessSubpolarRuntime({
      context: makeContextPort(contextLoads),
      gateway: createPolicyGateway({ tools: [], validateInput: () => ({ valid: true }), resolvePolicy: () => ({ allow: true }), execute: async () => ({ ok: true, value: null }) }),
      execute: async ({ emit }) => {
        await emit({ kind: "progress" });
        return { text: "done" };
      },
      ...ports,
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    });

    const result = await runtime.run(request);

    expect(result).toMatchObject({ state: "completed", output: { text: "done" }, recoverable: true });
    expect(contextLoads).toHaveLength(1);
    expect(ports.events.map((event) => event.type)).toEqual(["run.started", "run.progress", "run.completed"]);
    expect(ports.outcomes.get(request.runId)?.recoverable).toBe(true);
  });

  test("returns approval-required without a local continuation and resumes from durable approval", async () => {
    const approvals = makeApprovalStore();
    const idempotency = makeIdempotency();
    const tools = [{ id: "danger.write", namespace: "danger", description: "Write", inputSchema: {}, enabled: true, risk: "high" as const }];
    let executions = 0;
    const createRuntime = () => createStatelessSubpolarRuntime({
      context: makeContextPort(),
      approvals: approvals.store,
      gateway: createPolicyGateway({
        tools,
        validateInput: () => ({ valid: true }),
        resolvePolicy: () => ({ requiresApproval: true }),
        approvalStore: approvals.store,
        idempotency,
        execute: async () => { executions += 1; return { ok: true, value: "written" }; },
      }),
      execute: async ({ tools: toolInvoker }) => toolInvoker.call({ callId: "call-restart-safe", toolId: "danger.write", input: { value: 1 } }),
    });

    const first = await createRuntime().run(request);
    expect(first).toMatchObject({ state: "approval_required", approvalId: "approval-call-restart-safe", error: { code: "APPROVAL_REQUIRED" } });
    expect(executions).toBe(0);

    await createRuntime().decideApproval("approval-call-restart-safe", { approved: true, decidedBy: "user-stateless" });
    const second = await createRuntime().run(request);

    expect(second).toMatchObject({ state: "completed", output: { ok: true, status: "executed", value: "written" } });
    expect(executions).toBe(1);
  });
});
