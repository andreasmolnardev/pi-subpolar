import type {
  ActionDefinition,
  ActionExecution,
  AutomationContext,
  AutomationDefinition,
  AutomationExecution,
  JsonValue,
  TriggerInput,
} from "./types.ts";
import type { AutomationExecutionPorts, TriggerOccurrenceInput, TriggerDeliveryResult } from "./ports.ts";
import { evaluateCondition } from "./conditions/evaluator.ts";
import { renderTemplate, asJsonValue } from "./templates/renderer.ts";
import { validateTriggerDefinition } from "./validation.ts";

const MAX_RECURSION_DEPTH = 3;
const TERMINAL_RUN_STATES = new Set(["failed", "interrupted", "unknown"]);
const activeExecutionSignals = new Map<string, AbortController>();

function executionKey(ownerId: string, executionId: string): string { return `${ownerId}\u0000${executionId}`; }

function errorResult(error: unknown): { code: string; message: string } {
  const candidate = error as { code?: unknown; message?: unknown } | null;
  const code = candidate && typeof candidate.code === "string" && /^[A-Z0-9_.-]{1,64}$/.test(candidate.code)
    ? candidate.code
    : "AUTOMATION_EXECUTION_FAILED";
  const message = candidate && typeof candidate.message === "string"
    ? candidate.message.replace(/Bearer\s+\S+/gi, "Bearer [redacted]").replace(/\b(?:sk|key|token|secret)[-_][A-Za-z0-9_-]{16,}\b/gi, "[redacted]").slice(0, 500)
    : "Automation execution failed";
  return { code, message };
}

function runContext(execution: AutomationExecution, output?: { text?: string; structured?: JsonValue }, runStatus?: string): AutomationContext {
  return {
    trigger: execution.trigger,
    execution: {
      id: execution.id,
      automationId: execution.automationId,
      ownerId: execution.ownerId,
      agentId: execution.agentId,
      projectId: execution.projectId,
      occurrenceKey: execution.occurrenceKey,
    },
    agent: { id: execution.agentId },
    ...(output ? { output } : {}),
      run: { id: execution.runId, status: runStatus },
  };
}

function statusFromRun(status: string): AutomationExecution["status"] {
  if (status === "approval_required") return "waiting_approval";
  if (status === "completed") return "processing_output";
  if (status === "failed" || status === "interrupted" || status === "unknown") return status;
  return "unknown";
}

export class AutomationExecutionService {
  constructor(private readonly ports: AutomationExecutionPorts) {}

  async deliver(input: TriggerOccurrenceInput): Promise<TriggerDeliveryResult> {
    const automation = await this.ports.repository.get(input.ownerId, input.automationId);
    if (!automation || !automation.enabled) return { accepted: false, duplicate: false };
    validateTriggerDefinition(automation.trigger);
    if (input.trigger.kind !== automation.trigger.type && input.trigger.kind !== "manual") return { accepted: false, duplicate: false };
    if (typeof input.occurrenceKey !== "string" || !input.occurrenceKey.trim() || input.occurrenceKey.length > 512) throw new TypeError("Invalid automation trigger occurrence key");
    if (!Number.isFinite(Date.parse(input.trigger.occurredAt))) throw new TypeError("Invalid automation trigger occurrence time");
    const depth = input.trigger.causal?.recursionDepth ?? 0;
    if (!Number.isInteger(depth) || depth < 0 || depth >= MAX_RECURSION_DEPTH) return { accepted: false, duplicate: false };
    const conditionContext = {
      trigger: input.trigger,
      execution: { id: "pending", automationId: automation.id, ownerId: input.ownerId, agentId: automation.agentId, projectId: automation.projectId, occurrenceKey: input.occurrenceKey },
      agent: { id: automation.agentId },
    } satisfies AutomationContext;
    if (input.trigger.kind === "event" && automation.trigger.type === "event" && !evaluateCondition(automation.trigger.where, conditionContext)) return { accepted: false, duplicate: false };
    await this.ports.agentAccess.assertCanUse(input.ownerId, automation.agentId);
    const occurrence: TriggerInput = {
      kind: input.trigger.kind,
      payload: asJsonValue(input.trigger.payload),
      occurredAt: input.trigger.occurredAt,
      causal: {
        ...(input.trigger.causal?.automationExecutionId ? { automationExecutionId: input.trigger.causal.automationExecutionId.slice(0, 160) } : {}),
        ...(input.trigger.causal?.parentAutomationExecutionId ? { parentAutomationExecutionId: input.trigger.causal.parentAutomationExecutionId.slice(0, 160) } : {}),
        recursionDepth: depth,
      },
    };
    const preliminaryContext: AutomationContext = { ...conditionContext, trigger: occurrence };
    const prompt = renderTemplate(automation.promptTemplate, preliminaryContext);
    const claimed = await this.ports.executions.claimOccurrence({
      ownerId: input.ownerId,
      automation,
      occurrenceKey: input.occurrenceKey,
      trigger: occurrence,
      resolvedInput: prompt,
      now: this.ports.clock.now().toISOString(),
    });
    if (!claimed.newlyClaimed) {
      // A process may have crashed after claiming the occurrence but before
      // transitioning its execution from pending. The pending -> running
      // transition is a compare-and-set, so concurrent redelivery resumes it
      // at most once when the persistence adapter provides atomic claims.
      if (claimed.execution.status === "pending") {
        if (input.background) {
          this.launchClaimed(automation, claimed.execution, input.signal);
          return { accepted: true, duplicate: true, execution: claimed.execution };
        }
        return { accepted: true, duplicate: true, execution: await this.executeClaimed(automation, claimed.execution, input.signal) };
      }
      return { accepted: true, duplicate: true, execution: claimed.execution };
    }
    if (input.background) {
      this.launchClaimed(automation, claimed.execution, input.signal);
      return { accepted: true, duplicate: false, execution: claimed.execution };
    }
    const execution = await this.executeClaimed(automation, claimed.execution, input.signal);
    return { accepted: true, duplicate: false, execution };
  }

  async runNow(ownerId: string, automationId: string, options: { occurrenceKey?: string; payload?: JsonValue; signal?: AbortSignal } = {}): Promise<AutomationExecution> {
    const automation = await this.ports.repository.get(ownerId, automationId);
    if (!automation) throw new Error("Automation not found");
    const now = this.ports.clock.now().toISOString();
    const trigger: TriggerInput = {
      kind: "manual",
      payload: options.payload ?? {},
      occurredAt: now,
    };
    const result = await this.deliver({
      ownerId,
      automationId,
      occurrenceKey: options.occurrenceKey ?? this.ports.ids.next("manual-occurrence"),
      trigger,
      signal: options.signal,
      background: true,
    });
    if (!result.accepted || !result.execution) throw new Error("Automation trigger was rejected");
    return (await this.ports.executions.getExecution(ownerId, result.execution.id)) ?? result.execution;
  }

  async get(ownerId: string, executionId: string): Promise<AutomationExecution | undefined> {
    return this.ports.executions.getExecution(ownerId, executionId);
  }

  list(ownerId: string, automationId: string, limit?: number): Promise<AutomationExecution[]> {
    return this.ports.executions.listExecutions(ownerId, automationId, limit);
  }

  private launchClaimed(automation: AutomationDefinition, execution: AutomationExecution, signal?: AbortSignal): void {
    void this.executeClaimed(automation, execution, signal).catch(async (error) => {
      const failure = errorResult(error);
      const failed = await this.ports.executions.transitionExecution({
        ownerId: execution.ownerId,
        executionId: execution.id,
        from: ["pending", "running", "processing_output"],
        to: "unknown",
        now: this.ports.clock.now().toISOString(),
        error: failure,
      }).catch(() => undefined);
      if (failed) await this.ports.executions.finishOccurrence({
        ownerId: execution.ownerId, automationId: execution.automationId, occurrenceKey: execution.occurrenceKey,
        executionId: execution.id, status: "unknown", now: this.ports.clock.now().toISOString(),
      }).catch(() => undefined);
    });
  }

  async cancel(ownerId: string, executionId: string): Promise<AutomationExecution | undefined> {
    const execution = await this.ports.executions.getExecution(ownerId, executionId);
    if (!execution || ["completed", "failed", "cancelled", "interrupted", "unknown"].includes(execution.status)) return execution;
    activeExecutionSignals.get(executionKey(ownerId, executionId))?.abort(new DOMException("Automation execution cancelled", "AbortError"));
    if (execution.runId) await this.ports.agentExecutor.cancel(ownerId, execution.runId);
    const cancelled = await this.ports.executions.transitionExecution({
      ownerId,
      executionId,
      from: ["pending", "running", "waiting_approval", "processing_output"],
      to: "cancelled",
      now: this.ports.clock.now().toISOString(),
    });
    if (cancelled) await this.ports.executions.finishOccurrence({
      ownerId, automationId: cancelled.automationId, occurrenceKey: cancelled.occurrenceKey,
      executionId: cancelled.id, status: "cancelled", now: this.ports.clock.now().toISOString(),
    });
    return cancelled;
  }

  private async executeClaimed(automation: AutomationDefinition, initial: AutomationExecution, signal?: AbortSignal): Promise<AutomationExecution> {
    const ownerId = initial.ownerId;
    const controller = new AbortController();
    const abortFromCaller = () => controller.abort(signal?.reason);
    if (signal?.aborted) abortFromCaller();
    else signal?.addEventListener("abort", abortFromCaller, { once: true });
    const runSignal = controller.signal;
    const timeoutMs = automation.executionConfig?.timeoutMs;
    const timeout = timeoutMs === undefined ? undefined : setTimeout(() => controller.abort(new DOMException("Automation agent execution timed out", "TimeoutError")), timeoutMs);
    const key = executionKey(ownerId, initial.id);
    activeExecutionSignals.set(key, controller);
    let execution: AutomationExecution | undefined;
    try {
      execution = await this.ports.executions.transitionExecution({
        ownerId,
        executionId: initial.id,
        from: ["pending"],
        to: "running",
        now: this.ports.clock.now().toISOString(),
        ...(this.ports.agentExecutor.canonicalRunId ? { runId: this.ports.agentExecutor.canonicalRunId(initial.id) } : {}),
      });
    } catch (error) {
      if (timeout) clearTimeout(timeout);
      signal?.removeEventListener("abort", abortFromCaller);
      if (activeExecutionSignals.get(key) === controller) activeExecutionSignals.delete(key);
      throw error;
    }
    if (!execution) {
      if (timeout) clearTimeout(timeout);
      signal?.removeEventListener("abort", abortFromCaller);
      if (activeExecutionSignals.get(key) === controller) activeExecutionSignals.delete(key);
      return (await this.ports.executions.getExecution(ownerId, initial.id)) ?? initial;
    }
    try {
      if (runSignal.aborted) throw runSignal.reason ?? new DOMException("Automation execution cancelled", "AbortError");
      const result = await this.ports.agentExecutor.execute({
        ownerId,
        agentId: automation.agentId,
        projectId: automation.projectId,
        executionConfig: automation.executionConfig,
        prompt: execution.resolvedInput,
        trigger: execution.trigger,
        automationExecutionId: execution.id,
        idempotencyKey: `automation:${automation.id}:${execution.occurrenceKey}`,
        signal: runSignal,
      });
      const nextStatus = statusFromRun(result.status);
      const output = result.output ? asJsonValue(result.output) : undefined;
      execution = await this.ports.executions.transitionExecution({
        ownerId,
        executionId: execution.id,
        from: ["running"],
        to: nextStatus,
        now: this.ports.clock.now().toISOString(),
        runId: result.runId,
        output,
        error: result.error,
      }) ?? execution;
      if (TERMINAL_RUN_STATES.has(result.status) || result.status === "approval_required") {
        if (result.status === "failed" || result.status === "interrupted" || result.status === "unknown") {
          await this.ports.executions.finishOccurrence({
            ownerId, automationId: automation.id, occurrenceKey: execution.occurrenceKey, executionId: execution.id,
            status: result.status === "unknown" ? "unknown" : "failed", now: this.ports.clock.now().toISOString(),
          });
        }
        return execution;
      }
      execution = await this.processActions(automation, execution, result.output, result.status, runSignal);
      if (["completed", "failed", "cancelled", "unknown"].includes(execution.status)) {
        await this.ports.executions.finishOccurrence({
          ownerId,
          automationId: automation.id,
          occurrenceKey: execution.occurrenceKey,
          executionId: execution.id,
          status: execution.status as "completed" | "failed" | "cancelled" | "unknown",
          now: this.ports.clock.now().toISOString(),
        });
      }
      return execution;
    } catch (error) {
      if (runSignal.aborted) {
        const current = await this.ports.executions.getExecution(ownerId, execution.id) ?? execution;
        if (current.status === "cancelled") return current;
        const timedOut = runSignal.reason instanceof DOMException && runSignal.reason.name === "TimeoutError";
        const terminalStatus = timedOut ? "failed" : "cancelled";
        const cancelled = await this.ports.executions.transitionExecution({
          ownerId, executionId: execution.id, from: ["running", "processing_output"], to: terminalStatus,
          now: this.ports.clock.now().toISOString(), error: timedOut
            ? { code: "AUTOMATION_TIMEOUT", message: "Automation agent execution timed out" }
            : { code: "AUTOMATION_CANCELLED", message: "Automation execution was cancelled" },
        }) ?? current;
        await this.ports.executions.finishOccurrence({
          ownerId, automationId: automation.id, occurrenceKey: execution.occurrenceKey, executionId: execution.id,
          status: terminalStatus, now: this.ports.clock.now().toISOString(),
        });
        return cancelled;
      }
      const failure = errorResult(error);
      const failed = await this.ports.executions.transitionExecution({
        ownerId,
        executionId: execution.id,
        from: ["running", "processing_output"],
        to: "unknown",
        now: this.ports.clock.now().toISOString(),
        error: failure,
      }) ?? execution;
      await this.ports.executions.finishOccurrence({
        ownerId, automationId: automation.id, occurrenceKey: execution.occurrenceKey, executionId: execution.id,
        status: "unknown", now: this.ports.clock.now().toISOString(),
      });
      return failed;
    } finally {
      if (timeout) clearTimeout(timeout);
      signal?.removeEventListener("abort", abortFromCaller);
      if (activeExecutionSignals.get(key) === controller) activeExecutionSignals.delete(key);
    }
  }

  private async processActions(
    automation: AutomationDefinition,
    initial: AutomationExecution,
    output: { text?: string; structured?: JsonValue } | undefined,
    runStatus: string,
    signal?: AbortSignal,
  ): Promise<AutomationExecution> {
    const ownerId = initial.ownerId;
    let execution = initial;
    const context = runContext(execution, output, runStatus);
    for (const [ordinal, action] of automation.actions.entries()) {
      if (signal?.aborted) throw signal.reason ?? new DOMException("Automation execution cancelled", "AbortError");
      if (!evaluateCondition(action.when, context)) {
        const skippedClaim = await this.ports.executions.claimAction({ ownerId, executionId: execution.id, action, ordinal, now: this.ports.clock.now().toISOString() });
        if (!skippedClaim.claimed && skippedClaim.action.status === "completed") continue;
        if (!skippedClaim.claimed && skippedClaim.action.status !== "skipped") {
          return await this.ports.executions.transitionExecution({
            ownerId, executionId: execution.id, from: ["processing_output"], to: "unknown", now: this.ports.clock.now().toISOString(),
            error: { code: "ACTION_OUTCOME_UNKNOWN", message: `Action ${action.id} has an uncertain prior outcome` },
          }) ?? execution;
        }
        if (skippedClaim.claimed) await this.ports.executions.finishAction({
          ownerId, executionId: execution.id, actionId: action.id, status: "skipped", now: this.ports.clock.now().toISOString(),
        });
        continue;
      }
      const claim = await this.ports.executions.claimAction({ ownerId, executionId: execution.id, action, ordinal, now: this.ports.clock.now().toISOString() });
      if (!claim.claimed) {
        if (claim.action.status === "completed" || claim.action.status === "skipped") continue;
        const uncertain = await this.ports.executions.transitionExecution({
          ownerId, executionId: execution.id, from: ["processing_output"], to: "unknown", now: this.ports.clock.now().toISOString(),
          error: { code: "ACTION_OUTCOME_UNKNOWN", message: `Action ${action.id} has an uncertain prior outcome` },
        });
        return uncertain ?? execution;
      }
      const handler = this.ports.actions[action.type];
      if (!handler) {
        const failed = await this.ports.executions.finishAction({
          ownerId, executionId: execution.id, actionId: action.id, status: "failed", now: this.ports.clock.now().toISOString(),
          error: { code: "ACTION_NOT_CONFIGURED", message: `No handler is registered for action type ${action.type}` },
        });
        return this.failAction(execution, failed, action);
      }
      try {
        const resolvedInput = resolveActionInput(action, context);
        const value = await handler.execute({ ownerId, execution, action, resolvedInput, context, signal });
        let completed: ActionExecution | undefined;
        try {
          completed = await this.ports.executions.finishAction({
            ownerId, executionId: execution.id, actionId: action.id, status: "completed", now: this.ports.clock.now().toISOString(),
            input: resolvedInput,
            result: asJsonValue(value),
          });
        } catch {
          // The side effect already ran. Never replay it if its result could not be recorded.
          completed = undefined;
        }
        if (!completed) {
          const uncertain = await this.ports.executions.finishAction({
            ownerId, executionId: execution.id, actionId: action.id, status: "unknown", now: this.ports.clock.now().toISOString(),
            input: resolvedInput, error: { code: "ACTION_RESULT_PERSISTENCE_FAILED", message: "Action ran but its result could not be recorded" },
          }).catch(() => undefined);
          return await this.ports.executions.transitionExecution({
            ownerId, executionId: execution.id, from: ["processing_output"], to: "unknown", now: this.ports.clock.now().toISOString(),
            error: uncertain?.error ?? { code: "ACTION_RESULT_PERSISTENCE_FAILED", message: "Action ran but its result could not be recorded" },
          }) ?? execution;
        }
      } catch (error) {
        const failure = errorResult(error);
        const record = await this.ports.executions.finishAction({
          ownerId, executionId: execution.id, actionId: action.id,
          status: (error as { outcomeUnknown?: boolean })?.outcomeUnknown ? "unknown" : "failed",
          now: this.ports.clock.now().toISOString(), error: failure,
        });
        if (record?.status === "unknown") {
          return await this.ports.executions.transitionExecution({
            ownerId, executionId: execution.id, from: ["processing_output"], to: "unknown", now: this.ports.clock.now().toISOString(), error: failure,
          }) ?? execution;
        }
        return this.failAction(execution, record, action);
      }
    }
    return await this.ports.executions.transitionExecution({
      ownerId,
      executionId: execution.id,
      from: ["processing_output"],
      to: "completed",
      now: this.ports.clock.now().toISOString(),
    }) ?? execution;
  }

  private async failAction(execution: AutomationExecution, actionRecord: ActionExecution | undefined, action: ActionDefinition): Promise<AutomationExecution> {
    const error = actionRecord?.error ?? { code: "ACTION_FAILED", message: `Action ${action.id} failed` };
    return await this.ports.executions.transitionExecution({
      ownerId: execution.ownerId, executionId: execution.id, from: ["processing_output"], to: "failed",
      now: this.ports.clock.now().toISOString(), error,
    }) ?? execution;
  }
}

function resolveActionInput(action: ActionDefinition, context: AutomationContext): JsonValue {
  switch (action.type) {
    case "store":
      return asJsonValue(context.output ?? {});
    case "notification":
      return {
        title: renderTemplate(action.titleTemplate, context),
        body: renderTemplate(action.bodyTemplate, context),
      };
    case "webhook":
      return asJsonValue({
        url: action.url,
        method: action.method ?? "POST",
        ...(action.credentialRef ? { credentialRef: action.credentialRef } : {}),
        body: action.bodyTemplate ? renderTemplate(action.bodyTemplate, context) : JSON.stringify(context.output ?? {}),
      });
    case "tool": {
      const source = renderTemplate(action.inputTemplate, context);
      let input: unknown;
      try { input = JSON.parse(source); } catch { throw new TypeError(`Tool action ${action.id} input must render to JSON`); }
      return asJsonValue({ toolId: action.toolId, input });
    }
  }
}
