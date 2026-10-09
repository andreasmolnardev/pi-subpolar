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

function createApprovalCoordinator() {
  const pending = new Map<string, (resolution: "approved" | "rejected" | "expired") => void>();
  return {
    pending,
    wait(approvalId: string) {
      return new Promise<"approved" | "rejected" | "expired">((resolve) => pending.set(approvalId, resolve));
    },
    cancel(approvalId: string) { pending.delete(approvalId); },
    notify(approvalId: string, resolution: "approved" | "rejected" | "expired") {
      const resolve = pending.get(approvalId);
      if (!resolve) return false;
      pending.delete(approvalId);
      resolve(resolution);
      return true;
    },
  };
}

async function viWaitForApprovalWaiter(approvalId: string, pending: Map<string, unknown>): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!pending.has(approvalId) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  expect(pending.has(approvalId)).toBe(true);
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

test("accepts valid unconstrained JSON Schema arrays in gateway tools", async () => {
  const { faux, models } = setupModels();
  faux.setResponses([fauxAssistantMessage("schema accepted")]);
  const tool: ToolDefinition = {
    id: "web.search",
    namespace: "subpolar-gateway",
    description: "Search the web",
    inputSchema: {
      type: "object",
      properties: { domains: { type: "array", description: "Optional domain filters" } },
      additionalProperties: false,
    },
    enabled: true,
    risk: "low",
  };
  const engine = await PiDurableAgentEngine.initialize({ databasePath: await databasePath(), models, tools: [tool] });
  await engine.configure("owner-a", "session-a", { model: { provider: "faux", modelId: "faux-1" } });
  await engine.submit({
    ownerId: "owner-a", sessionId: "session-a", requestId: "request-unconstrained-array", runId: "run-unconstrained-array", prompt: "answer without tools",
  }, execution("request-unconstrained-array", "run-unconstrained-array"));
  await expect(engine.wait("owner-a", "session-a", "request-unconstrained-array"))
    .resolves.toMatchObject({ status: "done", output: "schema accepted" });
  await engine.close();
});

test("projects committed events in order, omits attachment snapshots, and drains the watch on wait", async () => {
  const { faux, models } = setupModels();
  faux.setResponses([fauxAssistantMessage("projected answer")]);
  const emitted: import("@subpolar/contracts").JsonValue[] = [];
  const run = execution("request-events", "run-events");
  run.emit = async (event) => { emitted.push(event); };
  const engine = await PiDurableAgentEngine.initialize({ databasePath: await databasePath(), models, tools: [] });
  await engine.configure("owner-a", "session-a", {
    model: { provider: "faux", modelId: "faux-1" },
    instructions: "private system instruction that must not be streamed",
  });

  await engine.submit({
    ownerId: "owner-a", sessionId: "session-a", requestId: "request-events", runId: "run-events", prompt: "emit committed events",
  }, run);
  await expect(engine.wait("owner-a", "session-a", "request-events"))
    .resolves.toMatchObject({ status: "done", output: "projected answer" });

  const events = emitted.map((event) => event as { type?: string });
  const types = events.map((event) => event.type);
  expect(types).not.toContain("snapshot");
  expect(types.indexOf("submission")).toBeGreaterThanOrEqual(0);
  expect(types.indexOf("run_start")).toBeGreaterThan(types.indexOf("submission"));
  expect(types.lastIndexOf("message_start")).toBeGreaterThan(types.indexOf("turn_start"));
  expect(types.lastIndexOf("message_end")).toBeGreaterThan(types.lastIndexOf("message_start"));
  expect(types.indexOf("turn_end")).toBeGreaterThan(types.lastIndexOf("message_end"));
  for (const event of emitted) expect(() => JSON.stringify(event)).not.toThrow();
  expect(JSON.stringify(emitted)).not.toContain("private system instruction that must not be streamed");

  const countAfterWait = emitted.length;
  await engine.abort("owner-a", "session-a");
  expect(emitted).toHaveLength(countAfterWait);

  faux.setResponses([fauxAssistantMessage("second projected answer")]);
  const secondEmitted: import("@subpolar/contracts").JsonValue[] = [];
  const secondRun = execution("request-events-2", "run-events-2");
  secondRun.emit = async (event) => { secondEmitted.push(event); };
  await engine.submit({
    ownerId: "owner-a", sessionId: "session-a", requestId: "request-events-2", runId: "run-events-2", prompt: "emit a second request",
  }, secondRun);
  await expect(engine.wait("owner-a", "session-a", "request-events-2"))
    .resolves.toMatchObject({ status: "done", output: "second projected answer" });
  expect(emitted).toHaveLength(countAfterWait);
  expect(secondEmitted.map((event) => (event as { type?: string }).type)).toContain("run_start");
  await engine.close();
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
    fauxAssistantMessage(fauxToolCall("demo_echo", { text: "hello from model" }, { id: "model-call-1" }), { stopReason: "toolUse" }),
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
    idempotencyKey: `tool-call:pi-durable:${conversationId}:stable-request-tool:model-call-1`,
    callId: `pi-durable:${conversationId}:stable-request-tool:model-call-1`,
  });
  expect(JSON.stringify(followUpMessages)).toContain('"role":"toolResult"');
  expect(JSON.stringify(followUpMessages)).toContain("tool-result");
  expect(faux.state.callCount).toBe(2);
  await engine.close();
});

test("pauses an approved Durable tool call and retries the exact gateway call through the invoker", async () => {
  const { faux, models } = setupModels();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("demo_echo", { text: "approved input" }, { id: "approval-model-call" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("approved tool result returned"),
  ]);
  const tool: ToolDefinition = {
    id: "demo.echo", namespace: "demo", description: "Echo", inputSchema: { type: "object", properties: { text: { type: "string" } } }, enabled: true, risk: "low",
  };
  const calls: ToolCall[] = [];
  const effects: string[] = [];
  const approval = createApprovalCoordinator();
  let approvalId = "";
  const run = execution("approval-request", "approval-run");
  run.tools = {
    async call(call) {
      calls.push(call);
      if (calls.length === 1) {
        approvalId = `approval-${call.callId}`;
        expect(approval.pending.has(approvalId)).toBe(true);
        return { ok: false, status: "approval_required", approvalId, error: { code: "APPROVAL_REQUIRED", message: "waiting" } };
      }
      effects.push("gateway side effect");
      return { ok: true, status: "executed", value: "done" };
    },
  };
  const engine = await PiDurableAgentEngine.initialize({ databasePath: await databasePath(), models, tools: [tool] });
  const conversationId = await engine.configure("owner-a", "session-a", { model: { provider: "faux", modelId: "faux-1" } });
  approvalId = `approval-pi-durable:${conversationId}:approval-request:approval-model-call`;
  await engine.submit({ ownerId: "owner-a", sessionId: "session-a", requestId: "approval-request", runId: "approval-run", prompt: "call approved tool", approval }, run);
  await viWaitForApprovalWaiter(approvalId, approval.pending);
  expect(calls).toHaveLength(1);
  expect(approval.notify(approvalId, "approved")).toBe(true);
  await expect(engine.wait("owner-a", "session-a", "approval-request"))
    .resolves.toMatchObject({ status: "done", output: "approved tool result returned" });

  expect(calls).toHaveLength(2);
  expect(calls[1]).toBe(calls[0]);
  expect(calls[0]).toMatchObject({
    callId: `pi-durable:${conversationId}:approval-request:approval-model-call`,
    toolId: "demo.echo",
    input: { text: "approved input" },
    runId: "approval-run",
    requestId: "approval-request",
    idempotencyKey: `tool-call:pi-durable:${conversationId}:approval-request:approval-model-call`,
  });
  expect(effects).toEqual(["gateway side effect"]);
  expect(approval.pending.has(approvalId)).toBe(false);
  await engine.close();
});

test("handles a decision notified during the initial gateway call without missing it", async () => {
  const { faux, models } = setupModels();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("demo_echo", { text: "race input" }, { id: "race-call" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("race resumed"),
  ]);
  const tool: ToolDefinition = { id: "demo.echo", namespace: "demo", description: "Echo", inputSchema: { type: "object", properties: {} }, enabled: true, risk: "low" };
  const calls: ToolCall[] = [];
  const approval = createApprovalCoordinator();
  const run = execution("race-request", "race-run");
  run.tools = { async call(call) {
    calls.push(call);
    const approvalId = `approval-${call.callId}`;
    if (calls.length === 1) {
      expect(approval.pending.has(approvalId)).toBe(true);
      expect(approval.notify(approvalId, "approved")).toBe(true);
      return { ok: false, status: "approval_required", approvalId, error: { code: "APPROVAL_REQUIRED", message: "waiting" } };
    }
    return { ok: true, status: "executed", value: "done" };
  } };
  const engine = await PiDurableAgentEngine.initialize({ databasePath: await databasePath(), models, tools: [tool] });
  await engine.configure("owner-a", "session-a", { model: { provider: "faux", modelId: "faux-1" } });
  await engine.submit({ ownerId: "owner-a", sessionId: "session-a", requestId: "race-request", runId: "race-run", prompt: "exercise notification race", approval }, run);
  await expect(engine.wait("owner-a", "session-a", "race-request"))
    .resolves.toMatchObject({ status: "done", output: "race resumed" });
  expect(calls).toHaveLength(2);
  expect(calls[0]).toBe(calls[1]);
  await engine.close();
});

test.each([
  ["rejected", "APPROVAL_REJECTED"],
  ["expired", "APPROVAL_EXPIRED"],
] as const)("returns a safe tool error for %s approval without invoking a side effect", async (resolution, expectedCode) => {
  const { faux, models } = setupModels();
  let followUp: unknown;
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("demo_echo", { text: "not executed" }, { id: `denied-${resolution}` }), { stopReason: "toolUse" }),
    (context) => { followUp = context.messages; return fauxAssistantMessage("handled safe error"); },
  ]);
  const tool: ToolDefinition = { id: "demo.echo", namespace: "demo", description: "Echo", inputSchema: { type: "object", properties: {} }, enabled: true, risk: "low" };
  const calls: ToolCall[] = [];
  const effects: string[] = [];
  const approval = createApprovalCoordinator();
  const run = execution(`denied-${resolution}-request`, `denied-${resolution}-run`);
  run.tools = { async call(call) {
    calls.push(call);
    if (calls.length === 1) return { ok: false, status: "approval_required", approvalId: `approval-${call.callId}`, error: { code: "APPROVAL_REQUIRED", message: "waiting" } };
    effects.push("must not happen");
    return { ok: true };
  } };
  const engine = await PiDurableAgentEngine.initialize({ databasePath: await databasePath(), models, tools: [tool] });
  const conversationId = await engine.configure("owner-a", "session-a", { model: { provider: "faux", modelId: "faux-1" } });
  const approvalId = `approval-pi-durable:${conversationId}:${run.context.requestId}:denied-${resolution}`;
  await engine.submit({ ownerId: "owner-a", sessionId: "session-a", requestId: run.context.requestId, runId: run.context.runId!, prompt: "wait for decision", approval }, run);
  await viWaitForApprovalWaiter(approvalId, approval.pending);
  expect(approval.notify(approvalId, resolution)).toBe(true);
  await expect(engine.wait("owner-a", "session-a", run.context.requestId)).resolves.toMatchObject({ status: "done" });
  expect(calls).toHaveLength(1);
  expect(effects).toEqual([]);
  expect(JSON.stringify(followUp)).toContain(expectedCode);
  expect(approval.pending.has(approvalId)).toBe(false);
  await engine.close();
});

test("does not retry an approval-required call after the request aborts", async () => {
  const { faux, models } = setupModels();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("demo_echo", { text: "aborted" }, { id: "abort-approval-call" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("approval wait safely interrupted"),
  ]);
  const tool: ToolDefinition = { id: "demo.echo", namespace: "demo", description: "Echo", inputSchema: { type: "object", properties: {} }, enabled: true, risk: "low" };
  const controller = new AbortController();
  const calls: ToolCall[] = [];
  const approval = createApprovalCoordinator();
  const run = execution("abort-approval-request", "abort-approval-run");
  run.request = { ...run.request, signal: controller.signal };
  run.tools = { async call(call) {
    calls.push(call);
    return { ok: false, status: "approval_required", approvalId: `approval-${call.callId}`, error: { code: "APPROVAL_REQUIRED", message: "waiting" } };
  } };
  const engine = await PiDurableAgentEngine.initialize({ databasePath: await databasePath(), models, tools: [tool] });
  const conversationId = await engine.configure("owner-a", "session-a", { model: { provider: "faux", modelId: "faux-1" } });
  const approvalId = `approval-pi-durable:${conversationId}:abort-approval-request:abort-approval-call`;
  await engine.submit({ ownerId: "owner-a", sessionId: "session-a", requestId: "abort-approval-request", runId: "abort-approval-run", prompt: "wait until abort", signal: controller.signal, approval }, run);
  await viWaitForApprovalWaiter(approvalId, approval.pending);
  controller.abort();
  await expect(engine.wait("owner-a", "session-a", "abort-approval-request"))
    .resolves.toMatchObject({ status: "done", output: "approval wait safely interrupted" });
  expect(calls).toHaveLength(1);
  expect(approval.pending.has(approvalId)).toBe(false);
  await engine.close();
});

test("reads committed transcript entries in chronological order and preserves them after reopen", async () => {
  const { faux, models } = setupModels();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("demo_echo", { text: "transcript request" }, { id: "transcript-call-1" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("transcript answer"),
  ]);
  const tool: ToolDefinition = {
    id: "demo.echo",
    namespace: "demo",
    description: "Echo text for the transcript test.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    },
    enabled: true,
    risk: "low",
  };
  const run = execution("request-transcript", "run-transcript");
  run.tools = { async call() { return { ok: true, value: "transcript tool result" }; } };
  const database = await databasePath();
  const engine = await PiDurableAgentEngine.initialize({ databasePath: database, models, tools: [tool] });
  await engine.configure("owner-a", "session-a", { model: { provider: "faux", modelId: "faux-1" } });
  await engine.submit({
    ownerId: "owner-a", sessionId: "session-a", requestId: "request-transcript", runId: "run-transcript", prompt: "record this transcript",
  }, run);
  await expect(engine.wait("owner-a", "session-a", "request-transcript"))
    .resolves.toMatchObject({ status: "done", output: "transcript answer" });

  const transcript = await engine.readTranscript("owner-a", "session-a");
  expect(transcript.length).toBeGreaterThanOrEqual(4);
  expect(new Set(transcript.map((entry) => entry.id)).size).toBe(transcript.length);
  const messages = transcript.flatMap((entry) => entry.messages);
  const relevantMessages = messages.filter((message) => ["user", "assistant", "toolResult"].includes(message.role));
  expect(relevantMessages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
  expect(JSON.stringify(relevantMessages)).toContain("transcript request");
  expect(JSON.stringify(relevantMessages)).toContain("transcript tool result");
  expect(JSON.stringify(relevantMessages)).toContain("transcript answer");
  expect(transcript.some((entry) => entry.kind === "pi.user")).toBe(true);
  expect(transcript.some((entry) => entry.kind === "pi.assistant")).toBe(true);
  expect(transcript.some((entry) => entry.kind === "pi.tool-result")).toBe(true);
  await engine.close();

  const reopened = await PiDurableAgentEngine.initialize({ databasePath: database, models, tools: [tool] });
  expect(await reopened.readTranscript("owner-a", "session-a")).toEqual(transcript);
  await reopened.close();
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
