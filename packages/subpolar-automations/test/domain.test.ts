import { describe, expect, test } from "bun:test";
import {
  AutomationExecutionService,
  createCoreTriggerRegistry,
  evaluateCondition,
  renderTemplate,
  validateAutomationInput,
  type AutomationDefinition,
  type AutomationExecution,
} from "../src/index.ts";

const context = {
  trigger: { kind: "event" as const, payload: { title: "Build complete", important: true }, occurredAt: "2026-01-01T00:00:00.000Z" },
  execution: { id: "execution-1", automationId: "automation-1", ownerId: "owner-1", agentId: "agent-1", occurrenceKey: "event:1" },
  agent: { id: "agent-1" },
  output: { text: "A concise summary", structured: { important: true } },
};

describe("automation domain", () => {
  test("validates required agent, trigger, execution limits, and action definitions", () => {
    expect(validateAutomationInput({
      name: "Morning report",
      agentId: "agent-1",
      projectId: "project-1",
      executionConfig: { timeoutMs: 20_000 },
      promptTemplate: "Summarize {{ trigger.payload.title }}",
      trigger: { type: "schedule", cron: "0 8 * * *", timezone: "Europe/Berlin" },
      actions: [{ id: "notify", type: "notification", titleTemplate: "Report", bodyTemplate: "{{ output.text }}" }],
    })).toMatchObject({ agentId: "agent-1", projectId: "project-1", executionConfig: { timeoutMs: 20_000 } });
    expect(() => validateAutomationInput({ name: "No agent", promptTemplate: "hello", trigger: { type: "manual" } })).toThrow();
    expect(() => validateAutomationInput({
      name: "Bad timeout", agentId: "agent-1", promptTemplate: "hello", trigger: { type: "manual" }, executionConfig: { autoApprove: true },
    })).toThrow();
    expect(() => validateAutomationInput({
      name: "Bad webhook", agentId: "agent-1", promptTemplate: "hello", trigger: { type: "manual" },
      actions: [{ id: "send", type: "webhook", url: "file:///etc/passwd" }],
    })).toThrow();
  });

  test("renders bounded safe templates and evaluates only the restricted condition grammar", () => {
    expect(renderTemplate("{{ trigger.payload.title }}: {{ output.text }}", context)).toBe("Build complete: A concise summary");
    expect(evaluateCondition('output.structured.important == true', context)).toBe(true);
    expect(evaluateCondition('output.text contains "concise"', context)).toBe(true);
    expect(evaluateCondition("output.missing exists", context)).toBe(false);
    expect(() => renderTemplate("{{ output.constructor.name }}", context)).toThrow();
    expect(() => evaluateCondition("output.text.includes('x')", context)).toThrow();
    expect(() => renderTemplate("x".repeat(65_000), context)).toThrow();
  });

  test("registers all trigger kinds without embedding delivery infrastructure", () => {
    expect(createCoreTriggerRegistry().types().sort()).toEqual(["event", "manual", "schedule", "webhook"]);
    expect(() => createCoreTriggerRegistry().validate({ type: "queue" })).toThrow();
  });

  test("executes the selected agent, stores its canonical run reference, and processes output actions", async () => {
    const definition: AutomationDefinition = {
      id: "automation-1", ownerId: "owner-1", name: "Analyze event", enabled: true, agentId: "agent-1",
      promptTemplate: "Analyze {{ trigger.payload.title }}", trigger: { type: "event", eventType: "build.completed" },
      actions: [{ id: "store-output", type: "store" }], createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    };
    let execution: AutomationExecution = {
      id: "execution-1", automationId: definition.id, ownerId: definition.ownerId, agentId: definition.agentId,
      occurrenceKey: "event:one", trigger: context.trigger, resolvedInput: "Analyze Build complete", status: "pending", createdAt: "2026-01-01T00:00:00.000Z",
    };
    const actionResults = new Map<string, { id: string; executionId: string; actionId: string; actionType: "store"; status: string; result?: unknown }>();
    const executorRequests: unknown[] = [];
    const ports = {
      repository: {
        async get(ownerId: string, automationId: string) { return ownerId === definition.ownerId && automationId === definition.id ? definition : undefined; },
      },
      executions: {
        async claimOccurrence() { return { newlyClaimed: true, occurrence: { id: "occurrence-1", automationId: definition.id, ownerId: definition.ownerId, occurrenceKey: execution.occurrenceKey, trigger: context.trigger, status: "claimed" as const, executionId: execution.id, createdAt: execution.createdAt }, execution }; },
        async finishOccurrence() { return undefined; },
        async getExecution() { return execution; },
        async listExecutions() { return [execution]; },
        async transitionExecution(input: { from: readonly string[]; to: AutomationExecution["status"]; now: string; runId?: string; output?: unknown; error?: unknown }) {
          if (!input.from.includes(execution.status)) return undefined;
          execution = { ...execution, status: input.to, ...(input.runId ? { runId: input.runId } : {}), ...(input.output !== undefined ? { output: input.output as any } : {}), ...(input.error ? { error: input.error as any } : {}) };
          return execution;
        },
        async claimAction(input: { action: { id: string; type: "store" } }) {
          const action = actionResults.get(input.action.id);
          if (action) return { claimed: false, action: action as any };
          const created = { id: `${execution.id}:${input.action.id}`, executionId: execution.id, actionId: input.action.id, actionType: "store" as const, status: "running" };
          actionResults.set(input.action.id, created);
          return { claimed: true, action: created as any };
        },
        async finishAction(input: { actionId: string; status: string; result?: unknown }) {
          const action = actionResults.get(input.actionId);
          if (!action) return undefined;
          const updated = { ...action, status: input.status, result: input.result };
          actionResults.set(input.actionId, updated);
          return updated as any;
        },
        async listActions() { return [...actionResults.values()] as any; },
      },
      agentAccess: { async assertCanUse(ownerId: string, agentId: string) { if (ownerId !== definition.ownerId || agentId !== definition.agentId) throw new Error("denied"); } },
      agentExecutor: {
        async execute(input: unknown) { executorRequests.push(input); return { runId: "canonical-run-1", status: "completed" as const, output: { text: "Important result", structured: { important: true } } }; },
        async cancel() {},
      },
      actions: { store: { async execute({ resolvedInput }: { resolvedInput: unknown }) { return resolvedInput; } } },
      ids: { next: () => "generated-id" },
      clock: { now: () => new Date("2026-01-01T00:00:01.000Z") },
    };

    const service = new AutomationExecutionService(ports as any);
    const response = await service.deliver({ ownerId: definition.ownerId, automationId: definition.id, occurrenceKey: "event:one", trigger: context.trigger });
    expect(response.accepted).toBe(true);
    expect(response.execution?.status).toBe("completed");
    expect(response.execution?.runId).toBe("canonical-run-1");
    expect((executorRequests[0] as { agentId: string }).agentId).toBe("agent-1");
    expect(actionResults.get("store-output")?.status).toBe("completed");
  });
});
