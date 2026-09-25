import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { canonicalProjectPath, configuredWorkspaceRoot, isPathWithin } from "../core/project-filesystem.ts";
import { assertSafeIdentifier } from "../application/task-control-plane.ts";
import { safeRef } from "./policy.ts";
import type { GitExecutor } from "./executor.ts";
import { executeGit } from "./executor.ts";
import type PocketBase from "pocketbase";

export type WorktreeRecord = {
  id: string;
  ownerId: string;
  projectId: string;
  path: string;
  baseRef: string;
  branch: string;
  state: "active" | "removed";
  taskId?: string;
  errorCode?: string;
  errorMessage?: string;
};
export type WorktreeStore = {
  create(record: WorktreeRecord): Promise<void>;
  update(id: string, update: Partial<WorktreeRecord>): Promise<unknown>;
  linkTask?(taskId: string, worktreeId: string, ownerId: string): Promise<unknown>;
  addActivity?(ownerId: string, taskId: string, summary: string, details?: unknown): Promise<unknown>;
};

export class PocketBaseWorktreeStore implements WorktreeStore {
  constructor(private readonly client: PocketBase) {}
  async create(record: WorktreeRecord): Promise<void> {
    assertSafeIdentifier(record.id, "worktree id");
    assertSafeIdentifier(record.ownerId, "owner id");
    assertSafeIdentifier(record.projectId, "project id");
    assertSafeIdentifier(record.taskId ?? record.id, "task id");
    await this.client
      .collection("task_worktrees")
      .create({
        id: record.id,
        owner_id: record.ownerId,
        project_id: record.projectId,
        task_id: record.taskId,
        path: record.path,
        base_ref: record.baseRef,
        branch: record.branch,
        state: record.state,
        error_code: record.errorCode,
        error_message: record.errorMessage,
        created_at: Date.now(),
        updated_at: Date.now(),
      });
    if (record.taskId)
      await this.client.collection("task_audit").create({
        owner_id: record.ownerId,
        task_id: record.taskId,
        event: "worktree_created",
        details: { worktree_id: record.id, path: record.path, branch: record.branch },
        created_at: Date.now(),
      });
  }
  async update(id: string, update: Partial<WorktreeRecord>): Promise<void> {
    assertSafeIdentifier(id, "worktree id");
    await this.client
      .collection("task_worktrees")
      .update(id, {
        ...(update.state ? { state: update.state } : {}),
        ...(update.errorCode === undefined ? {} : { error_code: update.errorCode }),
        ...(update.errorMessage === undefined ? {} : { error_message: update.errorMessage }),
        updated_at: Date.now(),
      });
  }
  async linkTask(taskId: string, worktreeId: string, ownerId: string): Promise<void> {
    assertSafeIdentifier(taskId, "task id");
    assertSafeIdentifier(worktreeId, "worktree id");
    assertSafeIdentifier(ownerId, "owner id");
    await this.client.collection("tasks").update(taskId, { worktree_id: worktreeId, updated_at: Date.now() });
    await this.client.collection("task_audit").create({ owner_id: ownerId, task_id: taskId, event: "worktree_linked", details: { worktree_id: worktreeId }, created_at: Date.now() });
  }
  async addActivity(ownerId: string, taskId: string, summary: string, details?: unknown): Promise<void> {
    assertSafeIdentifier(ownerId, "owner id");
    assertSafeIdentifier(taskId, "task id");
    await this.client.collection("task_activity").create({
      owner_id: ownerId,
      task_id: taskId,
      kind: "worktree",
      summary,
      details,
      created_at: Date.now(),
    });
    await this.client.collection("task_audit").create({
      owner_id: ownerId,
      task_id: taskId,
      event: "worktree_changed",
      details: { summary, details },
      created_at: Date.now(),
    });
  }
}

export class WorktreeController {
  constructor(
    private readonly store: WorktreeStore,
    private readonly run: GitExecutor = executeGit,
    private readonly root = join(configuredWorkspaceRoot(), "worktrees"),
    private readonly workspaceRoot = configuredWorkspaceRoot(),
  ) {}
  async create(input: {
    ownerId: string;
    projectId: string;
    repository: string;
    baseRef: string;
    taskId: string;
  }): Promise<WorktreeRecord> {
    assertSafeIdentifier(input.ownerId, "owner id");
    assertSafeIdentifier(input.projectId, "project id");
    assertSafeIdentifier(input.taskId, "task id");
    const baseRef = safeRef(input.baseRef);
    if (!baseRef) throw new Error("Invalid base ref");
    const workspace = canonicalProjectPath(this.workspaceRoot);
    const repository = canonicalProjectPath(input.repository);
    const root = canonicalProjectPath(this.root);
    if (!isPathWithin(workspace, repository) || !isPathWithin(workspace, root))
      throw new Error("Worktree path is outside the configured workspace");
    const id = crypto.randomUUID().replaceAll("-", "").slice(0, 15);
    const branch = `subpolar/${id}`;
    const taskRoot = join(root, input.ownerId, input.taskId);
    const path = join(taskRoot, id);
    if (!isPathWithin(workspace, root) || !isPathWithin(root, taskRoot) || !isPathWithin(root, path))
      throw new Error("Worktree path is not owned");
    mkdirSync(taskRoot, { recursive: true });
    if (!isPathWithin(root, canonicalProjectPath(taskRoot)) || canonicalProjectPath(path) !== path)
      throw new Error("Worktree path is not owned");
    const result = await this.run(["worktree", "add", "-b", branch, path, baseRef], {
      cwd: repository,
    });
    if (result.code !== 0) throw new Error(result.stderr || "Git worktree creation failed");
    const record = {
      id,
      ownerId: input.ownerId,
      projectId: input.projectId,
      path,
      baseRef,
      branch,
      state: "active" as const,
      taskId: input.taskId,
    };
    try {
      await this.store.create(record);
      await this.store.linkTask?.(input.taskId, record.id, input.ownerId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      let cleaned = false;
      try {
        const cleanup = await this.run(["worktree", "remove", "--force", path], { cwd: path });
        cleaned = cleanup.code === 0;
      } catch { /* audit below records the orphan when cleanup fails */ }
      await this.store.update(record.id, { state: cleaned ? "removed" : "active", errorCode: "WORKTREE_PERSISTENCE_FAILED", errorMessage: message }).catch(() => undefined);
      if (this.store.addActivity) await this.store.addActivity(input.ownerId, input.taskId, cleaned ? "Worktree persistence failed; Git worktree cleaned up" : "Worktree persistence failed; Git worktree is orphaned", { worktreeId: id, error: message, cleanedUp: cleaned });
      throw error;
    }
    return record;
  }
  async remove(record: WorktreeRecord): Promise<void> {
    if (record.state === "removed") return;
    assertSafeIdentifier(record.ownerId, "owner id");
    assertSafeIdentifier(record.projectId, "project id");
    assertSafeIdentifier(record.id, "worktree id");
    if (record.taskId) assertSafeIdentifier(record.taskId, "task id");
    const root = canonicalProjectPath(this.root);
    const path = canonicalProjectPath(record.path);
    const expectedPath = join(root, record.ownerId, ...(record.taskId ? [record.taskId] : []), record.id);
    if (!isPathWithin(root, path) || path !== canonicalProjectPath(expectedPath)) throw new Error("Worktree path is not owned");
    try {
      const result = await this.run(["worktree", "remove", "--force", path], { cwd: path });
      if (result.code !== 0) throw new Error(result.stderr || "Git worktree removal failed");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.store.update(record.id, { errorCode: "WORKTREE_REMOVE_FAILED", errorMessage: message });
      if (record.taskId && this.store.addActivity)
        await this.store.addActivity(record.ownerId, record.taskId, "Worktree removal failed", { error: message });
      throw error;
    }
    await this.store.update(record.id, { state: "removed", errorCode: undefined, errorMessage: undefined });
    if (record.taskId && this.store.addActivity)
      await this.store.addActivity(record.ownerId, record.taskId, "Worktree removed", { worktreeId: record.id });
  }
}
