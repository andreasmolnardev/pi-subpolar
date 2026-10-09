import { describe, expect, test } from "bun:test";
import {
  AutomationAtomicClaimUnsupportedError,
  createPocketBaseAutomationPersistence,
  createPocketBaseAutomationRepositories,
  type PocketBaseAtomicClaimPort,
  type PocketBaseCollectionPort,
  type PocketBaseClientPort,
  type PocketBaseStoredRecord,
} from "../src/automations.ts";

class FakeCollection implements PocketBaseCollectionPort {
  private readonly records = new Map<string, PocketBaseStoredRecord>();
  private sequence = 0;
  async list() { return [...this.records.values()].map((record) => structuredClone(record)); }
  async get(id: string) { const record = this.records.get(id); return record && structuredClone(record); }
  async create(data: Record<string, unknown>) {
    const id = `pb-${++this.sequence}`;
    const record = { id, ...structuredClone(data) };
    this.records.set(id, record);
    return structuredClone(record);
  }
  async update(id: string, data: Record<string, unknown>) {
    const record = this.records.get(id);
    if (!record) return undefined;
    const updated = { ...record, ...structuredClone(data), id };
    this.records.set(id, updated);
    return structuredClone(updated);
  }
}

class FakeClient implements PocketBaseClientPort {
  private readonly collections = new Map<string, FakeCollection>();
  collection(name: string) {
    let value = this.collections.get(name);
    if (!value) { value = new FakeCollection(); this.collections.set(name, value); }
    return value;
  }
}

const instant = "2026-10-09T08:00:00.000Z";
const now = () => new Date(instant);

function atomicPort(): PocketBaseAtomicClaimPort {
  return {
    multiProcessSafe: true,
    async claim(collection, id, expected, data) {
      const record = await collection.get(id);
      if (!record || Object.entries(expected).some(([field, value]) => record[field] !== value)) return undefined;
      return collection.update(id, data);
    },
  };
}

describe("PocketBase automation persistence", () => {
  test("scopes records by owner and stores execution references to canonical runs", async () => {
    const store = createPocketBaseAutomationPersistence({ client: new FakeClient(), now });
    const definition = await store.definitions.create("owner-a", {
      id: "automation-a", name: "Daily summary", enabled: true, agentId: "research",
      promptTemplate: "Summarize {{ trigger.payload }}", trigger: { type: "manual", apiToken: "secret-value" },
      actions: [], executionConfig: {},
    });
    expect(definition.trigger).toEqual({ type: "manual", apiToken: "[REDACTED]" });
    expect(await store.definitions.get("owner-b", definition.id)).toBeUndefined();
    const occurrence = await store.occurrences.getOrCreate("owner-a", {
      automationId: definition.id, occurrenceKey: "manual:once", triggerType: "manual", receivedAt: instant, status: "pending",
    });
    const execution = await store.executions.create("owner-a", {
      id: "execution-a", automationId: definition.id, agentId: "research", occurrenceId: occurrence.id,
      canonicalRunId: "run-canonical-7", resolvedInput: { text: "news", webhookSecret: "never-store" }, status: "completed",
    });
    expect(execution).toMatchObject({ canonicalRunId: "run-canonical-7", resolvedInput: { text: "news", webhookSecret: "[REDACTED]" } });
    expect(await store.executions.get("owner-b", execution.id)).toBeUndefined();
  });

  test("deduplicates occurrence identities and requires an atomic claim provider", async () => {
    const client = new FakeClient();
    const store = createPocketBaseAutomationPersistence({ client, now, atomicClaim: atomicPort() });
    const first = await store.occurrences.getOrCreate("owner-a", {
      automationId: "automation-a", occurrenceKey: "schedule:2026-10-09T08:00:00Z", triggerType: "schedule", receivedAt: instant, status: "pending",
    });
    const duplicate = await store.occurrences.getOrCreate("owner-a", {
      automationId: "automation-a", occurrenceKey: "schedule:2026-10-09T08:00:00Z", triggerType: "schedule", receivedAt: instant, status: "pending",
    });
    expect(duplicate.id).toBe(first.id);
    const claimed = await store.occurrences.claim("owner-a", first.id, instant, "execution-a");
    expect(claimed).toMatchObject({ claimed: true, multiProcessSafe: true, occurrence: { status: "claimed", executionId: "execution-a" } });
    expect((await store.occurrences.claim("owner-a", first.id, instant, "execution-b")).claimed).toBe(false);
  });

  test("does not imply safe claims when no atomic adapter exists", async () => {
    const store = createPocketBaseAutomationPersistence({ client: new FakeClient(), now });
    const occurrence = await store.occurrences.getOrCreate("owner-a", {
      automationId: "automation-a", occurrenceKey: "event:1", triggerType: "event", receivedAt: instant, status: "pending",
    });
    expect(store.capabilities).toEqual({ atomicOccurrenceClaims: false, multiProcessSafe: false });
    await expect(store.occurrences.claim("owner-a", occurrence.id, instant, "execution-a")).rejects.toBeInstanceOf(AutomationAtomicClaimUnsupportedError);
  });

  test("persists action uncertainty and schedule recovery metadata", async () => {
    const store = createPocketBaseAutomationPersistence({ client: new FakeClient(), now });
    const action = await store.actions.create("owner-a", {
      id: "execution-a:post", executionId: "execution-a", actionId: "post", actionType: "webhook", ordinal: 0,
      status: "unknown", result: { deliveryToken: "private" },
    });
    expect(action).toMatchObject({ status: "unknown", result: { deliveryToken: "[REDACTED]" } });
    await store.schedules.set("owner-a", { automationId: "automation-a", nextRunAt: instant, lastOccurrenceKey: "schedule:previous" });
    expect(await store.schedules.get("owner-a", "automation-a")).toMatchObject({ nextRunAt: instant, lastOccurrenceKey: "schedule:previous" });
    expect(await store.schedules.get("owner-b", "automation-a")).toBeUndefined();
  });

  test("implements the first-class domain repository ports with canonical run references", async () => {
    const ports = createPocketBaseAutomationRepositories({ client: new FakeClient(), now, atomicClaim: atomicPort() });
    const automation = await ports.repository.create("owner-a", {
      name: "Webhook analysis", enabled: true, agentId: "analysis-agent", promptTemplate: "Analyze {{ trigger.payload }}",
      trigger: { type: "webhook", credentialRef: "webhook:secret-ref" }, actions: [],
    }, instant);
    expect(automation.trigger).toEqual({ type: "webhook", credentialRef: "webhook:secret-ref" });
    const claim = await ports.executionStore.claimOccurrence({
      ownerId: "owner-a", automation, occurrenceKey: "webhook:event-123",
      trigger: { kind: "webhook", payload: { event: "created" }, occurredAt: instant },
      resolvedInput: "Analyze {\"event\":\"created\"}", now: instant,
    });
    expect(claim.newlyClaimed).toBe(true);
    expect(claim.execution).toMatchObject({ automationId: automation.id, status: "pending", resolvedInput: "Analyze {\"event\":\"created\"}" });
    const completed = await ports.executionStore.transitionExecution({
      ownerId: "owner-a", executionId: claim.execution.id, from: ["pending"], to: "completed", now: instant, runId: "canonical-run-123",
    });
    expect(completed).toMatchObject({ runId: "canonical-run-123", status: "completed" });
    const duplicate = await ports.executionStore.claimOccurrence({
      ownerId: "owner-a", automation, occurrenceKey: "webhook:event-123",
      trigger: { kind: "webhook", payload: { event: "created" }, occurredAt: instant },
      resolvedInput: "Analyze {\"event\":\"created\"}", now: instant,
    });
    expect(duplicate).toMatchObject({ newlyClaimed: false, execution: { id: claim.execution.id, runId: "canonical-run-123" } });
  });
});
