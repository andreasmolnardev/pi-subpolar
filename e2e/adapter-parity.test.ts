import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalAdapter, EphemeralSessionStore } from "../packages/subpolar-adapter-local/src/index.ts";
import {
  createPocketBaseAdapter,
  PocketBaseUnsupportedCapabilityError,
  type PocketBaseAdapter,
} from "../packages/subpolar-adapter-pocketbase/src/index.ts";
import type { AdapterCapabilities, MemoryRecord, SessionTranscriptEntry } from "../packages/subpolar-contracts/src/index.ts";
import { InMemoryPocketBaseClient } from "./adapter-parity-fixture.ts";

const timestamp = "2026-01-01T00:00:00.000Z";
const entry: SessionTranscriptEntry = { role: "user", content: "hello", occurredAt: timestamp };
const memory = (id: string, ownerId: string): MemoryRecord => ({
  id,
  ownerId,
  scope: "user",
  content: "remember this",
  metadata: { source: "test" },
  createdAt: timestamp,
  updatedAt: timestamp,
  version: 1,
  tombstone: false,
});

interface ParityHarness {
  capabilities: AdapterCapabilities;
  appendSession(ownerId: string, entries: SessionTranscriptEntry[]): Promise<unknown>;
  loadSession(ownerId: string): Promise<unknown>;
  saveMemory(record: MemoryRecord): Promise<unknown>;
  listMemory(ownerId: string): Promise<readonly MemoryRecord[]>;
  rejectMalformedSession(): Promise<unknown>;
  rejectMalformedMemory(): Promise<unknown>;
  cleanup(): Promise<void>;
}

async function localHarness(): Promise<ParityHarness> {
  const directory = await mkdtemp(join(tmpdir(), "subpolar-adapter-parity-local-"));
  const sessionFile = join(directory, "sessions.json");
  const memoryFile = join(directory, "memory.json");
  const adapter = createLocalAdapter({ sessionFile, memoryFile });
  return {
    capabilities: adapter.capabilities,
    appendSession: (_ownerId, entries) => adapter.sessions.append("session-1", entries),
    loadSession: (_ownerId) => createLocalAdapter({ sessionFile, memoryFile }).sessions.load("session-1"),
    saveMemory: (record) => adapter.memory.save(record),
    listMemory: (ownerId) => adapter.memory.list(ownerId),
    rejectMalformedSession: async () => {
      await writeFile(sessionFile, JSON.stringify({ broken: { sessionId: "broken", transcript: null, updatedAt: timestamp } }));
      return adapter.sessions.load("broken");
    },
    rejectMalformedMemory: async () => {
      await writeFile(memoryFile, JSON.stringify([{ ...memory("broken", "owner-a"), content: 7 }]));
      return adapter.memory.list("owner-a");
    },
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

function pocketBaseHarness(): ParityHarness {
  const client = new InMemoryPocketBaseClient();
  const adapter = createPocketBaseAdapter({
    client,
    collections: { sessions: "sessions", memories: "memories" },
    now: () => new Date(timestamp),
  });
  return {
    capabilities: adapter.capabilities,
    appendSession: (ownerId, entries) => adapter.sessions.append(ownerId, "session-1", entries),
    loadSession: (ownerId) => adapter.sessions.load(ownerId, "session-1"),
    saveMemory: (record) => adapter.memories.save(record.ownerId, record),
    listMemory: (ownerId) => adapter.memories.list(ownerId),
    rejectMalformedSession: async () => {
      client.collection("sessions").seed({ id: "broken", ownerId: "owner-a", sessionId: "session-1", transcript: null, updatedAt: timestamp });
      return adapter.sessions.load("owner-a", "session-1");
    },
    rejectMalformedMemory: async () => {
      client.collection("memories").seed({ ...memory("broken", "owner-a"), content: 7 });
      return adapter.memories.list("owner-a");
    },
    cleanup: async () => undefined,
  };
}

async function eachHarness(run: (name: string, harness: ParityHarness) => Promise<void>): Promise<void> {
  for (const [name, create] of [["local-json", localHarness], ["pocketbase", async () => pocketBaseHarness()]] as const) {
    const harness = await create();
    try {
      await run(name, harness);
    } finally {
      await harness.cleanup();
    }
  }
}

describe("dependency-free adapter parity", () => {
  test("appends and loads sessions through both adapters", async () => {
    await eachHarness(async (_name, harness) => {
      await harness.appendSession("owner-a", [entry]);
      expect(await harness.loadSession("owner-a")).toMatchObject({ transcript: [entry] });
    });
  });

  test("saves, lists, and isolates memory by owner", async () => {
    await eachHarness(async (_name, harness) => {
      await harness.saveMemory(memory("memory-a", "owner-a"));
      await harness.saveMemory(memory("memory-b", "owner-b"));
      expect(await harness.listMemory("owner-a")).toHaveLength(1);
      expect(await harness.listMemory("owner-b")).toHaveLength(1);
      expect(await harness.listMemory("owner-c")).toEqual([]);
    });
  });

  test("reports durable capabilities and rejects malformed persisted records", async () => {
    await eachHarness(async (name, harness) => {
      expect(harness.capabilities.supports["session.persistence"]).toBe(true);
      expect(harness.capabilities.supports["memory.persistence"]).toBe(true);
      await expect(harness.rejectMalformedSession()).rejects.toThrow();
      await expect(harness.rejectMalformedMemory()).rejects.toThrow();
      expect(name).toMatch(/local-json|pocketbase/);
    });
  });

  test("reports local ephemeral durability and fails unsupported persistence explicitly", async () => {
    const adapter = createLocalAdapter();
    expect(adapter.capabilities).toMatchObject({ adapter: "local-ephemeral", durability: "ephemeral" });
    expect(adapter.capabilities.supports["session.persistence"]).toBe(false);
    expect(adapter.capabilities.supports["memory.persistence"]).toBe(false);
    await adapter.sessions.append("session-1", [entry]);
    await expect((adapter.sessions as EphemeralSessionStore).persist()).rejects.toMatchObject({
      code: "UNSUPPORTED_CAPABILITY",
      capability: "session.persistence",
      adapter: "local-ephemeral",
    });
  });

  test("redacts sensitive PocketBase data before persistence", async () => {
    const client = new InMemoryPocketBaseClient();
    const adapter = createPocketBaseAdapter({ client, collections: { memories: "memories", events: "events" }, now: () => new Date(timestamp) });
    await adapter.memories.save("owner-a", { ...memory("ignored", "owner-a"), metadata: { apiKey: "secret", nested: { password: "secret" } } });
    await adapter.events.publish("owner-a", {
      eventId: "event-1", type: "test", occurredAt: timestamp, data: { authorization: "Bearer secret" },
    });
    expect((await adapter.memories.list("owner-a"))[0]?.metadata).toEqual({ apiKey: "[REDACTED]", nested: { password: "[REDACTED]" } });
    expect((await client.collection("events").list())[0]?.data).toEqual({ authorization: "[REDACTED]" });
  });

  test("replays PocketBase events only when explicitly enabled", async () => {
    const client = new InMemoryPocketBaseClient();
    const make = (eventReplay: boolean): PocketBaseAdapter => createPocketBaseAdapter({
      client,
      collections: { events: "events" },
      eventReplay,
      now: () => new Date(timestamp),
    });
    const disabled = make(false);
    expect(disabled.capabilities.supports["event.replay"]).toBe(false);
    await disabled.events.publish("owner-a", { eventId: "event-disabled", type: "test", occurredAt: timestamp, data: null });
    await expect(disabled.events.replay("owner-a")).rejects.toBeInstanceOf(PocketBaseUnsupportedCapabilityError);

    const enabled = make(true);
    expect(enabled.capabilities.supports["event.replay"]).toBe(true);
    await enabled.events.publish("owner-a", { eventId: "event-enabled", type: "test", occurredAt: timestamp, data: null });
    expect((await enabled.events.replay("owner-a")).map((event) => event.event.eventId)).toEqual(["event-disabled", "event-enabled"]);
  });
});
