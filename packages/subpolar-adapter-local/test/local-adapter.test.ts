import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalAdapter, EphemeralSessionStore } from "../src/index.ts";

const entry = { role: "user" as const, content: "hello", occurredAt: "2026-01-01T00:00:00.000Z" };

describe("local adapter", () => {
  test("ephemeral sessions do not persist across adapter instances", async () => {
    const first = createLocalAdapter();
    await first.sessions.append("session-1", [entry]);

    expect(first.capabilities.durability).toBe("ephemeral");
    expect(await first.sessions.load("session-1")).toBeDefined();
    expect(await createLocalAdapter().sessions.load("session-1")).toBeUndefined();
    await expect((first.sessions as EphemeralSessionStore).persist()).rejects.toMatchObject({ code: "UNSUPPORTED_CAPABILITY" });
  });

  test("explicit JSON persistence resumes transcripts without provider secrets", async () => {
    const directory = await mkdtemp(join(tmpdir(), "subpolar-local-"));
    const filePath = join(directory, "sessions.json");
    try {
      const first = createLocalAdapter({ sessionFile: filePath });
      await first.sessions.append("session-1", [entry]);
      const second = createLocalAdapter({ sessionFile: filePath });
      expect((await second.sessions.load("session-1"))?.transcript).toHaveLength(1);
      expect(second.capabilities.supports["session.persistence"]).toBe(true);
      expect(await readFile(filePath, "utf8")).not.toContain("providerSecret");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("rejects malformed records and prototype session keys", async () => {
    const directory = await mkdtemp(join(tmpdir(), "subpolar-local-"));
    const filePath = join(directory, "sessions.json");
    try {
      await writeFile(filePath, JSON.stringify({ broken: { sessionId: "broken", transcript: null, updatedAt: "2026-01-01T00:00:00.000Z" } }));
      const store = createLocalAdapter({ sessionFile: filePath }).sessions;
      await expect(store.load("broken")).rejects.toThrow("Invalid session record");

      await writeFile(filePath, '{"__proto__":{"sessionId":"__proto__","transcript":[],"updatedAt":"2026-01-01T00:00:00.000Z"}}');
      await expect(store.load("broken")).rejects.toThrow("safe non-empty identifier");
      await expect(store.load("__proto__")).rejects.toThrow("safe non-empty identifier");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("serializes concurrent appends on one JSON store instance", async () => {
    const directory = await mkdtemp(join(tmpdir(), "subpolar-local-"));
    const filePath = join(directory, "sessions.json");
    try {
      const store = createLocalAdapter({ sessionFile: filePath }).sessions;
      await Promise.all(
        Array.from({ length: 20 }, (_, index) => store.append("session-concurrent", [{ ...entry, content: `entry-${index}` }])),
      );

      const record = await store.load("session-concurrent");
      expect(record?.transcript).toHaveLength(20);
      expect(new Set(record?.transcript.map((item) => item.content)).size).toBe(20);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
