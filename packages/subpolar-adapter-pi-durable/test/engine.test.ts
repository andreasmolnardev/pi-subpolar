import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import type { RuntimeExecution } from "@subpolar/contracts";
import { PiDurableAgentEngine } from "../src/index.ts";
import { openBunSqliteDatabase } from "../src/sqlite.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function setupModels() {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  return { faux, models };
}

function execution(requestId: string): RuntimeExecution {
  return {
    request: {
      runId: `run-${requestId}`,
      requestId,
      prompt: "hello durable agent",
      principal: { id: "owner-a", kind: "user" },
      sessionId: "session-a",
    },
    context: {
      requestId,
      principal: { id: "owner-a", kind: "user" },
      sessionId: "session-a",
      model: "faux/faux-1",
    },
    tools: { async call() { throw new Error("No tools should be called in this test"); } },
    async emit() {},
  };
}

async function databasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "subpolar-pi-durable-"));
  directories.push(directory);
  return join(directory, "engine.sqlite");
}

test("serializes Bun SQLite transactions and rolls back rejected callbacks", async () => {
  const db = await openBunSqliteDatabase(":memory:");
  await db.exec("CREATE TABLE values_table (value INTEGER)");
  const callbackError = new Error("rollback requested");
  let transactionHandle: import("@earendil-works/pi-durable/storage/sqlite").SqliteExecutor | undefined;
  const transaction = db.transaction(async (tx) => {
    transactionHandle = tx;
    await tx.run("INSERT INTO values_table VALUES (?)", 1);
    await Promise.resolve();
    await tx.run("INSERT INTO values_table VALUES (?)", 2);
    throw callbackError;
  });
  const read = db.all<{ value: number }>("SELECT value FROM values_table");
  await expect(transaction).rejects.toBe(callbackError);
  expect(await read).toEqual([]);
  await expect(transactionHandle!.get("SELECT 1")).rejects.toThrow("no longer active");
  await db.close();
});

test("initializes, configures, submits, waits, and reopens the owner/session mapping", async () => {
  const { faux, models } = setupModels();
  faux.setResponses([fauxAssistantMessage("persisted answer")]);
  const database = await databasePath();
  const engine = await PiDurableAgentEngine.initialize({ databasePath: database, models, tools: [] });
  const conversationId = await engine.configure("owner-a", "session-a", {
    model: { provider: "faux", modelId: "faux-1" },
    instructions: "Be concise.",
  });

  await engine.submit({
    ownerId: "owner-a",
    sessionId: "session-a",
    requestId: "stable-request-1",
    runId: "stable-run-1",
    prompt: "hello durable agent",
  }, execution("stable-request-1"));
  await expect(engine.configure("owner-a", "session-a", { model: { provider: "faux", modelId: "faux-1" } })).rejects.toThrow("already active");
  await expect(engine.submit({
    ownerId: "owner-a",
    sessionId: "session-a",
    requestId: "different-request",
    runId: "different-run",
    prompt: "must not overlap",
  }, execution("different-request"))).rejects.toThrow("different Durable execution is already active");
  const result = await engine.wait("owner-a", "session-a", "stable-request-1");
  expect(result).toMatchObject({ status: "done", output: "persisted answer", conversationId });
  await engine.close();

  const reopened = await PiDurableAgentEngine.initialize({ databasePath: database, models, tools: [] });
  expect(await reopened.configure("owner-a", "session-a", { model: { provider: "faux", modelId: "faux-1" } })).toBe(conversationId);
  expect(await reopened.recover("owner-a", "session-a", "stable-request-1")).toBe(result.submissionId);
  expect(await reopened.recover("owner-b", "session-a", "stable-request-1")).toBeUndefined();
  await reopened.close();
});

test("abort is scoped to the mapped owner/session conversation", async () => {
  const { models } = setupModels();
  const engine = await PiDurableAgentEngine.initialize({ databasePath: await databasePath(), models, tools: [] });
  const first = await engine.configure("owner-a", "session-a", { model: { provider: "faux", modelId: "faux-1" } });
  const other = await engine.configure("owner-a", "session-b", { model: { provider: "faux", modelId: "faux-1" } });
  expect(other).not.toBe(first);
  await engine.abort("owner-a", "session-a");
  expect(await engine.configure("owner-a", "session-a", { model: { provider: "faux", modelId: "faux-1" } })).toBe(first);
  await engine.close();
});
