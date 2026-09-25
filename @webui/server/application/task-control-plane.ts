import type PocketBase from "pocketbase";
import { escapeFilter } from "../persistence/pocketbase.ts";
import { InboxRepository } from "../persistence/inbox.ts";

export const TASK_STATES = [
  "draft",
  "queued",
  "running",
  "waiting_for_input",
  "waiting_for_approval",
  "review_required",
  "failed",
  "completed",
  "cancelled",
] as const;
export type TaskState = (typeof TASK_STATES)[number];
export type TaskKind = "task" | "subagent_run";
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const INITIAL_TASK_STATES: readonly TaskState[] = ["draft", "queued"];

export function assertSafeIdentifier(value: string, name: string): string {
  if (!SAFE_IDENTIFIER.test(value)) throw new Error(`Invalid ${name}`);
  return value;
}
export type TaskRecord = {
  id: string;
  owner_id: string;
  project_id?: string;
  session_id?: string;
  parent_run_id?: string;
  agent_id?: string;
  subagent_id?: string;
  worktree_id?: string;
  base_ref?: string;
  state: TaskState;
  kind: TaskKind;
  title: string;
  input?: unknown;
  result?: unknown;
  review_state?: "pending" | "approved" | "rejected";
  review_note?: string;
  error_code?: string;
  error_message?: string;
  created_at: number;
  updated_at: number;
  started_at?: number;
  finished_at?: number;
};

export type TaskActivity = {
  id?: string;
  task_id: string;
  owner_id: string;
  kind: string;
  summary: string;
  details?: unknown;
  created_at: number;
};
export const TASK_TRANSITIONS: Readonly<
  Record<TaskState, readonly TaskState[]>
> = {
  draft: ["queued", "cancelled"],
  queued: ["running", "cancelled"],
  running: [
    "waiting_for_input",
    "waiting_for_approval",
    "review_required",
    "failed",
    "completed",
    "cancelled",
  ],
  waiting_for_input: ["running", "cancelled", "failed"],
  waiting_for_approval: ["running", "cancelled", "failed"],
  review_required: ["running", "completed", "cancelled"],
  failed: ["queued", "cancelled"],
  completed: [],
  cancelled: [],
};

export class TaskControlError extends Error {
  constructor(
    readonly code:
      | "TASK_NOT_FOUND"
      | "TASK_NOT_OWNED"
      | "INVALID_TRANSITION"
      | "INVALID_REVIEW"
       | "ATOMIC_UPDATE_UNAVAILABLE",
    message: string,
  ) {
    super(message);
    this.name = "TaskControlError";
  }
}

export type TaskPersistenceCapabilities = {
  conditionalTransitions: boolean;
  serializedTransitions: boolean;
  /** The fallback is process-local and is safe for the single-bridge runtime only. */
  serializationScope: "process" | "durable";
};

type ConditionalCollection = {
  updateConditional?: (id: string, expected: Record<string, unknown>, update: Record<string, unknown>) => Promise<Record<string, unknown>>;
  update: (id: string, data: Record<string, unknown>) => Promise<Record<string, unknown>>;
};
const transitionLocks = new WeakMap<object, Map<string, Promise<void>>>();

async function withTransitionLock<T>(client: object, key: string, work: () => Promise<T>): Promise<T> {
  let locks = transitionLocks.get(client);
  if (!locks) { locks = new Map(); transitionLocks.set(client, locks); }
  const previous = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  locks.set(key, current);
  await previous;
  try { return await work(); } finally { release(); if (locks.get(key) === current) locks.delete(key); }
}

export function assertTaskTransition(from: TaskState, to: TaskState): void {
  if (!TASK_TRANSITIONS[from]?.includes(to))
    throw new TaskControlError(
      "INVALID_TRANSITION",
      `Task cannot transition from ${from} to ${to}`,
    );
}

function task(value: Record<string, unknown>): TaskRecord {
  const state = value.state as TaskState;
  if (!TASK_STATES.includes(state))
    throw new Error("Invalid persisted task state");
  assertSafeIdentifier(String(value.id), "task id");
  assertSafeIdentifier(String(value.owner_id), "owner id");
  return {
    ...value,
    id: String(value.id),
    owner_id: String(value.owner_id),
    state,
    kind: value.kind === "subagent_run" ? "subagent_run" : "task",
    title: String(value.title ?? ""),
  } as TaskRecord;
}

export class TaskRepository {
  readonly capabilities: TaskPersistenceCapabilities;
  private readonly inbox: InboxRepository;
  constructor(private readonly client: PocketBase, inbox?: InboxRepository) {
    this.inbox = inbox ?? new InboxRepository(client);
    const collection = this.client.collection("tasks") as unknown as ConditionalCollection;
    this.capabilities = {
      conditionalTransitions: typeof collection.updateConditional === "function",
      serializedTransitions: true,
      serializationScope: "process",
    };
  }

  async create(
    input: Omit<TaskRecord, "id" | "created_at" | "updated_at">,
  ): Promise<TaskRecord> {
    assertSafeIdentifier(input.owner_id, "owner id");
    if (!INITIAL_TASK_STATES.includes(input.state))
      throw new TaskControlError("INVALID_TRANSITION", "Invalid initial task state");
    if (input.project_id) assertSafeIdentifier(input.project_id, "project id");
    if (input.session_id) assertSafeIdentifier(input.session_id, "session id");
    if (input.parent_run_id) assertSafeIdentifier(input.parent_run_id, "parent run id");
    if (input.worktree_id) assertSafeIdentifier(input.worktree_id, "worktree id");
    const now = Date.now();
    const record = await this.client
      .collection("tasks")
      .create({ ...input, created_at: now, updated_at: now });
    assertSafeIdentifier(String(record.id), "task id");
    await this.audit(input.owner_id, "task_created", record.id, {
      state: input.state,
      kind: input.kind,
      capabilities:
        input.input &&
        typeof input.input === "object" &&
        !Array.isArray(input.input)
          ? (input.input as Record<string, unknown>).capabilities
          : undefined,
    });
    return task(record);
  }

  async getOwned(ownerId: string, id: string): Promise<TaskRecord | null> {
    assertSafeIdentifier(ownerId, "owner id");
    assertSafeIdentifier(id, "task id");
    const record = await this.client
      .collection("tasks")
      .getOne(id)
      .catch(() => null);
    if (!record || record.owner_id !== ownerId) return null;
    return task(record);
  }

  async listOwned(
    ownerId: string,
    states?: readonly TaskState[],
  ): Promise<TaskRecord[]> {
    assertSafeIdentifier(ownerId, "owner id");
    const filter = `owner_id = "${escapeFilter(ownerId)}"${states?.length ? ` && (${states.map((state) => `state = "${escapeFilter(state)}"`).join(" || ")})` : ""}`;
    return (
      await this.client
        .collection("tasks")
        .getFullList({ filter, sort: "-created_at" })
    ).map((value) => task(value));
  }

  async findWaitingForApproval(ownerId: string, approvalId: string): Promise<TaskRecord | null> {
    const tasks = await this.listOwned(ownerId, ["waiting_for_approval"]);
    return tasks.find((candidate) => objectValue(candidate.input).approvalId === approvalId) ?? null;
  }

  async transition(
    ownerId: string,
    id: string,
    state: TaskState,
    extra: Record<string, unknown> = {},
  ): Promise<TaskRecord> {
    assertSafeIdentifier(ownerId, "owner id");
    assertSafeIdentifier(id, "task id");
    if (!TASK_STATES.includes(state))
      throw new TaskControlError("INVALID_TRANSITION", "Invalid task state");
    return withTransitionLock(this.client as unknown as object, `${ownerId}:${id}`, async () => {
      const current = await this.getOwned(ownerId, id);
      if (!current) throw new TaskControlError("TASK_NOT_FOUND", "Task not found");
      assertTaskTransition(current.state, state);
      const now = Date.now();
      const collection = this.client.collection("tasks") as unknown as ConditionalCollection;
      const update = {
        state,
        ...extra,
        updated_at: now,
        ...(state === "running" ? { started_at: now } : {}),
        ...(["completed", "failed", "cancelled"].includes(state)
          ? { finished_at: now }
          : {}),
      };
      const record = typeof collection.updateConditional === "function"
        ? await collection.updateConditional(id, { state: current.state, owner_id: ownerId }, update)
        : await collection.update(id, update);
      await this.audit(
      ownerId,
      ["completed", "failed", "cancelled"].includes(state)
        ? "task_result"
        : "task_state_changed",
      id,
      {
        from: current.state,
        to: state,
        ...(extra.result === undefined ? {} : { result: extra.result }),
        ...(extra.error_code === undefined
          ? {}
          : { error_code: extra.error_code }),
      },
      );
      const inboxKind = (value: TaskState): "review_required" | "task_completed" | "task_failed" | undefined => value === "review_required" ? "review_required" : value === "completed" ? "task_completed" : value === "failed" ? "task_failed" : undefined;
      const kind = inboxKind(state);
      const previousKind = inboxKind(current.state);
      if (previousKind && previousKind !== kind) await this.inbox.resolveReference(ownerId, previousKind, id, current.project_id);
      if (kind) {
        await this.inbox.upsert({
          owner_id: ownerId,
          ...(current.project_id ? { project_id: current.project_id } : {}),
          kind,
          reference_id: id,
          title: state === "review_required" ? "Task requires review" : state === "completed" ? "Task completed" : "Task failed",
          body: state === "failed" ? "The task failed and may need attention." : state === "review_required" ? "Review the task result before approving it." : "The task completed successfully.",
          deep_link: { taskId: id },
          underlying_state: state,
          metadata: { state, task_id: id },
          reopen: true,
        });
        for (const previous of ["review_required", "task_completed", "task_failed"] as const) if (previous !== kind && previous !== previousKind) await this.inbox.resolveReference(ownerId, previous, id, current.project_id);
      }
      return task(record);
    });
  }

  async review(
    ownerId: string,
    id: string,
    decision: "approved" | "rejected",
    note?: string,
  ): Promise<TaskRecord> {
    const current = await this.getOwned(ownerId, id);
    if (!current)
      throw new TaskControlError("TASK_NOT_FOUND", "Task not found");
    if (current.state !== "review_required")
      throw new TaskControlError(
        "INVALID_REVIEW",
        "Task is not awaiting review",
      );
    const result = await this.transition(
      ownerId,
      id,
      decision === "approved" ? "completed" : "failed",
      { review_state: decision, ...(note ? { review_note: note } : {}) },
    );
    await this.audit(ownerId, "approval_changed", id, {
      decision,
      ...(note ? { note } : {}),
    });
    return result;
  }

  async addActivity(
    ownerId: string,
    taskId: string,
    input: Omit<TaskActivity, "task_id" | "owner_id" | "created_at">,
  ): Promise<TaskActivity> {
    assertSafeIdentifier(ownerId, "owner id");
    assertSafeIdentifier(taskId, "task id");
    if (!(await this.getOwned(ownerId, taskId)))
      throw new TaskControlError("TASK_NOT_FOUND", "Task not found");
    const value = {
      ...input,
      task_id: taskId,
      owner_id: ownerId,
      created_at: Date.now(),
    };
    const activity = await this.client
      .collection("task_activity")
      .create(value) as TaskActivity;
    await this.audit(ownerId, "activity_added", taskId, {
      kind: input.kind,
      summary: input.summary,
    });
    return activity;
  }

  async listActivity(ownerId: string, taskId: string): Promise<TaskActivity[]> {
    assertSafeIdentifier(ownerId, "owner id");
    assertSafeIdentifier(taskId, "task id");
    if (!(await this.getOwned(ownerId, taskId)))
      throw new TaskControlError("TASK_NOT_FOUND", "Task not found");
    return this.client
      .collection("task_activity")
      .getFullList({
        filter: `owner_id = "${escapeFilter(ownerId)}" && task_id = "${escapeFilter(taskId)}"`,
        sort: "created_at",
      }) as Promise<TaskActivity[]>;
  }

  async listAudit(ownerId: string, taskId: string): Promise<Record<string, unknown>[]> {
    assertSafeIdentifier(ownerId, "owner id");
    assertSafeIdentifier(taskId, "task id");
    if (!(await this.getOwned(ownerId, taskId)))
      throw new TaskControlError("TASK_NOT_FOUND", "Task not found");
    return this.client.collection("task_audit").getFullList({
      filter: `owner_id = "${escapeFilter(ownerId)}" && task_id = "${escapeFilter(taskId)}"`,
      sort: "created_at",
    }) as Promise<Record<string, unknown>[]>;
  }

  private async audit(
    ownerId: string,
    event: string,
    taskId: string,
    details: unknown,
  ): Promise<void> {
    assertSafeIdentifier(ownerId, "owner id");
    assertSafeIdentifier(taskId, "task id");
    await this.client
      .collection("task_audit")
      .create({
        owner_id: ownerId,
        task_id: taskId,
        event,
        details,
        created_at: Date.now(),
      });
  }
}

export async function ensureTaskCollections(client: PocketBase): Promise<void> {
  const collections = client.collections as unknown as {
    getOne: (name: string) => Promise<Record<string, unknown>>;
    create: (data: Record<string, unknown>) => Promise<unknown>;
    update: (id: string, data: Record<string, unknown>) => Promise<unknown>;
  };
  const define = async (
    name: string,
    fields: Record<string, unknown>[],
    indexes: string[] = [],
  ) => {
    const existing = await collections.getOne(name).catch(() => null);
    if (!existing)
      return collections
        .create({ name, type: "base", fields, indexes })
        .then(() => undefined);
    const current = Array.isArray(existing.fields)
      ? (existing.fields as Record<string, unknown>[])
      : [];
    const known = new Set(current.map((field) => String(field.name)));
    const missing = fields.filter((field) => !known.has(String(field.name)));
    if (missing.length)
      await collections.update(String(existing.id), {
        fields: [...current, ...missing],
      });
  };
  await define(
    "tasks",
    [
      { name: "owner_id", type: "text", required: true },
      { name: "project_id", type: "text" },
      { name: "session_id", type: "text" },
      { name: "parent_run_id", type: "text" },
      { name: "agent_id", type: "text" },
      { name: "subagent_id", type: "text" },
      { name: "worktree_id", type: "text" },
      { name: "base_ref", type: "text" },
      {
        name: "state",
        type: "select",
        required: true,
        values: [...TASK_STATES],
        maxSelect: 1,
      },
      {
        name: "kind",
        type: "select",
        required: true,
        values: ["task", "subagent_run"],
        maxSelect: 1,
      },
      { name: "title", type: "text", required: true },
      { name: "input", type: "json" },
      { name: "result", type: "json" },
      {
        name: "review_state",
        type: "select",
        values: ["pending", "approved", "rejected"],
        maxSelect: 1,
      },
      { name: "review_note", type: "text" },
      { name: "error_code", type: "text" },
      { name: "error_message", type: "text" },
      { name: "created_at", type: "number", required: true },
      { name: "updated_at", type: "number", required: true },
      { name: "started_at", type: "number" },
      { name: "finished_at", type: "number" },
    ],
    [
      "CREATE INDEX idx_tasks_owner_state ON tasks (owner_id, state, created_at)",
    ],
  );
  await define(
    "task_activity",
    [
      { name: "owner_id", type: "text", required: true },
      { name: "task_id", type: "text", required: true },
      { name: "kind", type: "text", required: true },
      { name: "summary", type: "text", required: true },
      { name: "details", type: "json" },
      { name: "created_at", type: "number", required: true },
    ],
    [
      "CREATE INDEX idx_task_activity_task ON task_activity (owner_id, task_id, created_at)",
    ],
  );
  await define(
    "task_audit",
    [
      { name: "owner_id", type: "text", required: true },
      { name: "task_id", type: "text", required: true },
      { name: "event", type: "text", required: true },
      { name: "details", type: "json" },
      { name: "created_at", type: "number", required: true },
    ],
    [
      "CREATE INDEX idx_task_audit_task ON task_audit (owner_id, task_id, created_at)",
    ],
  );
  await define(
    "task_worktrees",
    [
      { name: "owner_id", type: "text", required: true },
      { name: "project_id", type: "text", required: true },
      { name: "task_id", type: "text", required: true },
      { name: "path", type: "text", required: true },
      { name: "base_ref", type: "text", required: true },
      { name: "branch", type: "text", required: true },
      {
        name: "state",
        type: "select",
        required: true,
        values: ["active", "removed"],
        maxSelect: 1,
      },
      { name: "created_at", type: "number", required: true },
      { name: "updated_at", type: "number", required: true },
      { name: "error_code", type: "text" },
      { name: "error_message", type: "text" },
    ],
    [
      "CREATE INDEX idx_task_worktrees_owner ON task_worktrees (owner_id, task_id)",
    ],
  );
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
