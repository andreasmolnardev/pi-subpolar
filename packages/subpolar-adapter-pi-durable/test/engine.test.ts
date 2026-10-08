import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { RuntimeExecution, ToolDefinition, ToolCall } from "@subpolar/contracts";
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

function execution(requestId: string, runId = `run-${requestId}`): RuntimeExecution {
  return {
    request: {
      runId,
      requestId,
      prompt: "hello durable agent",
      principal: { id: "owner-a", kind: "user" },
      sessionId: "session-a",
    },
    context: {
      requestId,
      runId,
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
  }, execution("stable-request-1", "stable-run-1"));
  await expect(engine.configure("owner-a", "session-a", { model: { provider: "faux", modelId: "faux-1" } })).rejects.toThrow("already active");
  await expect(engine.submit({
    ownerId: "owner-a",
    sessionId: "session-a",
    requestId: "different-request",
    runId: "different-run",
    prompt: "must not overlap",
  }, execution("different-request", "different-run"))).rejects.toThrow("different Durable execution is already active");
  const result = await engine.wait("owner-a", "session-a", "stable-request-1");
  expect(result).toMatchObject({ status: "done", output: "persisted answer", conversationId });
  await engine.close();

  const reopened = await PiDurableAgentEngine.initialize({ databasePath: database, models, tools: [] });
  expect(await reopened.configure("owner-a", "session-a", { model: { provider: "faux", modelId: "faux-1" } })).toBe(conversationId);
  expect(await reopened.recover("owner-a", "session-a", "stable-request-1")).toBe(result.submissionId);
  expect(await reopened.recover("owner-b", "session-a", "stable-request-1")).toBeUndefined();
  await reopened.close();
});

test("rejects mismatched gateway identity before binding or submitting work", async () => {
  const { faux, models } = setupModels();
  faux.setResponses([fauxAssistantMessage("identity check passed")]);
  const engine = await PiDurableAgentEngine.initialize({ databasePath: await databasePath(), models, tools: [] });
  await engine.configure("owner-a", "session-a", { model: { provider: "faux", modelId: "faux-1" } });
  const request = {
    ownerId: "owner-b",
    sessionId: "session-a",
    requestId: "identity-request",
    runId: "identity-run",
    prompt: "hello",
  };

  await expect(engine.submit(request, execution("identity-request", "identity-run")))
    .rejects.toThrow("request owner does not match the RuntimeExecution principal");
  await expect(engine.recover("owner-b", "session-a", "identity-request")).resolves.toBeUndefined();

  await engine.submit({ ...request, ownerId: "owner-a" }, execution("identity-request", "identity-run"));
  await expect(engine.wait("owner-a", "session-a", "identity-request"))
    .resolves.toMatchObject({ status: "done", output: "identity check passed" });
  await engine.close();
});

test("invokes one registered Durable tool with stable Subpolar identity and returns its result to the model", async () => {
  const { faux, models } = setupModels();
  const toolResult = { ok: true, value: "tool-result" };
  let followUpMessages: unknown;
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("demo.echo", { text: "hello from model" }, { id: "model-call-1" }), { stopReason: "toolUse" }),
    (context) => {
      followUpMessages = context.messages;
      return fauxAssistantMessage("model used tool result");
    },
  ]);
  const tool: ToolDefinition = {
    id: "demo.echo",
    namespace: "demo",
    description: "Echo text for the test.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    },
    enabled: true,
    risk: "low",
  };
  const calls: ToolCall[] = [];
  const run = execution("stable-request-tool", "stable-run-tool");
  run.tools = {
    async call(call) {
      calls.push(call);
      return toolResult;
    },
  };
  const engine = await PiDurableAgentEngine.initialize({ databasePath: await databasePath(), models, tools: [tool] });
  const conversationId = await engine.configure("owner-a", "session-a", {
    model: { provider: "faux", modelId: "faux-1" },
  });

  await engine.submit({
    ownerId: "owner-a",
    sessionId: "session-a",
    requestId: "stable-request-tool",
    runId: "stable-run-tool",
    prompt: "Call the echo tool.",
  }, run);
  const result = await engine.wait("owner-a", "session-a", "stable-request-tool");

  expect(result).toMatchObject({ status: "done", output: "model used tool result" });
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({
    toolId: "demo.echo",
    input: { text: "hello from model" },
    runId: "stable-run-tool",
    requestId: "stable-request-tool",
    idempotencyKey: `pi-durable:${conversationId}:stable-request-tool:model-call-1`,
    callId: `pi-durable:${conversationId}:stable-request-tool:model-call-1`,
  });
  expect(JSON.stringify(followUpMessages)).toContain('"role":"toolResult"');
  expect(JSON.stringify(followUpMessages)).toContain("tool-result");
  expect(faux.state.callCount).toBe(2);
  await engine.close();
});

test("does not invoke disabled or unregistered Durable tool names", async () => {
  const { faux, models } = setupModels();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("demo.disabled", { text: "disabled" }, { id: "model-call-disabled" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("demo.missing", { text: "missing" }, { id: "model-call-missing" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("no gateway tool was invoked"),
  ]);
  const disabledTool: ToolDefinition = {
    id: "demo.disabled",
    namespace: "demo",
    description: "Disabled test tool.",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    enabled: false,
    risk: "low",
  };
  const calls: ToolCall[] = [];
  const run = execution("request-unavailable-tools", "run-unavailable-tools");
  run.tools = { async call(call) { calls.push(call); return { ok: true }; } };
  const engine = await PiDurableAgentEngine.initialize({ databasePath: await databasePath(), models, tools: [disabledTool] });
  await engine.configure("owner-a", "session-a", { model: { provider: "faux", modelId: "faux-1" } });

  await engine.submit({
    ownerId: "owner-a",
    sessionId: "session-a",
    requestId: "request-unavailable-tools",
    runId: "run-unavailable-tools",
    prompt: "Do not call unavailable tools.",
  }, run);
  const result = await engine.wait("owner-a", "session-a", "request-unavailable-tools");

  expect(result).toMatchObject({ status: "done", output: "no gateway tool was invoked" });
  expect(calls).toEqual([]);
  expect(faux.state.callCount).toBe(3);
  await engine.close();
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
