import { describe, expect, it } from "bun:test";
import { SubagentController, SubagentControlError } from "./subagent-control.ts";

function harness(limit = 1) {
  let sequence = 0;
  const records = new Map<string, any>();
  const activities: any[] = [];
  const tasks = {
    async create(input: any) { const task = { ...input, id: `task-${++sequence}`, created_at: Date.now(), updated_at: Date.now() }; records.set(task.id, task); return task; },
    async getOwned(owner: string, id: string) { const task = records.get(id); return task?.owner_id === owner ? task : null; },
    async transition(owner: string, id: string, state: string, extra = {}) { const task = await this.getOwned(owner, id); if (!task) throw new Error("not found"); task.state = state; Object.assign(task, extra); return task; },
    async addActivity(owner: string, taskId: string, activity: any) { activities.push({ owner, taskId, ...activity }); return activity; },
    async findWaitingForApproval(owner: string, approvalId: string) { return [...records.values()].find((task) => task.owner_id === owner && task.state === "waiting_for_approval" && task.input.approvalId === approvalId) ?? null; },
  } as any;
  return { records, activities, tasks, controller: (execute: any, approval = async () => true) => new SubagentController(tasks, {} as any, execute, limit, async () => true, approval) };
}

describe("subagent controller execution", () => {
  it("invokes the host and records result activity", async () => {
    const h = harness(); let invoked = false;
    const task = await h.controller(async ({ task }: any) => { invoked = true; return { taskId: task.id }; }).run({ ownerId: "u", sessionId: "s", parentAgent: "master", targetAgent: "child", prompt: "work", capabilities: ["read"] }, ["read"]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(invoked).toBe(true); expect(task.state).toBe("completed"); expect(h.activities.map((a) => a.kind)).toEqual(expect.arrayContaining(["started", "completed"]));
  });

  it("pauses for approval and resumes only after approval", async () => {
    const h = harness(); let invoked = false;
    const controller = h.controller(async () => { invoked = true; return "ok"; }, async () => true);
    const task = await controller.run({ ownerId: "u", sessionId: "s", parentAgent: "master", targetAgent: "child", prompt: "work", capabilities: ["read"], approvalId: "approval-1" }, ["read"]);
    expect(task.state).toBe("waiting_for_approval"); expect(invoked).toBe(false);
    await controller.resume("u", task.id); await new Promise((resolve) => setTimeout(resolve, 0));
    expect(invoked).toBe(true);
  });

  it("resumes a persisted approval without the original controller instance", async () => {
    const h = harness(); let invoked = false;
    const first = h.controller(async () => { invoked = true; return "ok"; }, async () => true);
    const task = await first.run({ ownerId: "u", sessionId: "s", parentAgent: "master", targetAgent: "child", prompt: "work", capabilities: ["read"], approvalId: "approval-restart" }, ["read"]);
    const restarted = h.controller(async () => { invoked = true; return "ok"; }, async () => true);
    await restarted.resume("u", task.id);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(invoked).toBe(true);
  });

  it("reserves concurrency before awaited execution and supports cancellation", async () => {
    const h = harness(); let release!: () => void; const blocked = new Promise<void>((resolve) => { release = resolve; });
    const controller = h.controller(async ({ signal }: any) => { await blocked; if (signal.aborted) throw new Error("aborted"); return null; });
    const first = await controller.run({ ownerId: "u", sessionId: "s", parentAgent: "master", targetAgent: "child", prompt: "one", capabilities: ["read"] }, ["read"]);
    await expect(controller.run({ ownerId: "u", sessionId: "s", parentAgent: "master", targetAgent: "child", prompt: "two", capabilities: ["read"] }, ["read"])).rejects.toThrow(SubagentControlError);
    await controller.cancel("u", first.id); release(); await new Promise((resolve) => setTimeout(resolve, 0));
    expect(first.state).toBe("cancelled");
  });

  it("rejects foreign task cancellation and capability escalation", async () => {
    const h = harness(); const controller = h.controller(async () => null);
    const task = await controller.run({ ownerId: "u", sessionId: "s", parentAgent: "master", targetAgent: "child", prompt: "work", capabilities: ["read"] }, ["read"]);
    await expect(controller.cancel("other", task.id)).rejects.toThrow(SubagentControlError);
    await expect(controller.run({ ownerId: "u", sessionId: "s", parentAgent: "master", targetAgent: "child", prompt: "work", capabilities: ["write"] }, ["read"])).rejects.toThrow(SubagentControlError);
  });
});
