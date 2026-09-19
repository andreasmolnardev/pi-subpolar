import { describe, expect, test } from "bun:test";
import { createLocalAdapter } from "../../subpolar-adapter-local/src/index.ts";
import { createPolicyGateway, createRunService } from "../../subpolar-core/src/index.ts";
import { UnsupportedCapabilityError } from "../../subpolar-contracts/src/index.ts";
import type { DomainEvent, SessionTranscriptEntry, ToolDefinition } from "../../subpolar-contracts/src/index.ts";
import {
  createPocketBaseAdapter,
  createPocketBaseSessionStore,
  PocketBaseOwnerScopeError,
  PocketBaseUnsupportedCapabilityError,
  type PocketBaseConditionalUpdatePort,
  type PocketBaseCollectionPort,
  type PocketBaseClientPort,
  type PocketBaseStoredRecord,
} from "../src/index.ts";

class FakeCollection implements PocketBaseCollectionPort {
  private readonly records = new Map<string, PocketBaseStoredRecord>();
  private nextId = 1;

  async list(): Promise<readonly PocketBaseStoredRecord[]> {
    return [...this.records.values()].map((record) => structuredClone(record));
  }

  async get(id: string): Promise<PocketBaseStoredRecord | undefined> {
    const record = this.records.get(id);
    return record ? structuredClone(record) : undefined;
  }

  async create(data: Record<string, unknown>): Promise<PocketBaseStoredRecord> {
    const id = typeof data.id === "string" ? data.id : `record-${this.nextId++}`;
    const record = { id, ...structuredClone(data) };
    this.records.set(id, record);
    return structuredClone(record);
  }

  async update(id: string, data: Record<string, unknown>): Promise<PocketBaseStoredRecord | undefined> {
    const existing = this.records.get(id);
    if (!existing) return undefined;
    const record = { ...existing, ...structuredClone(data), id };
    this.records.set(id, record);
    return structuredClone(record);
  }
}

class FakeClient implements PocketBaseClientPort {
  private readonly collections = new Map<string, FakeCollection>();

  collection(name: string): FakeCollection {
    let collection = this.collections.get(name);
    if (!collection) {
      collection = new FakeCollection();
      this.collections.set(name, collection);
    }
    return collection;
  }
}

const now = () => new Date("2026-01-01T00:00:00.000Z");
const entry: SessionTranscriptEntry = { role: "user", content: "hello", occurredAt: now().toISOString() };

function makeAdapter(options: { eventReplay?: boolean; transaction?: { run<T>(operation: () => Promise<T>): Promise<T> }; conditionalUpdate?: PocketBaseConditionalUpdatePort } = {}) {
  return createPocketBaseAdapter({
    client: new FakeClient(),
    collections: {
      agents: "agents",
      projects: "projects",
      sessions: "sessions",
      approvals: "approvals",
      audits: "audits",
      events: "events",
    },
    now,
    transaction: { run: (operation) => operation() },
    ...options,
  });
}

describe("PocketBase adapter fake-client contract", () => {
  test("keeps session semantics aligned with the local adapter", async () => {
    const local = createLocalAdapter();
    await local.sessions.append("session-1", [entry]);
    const adapter = makeAdapter();
    await adapter.sessions.append("user-a", "session-1", [entry]);

    expect((await adapter.sessions.load("user-a", "session-1"))?.transcript).toEqual(
      (await local.sessions.load("session-1"))?.transcript,
    );
    expect(adapter.capabilities.supports["session.persistence"]).toBe(true);
    expect(await adapter.sessions.load("user-b", "session-1")).toBeUndefined();
    await expect(adapter.sessions.append("user-b", "session-1", [entry])).rejects.toBeInstanceOf(PocketBaseOwnerScopeError);
  });

  test("preserves policy and approval outcomes while persisting approval state", async () => {
    const definition: ToolDefinition = {
      id: "manual.deploy",
      namespace: "manual",
      description: "Deploy",
      inputSchema: {},
      enabled: true,
      risk: "high",
    };
    const adapter = makeAdapter();
    const localApproval = { status: "pending" as "pending" | "approved" | "denied" };
    const gateway = createPolicyGateway({
      tools: [definition],
      validateInput: () => ({ valid: true }),
      resolvePolicy: (_definition, context) => (context.principal.id === "blocked" ? { deny: true } : { requiresApproval: true }),
      approve: async (request) => {
        const approval = await adapter.approvals.create(request.context.principal.id, {
          approvalId: request.approvalId,
          callId: request.call.callId,
          toolId: request.definition.id,
          request: { callId: request.call.callId },
        });
        localApproval.status = "approved";
        await adapter.approvals.decide(request.context.principal.id, approval.approvalId, { approved: true, decidedBy: "owner" });
        return { approved: localApproval.status === "approved" };
      },
      execute: async () => ({ ok: true, value: "deployed" }),
      now,
    });

    await expect(
      gateway.call(
        { callId: "call-denied", toolId: definition.id, input: {} },
        { requestId: "request-denied", principal: { id: "blocked", kind: "user" } },
      ),
    ).resolves.toMatchObject({ status: "denied" });
    await expect(
      gateway.call(
        { callId: "call-approved", toolId: definition.id, input: {} },
        { requestId: "request-approved", principal: { id: "owner", kind: "user" } },
      ),
    ).resolves.toMatchObject({ status: "executed" });
    expect((await adapter.approvals.list("owner"))[0]).toMatchObject({ status: "approved", decidedBy: "owner" });
    expect(await adapter.approvals.list("blocked")).toEqual([]);
  });

  test("denies cross-user reads and approval decisions", async () => {
    const adapter = makeAdapter();
    const project = await adapter.projects.create("user-a", { name: "private" });
    const approval = await adapter.approvals.create("user-a", {
      approvalId: "approval-1",
      callId: "call-1",
      toolId: "manual.deploy",
      request: null,
    });

    expect(await adapter.projects.get("user-b", project.id)).toBeUndefined();
    await expect(adapter.projects.update("user-b", project.id, { name: "stolen" })).rejects.toMatchObject({ code: "OWNER_SCOPE_DENIED" });
    expect(await adapter.approvals.get("user-b", approval.approvalId)).toBeUndefined();
    await expect(adapter.approvals.decide("user-b", approval.approvalId, { approved: true })).rejects.toBeInstanceOf(PocketBaseOwnerScopeError);
  });

  test("reports and fails unsupported durability and replay operations explicitly", async () => {
    const client = new FakeClient();
    const adapter = createPocketBaseAdapter({
      client,
      collections: { sessions: null, approvals: null, events: "events" },
      now,
    });

    expect(adapter.capabilities.supports["session.persistence"]).toBe(false);
    expect(adapter.capabilities.supports["durable-approvals"]).toBe(false);
    expect(adapter.capabilities.supports["event.publication"]).toBe(true);
    expect(adapter.capabilities.supports["event.replay"]).toBe(false);
    expect(adapter.capabilities.supports.transactions).toBe(false);
    expect(adapter.capabilities.supports.idempotency).toBe(false);
    await expect(adapter.sessions.load("user-a", "session-1")).rejects.toMatchObject({
      code: "UNSUPPORTED_CAPABILITY",
      capability: "session.persistence",
    });
    await expect(adapter.approvals.list("user-a")).rejects.toMatchObject({ capability: "durable-approvals" });
    await adapter.events.publish("user-a", { eventId: "event-unsupported-replay", type: "test", occurredAt: now().toISOString(), data: null });
    await expect(adapter.events.replay("user-a")).rejects.toBeInstanceOf(PocketBaseUnsupportedCapabilityError);
    const unsupportedTransaction = adapter.transactions.run(async () => "nope");
    await expect(unsupportedTransaction).rejects.toMatchObject({
      capability: "multi-process-concurrency",
      pocketBaseCapability: "transactions",
    });
    await expect(unsupportedTransaction).rejects.toBeInstanceOf(UnsupportedCapabilityError);
    await expect(adapter.idempotency.execute("key", async () => "nope")).rejects.toMatchObject({
      capability: "multi-process-concurrency",
      pocketBaseCapability: "idempotency",
    });
  });

  test("only enables replay when it is explicitly configured", async () => {
    const event: DomainEvent = { eventId: "event-1", type: "tool.audit", occurredAt: now().toISOString(), data: null };
    const adapter = makeAdapter({ eventReplay: true });
    await adapter.events.publish("user-a", event);
    await adapter.events.publish("user-b", { ...event, eventId: "event-2" });

    expect(adapter.capabilities.supports["event.publication"]).toBe(true);
    expect(adapter.capabilities.supports["event.replay"]).toBe(true);
    expect((await adapter.events.replay("user-a")).map((published) => published.event.eventId)).toEqual(["event-1"]);
  });

  test("whitelists scoped fields and redacts persisted caller data", async () => {
    const client = new FakeClient();
    const adapter = createPocketBaseAdapter({
      client,
      collections: { approvals: "approvals", audits: "audits", events: "events" },
      eventReplay: true,
      now,
      transaction: { run: (operation) => operation() },
    });

    const approval = await adapter.approvals.create("owner-a", {
      approvalId: "approval-safe",
      callId: "call-safe",
      toolId: "tool-safe",
      request: { token: "approval-secret", nested: { password: "nested-secret" } },
      ...( { id: "attacker-id", ownerId: "owner-b", status: "approved", createdAt: "forged" } as Record<string, unknown>),
    } as never);
    expect(approval).toMatchObject({ ownerId: "owner-a", status: "pending", createdAt: now().toISOString() });
    expect(approval.request).toEqual({ token: "[REDACTED]", nested: { password: "[REDACTED]" } });
    const decided = await adapter.approvals.decide("owner-a", approval.approvalId, {
      approved: true,
      ownerId: "owner-b",
      id: "attacker-id",
      decidedAt: "forged",
    } as never);
    expect(decided).toMatchObject({ ownerId: "owner-a", status: "approved", decidedAt: now().toISOString() });
    expect(await adapter.approvals.list("owner-b")).toEqual([]);

    const audit = await adapter.audits.append("owner-a", {
      auditId: "audit-safe",
      callId: "call-safe",
      toolId: "tool-safe",
      principalId: "owner-a",
      requestId: "request-safe",
      decision: "allow",
      status: "executed",
      input: { apiKey: "audit-secret" },
      occurredAt: "forged",
      ...( { id: "attacker-id", ownerId: "owner-b", createdAt: "forged" } as Record<string, unknown>),
    } as never);
    expect(audit.occurredAt).toBe(now().toISOString());
    expect(audit.input).toEqual({ apiKey: "[REDACTED]" });
    const rawAudit = (await client.collection("audits").list())[0];
    expect(rawAudit.ownerId).toBe("owner-a");
    expect(rawAudit.id).not.toBe("attacker-id");
    expect(rawAudit.createdAt).toBeUndefined();

    const published = await adapter.events.publish("owner-a", {
      eventId: "event-safe",
      type: "tool.audit",
      occurredAt: "forged",
      data: { ownerId: "owner-b", authorization: "Bearer secret" },
      ...( { id: "attacker-event-id", ownerId: "owner-b", createdAt: "forged" } as Record<string, unknown>),
    } as never);
    expect(published.ownerId).toBe("owner-a");
    expect(published.event.occurredAt).toBe(now().toISOString());
    expect(published.event.data).toEqual({ ownerId: "owner-b", authorization: "[REDACTED]" });
    expect(await adapter.events.replay("owner-b", {}).then((events) => events)).toEqual([]);
    expect((await client.collection("events").list())[0].id).not.toBe("attacker-event-id");
  });

  test("rejects approval decisions without an atomic capability", async () => {
    const adapter = makeAdapter({ transaction: undefined });
    const approval = await adapter.approvals.create("owner-a", {
      approvalId: "approval-atomic",
      callId: "call-atomic",
      toolId: "tool-atomic",
      request: null,
    });

    await expect(adapter.approvals.decide("owner-a", approval.approvalId, { approved: true })).rejects.toMatchObject({
      code: "UNSUPPORTED_CAPABILITY",
      capability: "multi-process-concurrency",
      pocketBaseCapability: "approval.atomic-decision",
    });
    expect((await adapter.approvals.get("owner-a", approval.approvalId))?.status).toBe("pending");
  });

  test("bridges one authenticated owner into the core SessionStore contract", async () => {
    const adapter = makeAdapter();
    const store = createPocketBaseSessionStore(adapter, "owner-a");
    const run = createRunService({ executor: async ({ prompt }) => ({ text: prompt }), sessionStore: store, now });
    const context = { requestId: "request-1", principal: { id: "owner-a", kind: "user" as const }, sessionId: "shared-session" };

    await expect(run.run({ runId: "run-1", prompt: "hello", context })).resolves.toMatchObject({ resumed: false, state: "completed" });
    await expect(run.run({ runId: "run-2", prompt: "again", context: { ...context, requestId: "request-2" } })).resolves.toMatchObject({ resumed: true, state: "completed" });
    expect((await adapter.sessions.load("owner-a", "shared-session"))?.transcript.map((item) => item.content)).toEqual(["hello", "hello", "again", "again"]);
    expect(await adapter.sessions.load("owner-b", "shared-session")).toBeUndefined();
  });
});
