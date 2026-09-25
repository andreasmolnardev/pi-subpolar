import type { ToolGateway } from "./tool-gateway.ts";
import type { TaskRecord, TaskRepository } from "../task-control-plane.ts";

export const CAPABILITIES = ["subagent/run", "read", "write", "bash"] as const;
export type Capability = (typeof CAPABILITIES)[number];
const capabilitySet = new Set<string>(CAPABILITIES);
export type SubagentRunInput = {
  ownerId: string;
  sessionId: string;
  parentAgent: string;
  targetAgent: string;
  prompt: string;
  capabilities: readonly Capability[];
  projectId?: string;
  coding?: boolean;
  approvalId?: string;
  cwd?: string;
  permissionOverride?: "ask" | "none" | "allow_all";
};
export type SubagentExecutor = (input: {
  task: TaskRecord;
  cwd?: string;
  signal: AbortSignal;
  capabilities: readonly Capability[];
  gatewayContext?: { ownerId: string; sessionId: string; agentName: string; projectId?: string; cwd?: string; permissionOverride?: "ask" | "none" | "allow_all" };
}) => Promise<unknown>;
export type TargetAgentAuthorizer = (
  ownerId: string,
  parentAgent: string,
  targetAgent: string,
  projectId?: string,
) => Promise<boolean>;
export type ApprovalAuthorizer = (ownerId: string, approvalId: string, sessionId: string) => Promise<boolean>;
export class SubagentControlError extends Error {
  constructor(
    readonly code:
      | "TARGET_AGENT_DENIED"
      | "CAPABILITY_ESCALATION"
      | "CONCURRENCY_LIMIT"
      | "CANCELLED",
    message: string,
  ) {
    super(message);
    this.name = "SubagentControlError";
  }
}

export function constrainCapabilities(
  parent: readonly Capability[],
  requested: readonly Capability[],
): Capability[] {
  if (parent.some((cap) => !capabilitySet.has(cap)) || requested.some((cap) => !capabilitySet.has(cap)))
    throw new SubagentControlError("CAPABILITY_ESCALATION", "Unknown capability");
  const ceiling = new Set(parent);
  if (requested.some((cap) => !ceiling.has(cap)))
    throw new SubagentControlError(
      "CAPABILITY_ESCALATION",
      "Child capabilities exceed the parent capability ceiling",
    );
  return [...new Set(requested)];
}

export class SubagentController {
  private readonly active = new Map<string, { taskId?: string; abort: AbortController }>();
  // This is only an in-process fast path. The task input is durable and is
  // used for approval resume after restart; missing persisted context is an
  // explicit interruption, never an allow-all fallback.
  private readonly pending = new Map<string, { input: SubagentRunInput; capabilities: Capability[] }>();
  constructor(
    private readonly tasks: TaskRepository,
    _gateway: ToolGateway,
    private readonly execute: SubagentExecutor,
    private readonly limit = 2,
    private readonly authorizeTarget: TargetAgentAuthorizer = async () => true,
    private readonly approvalApproved: ApprovalAuthorizer = async () => false,
  ) {}

  async run(
    input: SubagentRunInput,
    parentCapabilities: readonly Capability[],
  ): Promise<TaskRecord> {
    if (
      !(await this.authorizeTarget(
        input.ownerId,
        input.parentAgent,
        input.targetAgent,
        input.projectId,
      ))
    )
      throw new SubagentControlError(
        "TARGET_AGENT_DENIED",
        "Caller is not authorized to run the target agent",
      );
    const capabilities = constrainCapabilities(
      parentCapabilities,
      input.capabilities,
    );
    // Approval continuation can arrive in a fresh process. Reuse the durable
    // waiting task instead of relying on the in-memory pending map.
    if (input.approvalId) {
      const existing = await this.tasks.findWaitingForApproval(input.ownerId, input.approvalId);
      if (existing) return this.resume(input.ownerId, existing.id);
    }
    // Reservation is synchronous and happens before the first awaited task write.
    // This closes the check-then-await race between concurrent callers.
    if (this.active.size >= this.limit) throw new SubagentControlError("CONCURRENCY_LIMIT", "Subagent concurrency limit reached");
    const reservation = crypto.randomUUID();
    const abort = new AbortController();
    this.active.set(reservation, { abort });
    let task: TaskRecord;
    try {
      task = await this.tasks.create({
        owner_id: input.ownerId,
        project_id: input.projectId,
        session_id: input.sessionId,
        agent_id: input.parentAgent,
        subagent_id: input.targetAgent,
        state: input.approvalId ? "waiting_for_approval" : "queued",
        kind: "subagent_run",
        title: input.prompt.slice(0, 120),
        input: { prompt: input.prompt, capabilities, coding: input.coding !== false, cwd: input.cwd, approvalId: input.approvalId, permissionOverride: input.permissionOverride },
      });
    } catch (error) {
      this.active.delete(reservation);
      throw error;
    }
    this.active.delete(reservation);
    if (input.approvalId) {
      this.pending.set(task.id, { input, capabilities });
      await this.tasks.addActivity(input.ownerId, task.id, { kind: "approval_requested", summary: "Subagent is waiting for approval", details: { approvalId: input.approvalId } });
      return task;
    }
    this.active.set(task.id, { taskId: task.id, abort });
    await this.tasks.addActivity(input.ownerId, task.id, { kind: "queued", summary: "Subagent task queued", details: { targetAgent: input.targetAgent, capabilities } });
    void this.executeTask(task, input, capabilities, abort).finally(() =>
      this.active.delete(task.id),
    );
    return task;
  }
  async cancel(ownerId: string, taskId: string): Promise<TaskRecord> {
    const current = this.active.get(taskId);
    if (current) current.abort.abort();
    const task = await this.tasks.getOwned(ownerId, taskId);
    if (!task) throw new SubagentControlError("TARGET_AGENT_DENIED", "Task is not owned by the caller");
    if (task.state === "cancelled" || task.state === "completed" || task.state === "failed") return task;
    return this.tasks.transition(ownerId, taskId, "cancelled", { error_code: "CANCELLED" });
  }
  async resume(ownerId: string, taskId: string): Promise<TaskRecord> {
    const task = await this.tasks.getOwned(ownerId, taskId);
    if (!task || task.state !== "waiting_for_approval") throw new SubagentControlError("TARGET_AGENT_DENIED", "Task is not awaiting approval");
    const stored = objectValue(task.input);
    const persistedCapabilities = Array.isArray(stored.capabilities) ? stored.capabilities : [];
    if (persistedCapabilities.some((cap) => typeof cap !== "string" || !capabilitySet.has(cap)))
      throw new SubagentControlError("CAPABILITY_ESCALATION", "Persisted task contains an unknown capability");
    const pending = this.pending.get(taskId) ?? {
      input: {
        ownerId,
        sessionId: task.session_id ?? "",
        parentAgent: task.agent_id ?? "",
        targetAgent: task.subagent_id ?? "",
        prompt: typeof stored.prompt === "string" ? stored.prompt : task.title,
        capabilities: persistedCapabilities as Capability[],
        projectId: task.project_id,
        coding: stored.coding !== false,
        approvalId: typeof stored.approvalId === "string" ? stored.approvalId : undefined,
        cwd: typeof stored.cwd === "string" ? stored.cwd : undefined,
        permissionOverride: stored.permissionOverride === "none" || stored.permissionOverride === "allow_all" ? stored.permissionOverride : "ask",
      },
      capabilities: persistedCapabilities as Capability[],
    };
    if (!pending.input.approvalId) throw new SubagentControlError("TARGET_AGENT_DENIED", "Approval context is unavailable; create a new approval");
    const approvalId = typeof objectValue(task.input).approvalId === "string" ? String(objectValue(task.input).approvalId) : "";
    if (!approvalId || !(await this.approvalApproved(ownerId, approvalId, task.session_id ?? ""))) throw new SubagentControlError("TARGET_AGENT_DENIED", "Approval has not been granted");
    this.pending.delete(taskId);
    const abort = new AbortController();
    if (this.active.size >= this.limit) throw new SubagentControlError("CONCURRENCY_LIMIT", "Subagent concurrency limit reached");
    this.active.set(taskId, { taskId, abort });
    void this.executeTask(task, pending.input, pending.capabilities, abort).finally(() => this.active.delete(taskId));
    return task;
  }
  private async executeTask(
    task: TaskRecord,
    input: SubagentRunInput,
    capabilities: readonly Capability[],
    abort: AbortController,
  ): Promise<void> {
    try {
      await this.tasks.transition(input.ownerId, task.id, "running");
      await this.tasks.addActivity(input.ownerId, task.id, { kind: "started", summary: "Subagent execution started", details: { agent: input.targetAgent } });
      const result = await this.execute({
        task,
        signal: abort.signal,
        capabilities,
        cwd: input.cwd,
        gatewayContext: { ownerId: input.ownerId, sessionId: input.sessionId, agentName: input.parentAgent, projectId: input.projectId, cwd: input.cwd, permissionOverride: input.permissionOverride },
      });
      await this.tasks.transition(input.ownerId, task.id, "completed", {
        result: { summary: "Subagent completed", value: result },
      });
      await this.tasks.addActivity(input.ownerId, task.id, { kind: "completed", summary: "Subagent execution completed" });
    } catch (error) {
      if (abort.signal.aborted) {
        await this.tasks.transition(input.ownerId, task.id, "cancelled", { error_code: "CANCELLED" }).catch(() => undefined);
        await this.tasks.addActivity(input.ownerId, task.id, { kind: "cancelled", summary: "Subagent execution cancelled" }).catch(() => undefined);
        return;
      }
      const message =
        error instanceof Error ? error.message : "Subagent failed";
      await this.tasks
        .transition(input.ownerId, task.id, "failed", {
          error_code: "SUBAGENT_FAILED",
          error_message: message,
        })
        .catch(() => undefined);
      await this.tasks.addActivity(input.ownerId, task.id, { kind: "failed", summary: "Subagent execution failed", details: { error: message } }).catch(() => undefined);
    }
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
