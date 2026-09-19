import { describe, expect, test } from "bun:test";
import type { RunEvent } from "../../subpolar-contracts/src/index.ts";
import { createRunService } from "../../subpolar-core/src/index.ts";
import { createPiRunPort, PiProviderError, PiRuntimeError } from "../src/index.ts";

const request = {
  runId: "run-pi",
  prompt: "hello",
  context: {
    requestId: "request-pi",
    principal: { id: "user-1", kind: "user" as const },
    sessionId: "session-1",
    projectId: "project-1",
    agentId: "agent-1",
    model: "model-1",
    permission: "standard",
    cwd: "/tmp/project",
  },
};

describe("Pi executor adapter", () => {
  test("maps the complete run context and streams correlated RunEvents", async () => {
    const seen: unknown[] = [];
    const events: RunEvent[] = [];
    const port = createPiRunPort(() => ({
      async execute(input) {
        seen.push(input.context);
        await input.emit({ type: "text", data: { text: "partial" } });
        return { text: "complete" };
      },
    }), { profile: "fake" });

    const result = await createRunService({ runPort: port, eventSink: (event) => events.push(event) }).run(request);

    expect(result).toMatchObject({ state: "completed", output: { text: "complete" } });
    expect(seen).toEqual([{ principal: request.context.principal, sessionId: request.context.sessionId, projectId: request.context.projectId, agentId: request.context.agentId, model: request.context.model, permission: request.context.permission, cwd: request.context.cwd }]);
    expect(events.map((event) => event.type)).toEqual(["run.started", "run.progress", "run.completed"]);
    expect(events[1]).toMatchObject({ runId: "run-pi", requestId: "request-pi", sessionId: "session-1", data: { type: "text", data: { text: "partial" } } });
  });

  test("passes abort through the adapter and preserves core cancellation semantics", async () => {
    const controller = new AbortController();
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    const port = createPiRunPort(() => ({
      execute({ signal }) {
        started();
        return new Promise((_, reject) => signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
      },
    }), undefined);
    const pending = createRunService({ runPort: port }).run({ ...request, signal: controller.signal });
    await startedPromise;
    controller.abort();

    await expect(pending).resolves.toMatchObject({ state: "interrupted", error: { code: "RUN_INTERRUPTED" } });
  });

  test("maps provider and runtime failures to typed errors", async () => {
    const provider = createPiRunPort(() => ({ execute: () => { throw { kind: "provider", message: "provider unavailable" }; } }), undefined);
    const runtime = createPiRunPort(() => ({ execute: () => { throw new Error("runtime unavailable"); } }), undefined);

    await expect(provider.run(request)).rejects.toBeInstanceOf(PiProviderError);
    await expect(runtime.run(request)).rejects.toBeInstanceOf(PiRuntimeError);
  });
});
