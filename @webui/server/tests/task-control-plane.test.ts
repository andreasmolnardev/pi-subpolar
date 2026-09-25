import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertTaskTransition } from "../application/task-control-plane.ts";
import {
  constrainCapabilities,
  SubagentControlError,
} from "../application/tools/subagent-control.ts";
import { WorktreeController } from "../git/worktree-control.ts";

describe("task control plane", () => {
  it("enforces roadmap transitions", () => {
    expect(() => assertTaskTransition("draft", "running")).toThrow(
      "cannot transition",
    );
    expect(() => assertTaskTransition("queued", "running")).not.toThrow();
  });
  it("does not allow capability escalation", () => {
    expect(() => constrainCapabilities(["read"], ["write"])).toThrow(
      SubagentControlError,
    );
  });
  it("records isolated worktree ownership and base ref", async () => {
    const records: unknown[] = [];
    const commands: readonly string[][] = [];
    const controller = new WorktreeController(
      {
        create: async (record) => {
          records.push(record);
        },
        update: async () => undefined,
      },
      async (args) => {
        (commands as string[][]).push([...args]);
        return { stdout: "", stderr: "", code: 0 };
      },
      "/tmp/subpolar-test-worktrees",
      "/tmp/subpolar-test-worktrees",
    );
    const record = await controller.create({
      ownerId: "user-a",
      projectId: "project-a",
      repository: "/tmp/subpolar-test-worktrees/repo",
      baseRef: "refs/heads/main",
      taskId: "task-a",
    });
    expect(record.ownerId).toBe("user-a");
    expect(record.baseRef).toBe("refs/heads/main");
    expect(record.path).not.toBe("/repo");
    expect(commands[0]).toEqual([
      "worktree", "add", "-b", record.branch, record.path, "refs/heads/main",
    ]);
    expect(records).toHaveLength(1);
    expect(record.path).toContain("/user-a/task-a/");
  });

  it("derives storage from a custom projects root", async () => {
    const projectsRoot = mkdtempSync(join(tmpdir(), "subpolar-projects-"));
    const previous = process.env.SUBPOLAR_PROJECTS_ROOT;
    process.env.SUBPOLAR_PROJECTS_ROOT = projectsRoot;
    try {
      let recordPath = "";
      const controller = new WorktreeController(
        { create: async (record) => { recordPath = record.path; }, update: async () => undefined },
        async () => ({ stdout: "", stderr: "", code: 0 }),
      );
      await controller.create({ ownerId: "user-a", projectId: "project-a", repository: projectsRoot, baseRef: "HEAD", taskId: "task-a" });
      expect(recordPath).toMatch(new RegExp(`^${projectsRoot}/worktrees/user-a/task-a/`));
    } finally {
      if (previous === undefined) delete process.env.SUBPOLAR_PROJECTS_ROOT;
      else process.env.SUBPOLAR_PROJECTS_ROOT = previous;
      rmSync(projectsRoot, { recursive: true, force: true });
    }
  });

  it("rejects a worktree path outside its owner and task directory", async () => {
    const controller = new WorktreeController(
      { create: async () => undefined, update: async () => undefined },
      async () => ({ stdout: "", stderr: "", code: 0 }),
      "/tmp/subpolar-test-worktrees",
      "/tmp/subpolar-test-worktrees",
    );
    await expect(controller.remove({
      id: "worktree-a", ownerId: "user-a", projectId: "project-a", taskId: "task-a",
      path: "/tmp/subpolar-test-worktrees/user-b/task-a/worktree-a",
      baseRef: "main", branch: "subpolar/worktree-a", state: "active",
    })).rejects.toThrow("Worktree path is not owned");
  });

  it("keeps failed removals active and reports the failure", async () => {
    const updates: unknown[] = [];
    const controller = new WorktreeController(
      {
        create: async () => undefined,
        update: async (_id, update) => updates.push(update),
        addActivity: async (...args) => updates.push(args),
      },
      async () => ({ stdout: "", stderr: "cannot remove", code: 1 }),
      "/tmp/subpolar-test-worktrees",
      "/tmp/subpolar-test-worktrees",
    );
    await expect(controller.remove({
      id: "worktree-a", ownerId: "user-a", projectId: "project-a",
      taskId: "task-a", path: "/tmp/subpolar-test-worktrees/user-a/task-a/worktree-a",
      baseRef: "main", branch: "subpolar/worktree-a", state: "active",
    })).rejects.toThrow("cannot remove");
    expect(updates).toEqual(expect.arrayContaining([
      expect.objectContaining({ errorCode: "WORKTREE_REMOVE_FAILED" }),
    ]));
  });

  it("cleans up and audits a worktree when persistence fails", async () => {
    const activities: unknown[] = [];
    const commands: string[][] = [];
    const controller = new WorktreeController({
      create: async () => { throw new Error("database unavailable"); },
      update: async () => undefined,
      addActivity: async (...args) => { activities.push(args); },
    }, async (args) => { commands.push([...args]); return { stdout: "", stderr: "", code: 0 }; }, "/tmp/subpolar-test-worktrees", "/tmp/subpolar-test-worktrees");
    await expect(controller.create({ ownerId: "user-a", projectId: "project-a", repository: "/tmp/subpolar-test-worktrees/repo", baseRef: "HEAD", taskId: "task-a" })).rejects.toThrow("database unavailable");
    expect(commands[1]?.slice(0, 3)).toEqual(["worktree", "remove", "--force"]);
    expect(activities).toEqual(expect.arrayContaining([expect.arrayContaining(["user-a", "task-a", expect.stringContaining("cleaned up")]) ]));
  });
});
