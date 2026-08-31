/** Run a copy of the current session as a detached, one-shot background agent. */
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type BackgroundSession = {
  path: string;
  name: string;
  status: "running" | "done";
  createdAt: number;
};

type BackgroundBridge = {
  getSessions: () => BackgroundSession[];
  setRefresh: (refresh: () => void) => void;
};

const bridgeKey = "__piBackgroundSessions";
const registryPath = join(homedir(), ".pi", "agent", "background-sessions.json");

function readSessions(): BackgroundSession[] {
  try {
    const value = JSON.parse(readFileSync(registryPath, "utf8")) as unknown;
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is BackgroundSession =>
      !!item && typeof item === "object" &&
      typeof (item as BackgroundSession).path === "string" &&
      typeof (item as BackgroundSession).name === "string" &&
      ((item as BackgroundSession).status === "running" || (item as BackgroundSession).status === "done"),
    );
  } catch {
    return [];
  }
}

function writeSessions(sessions: BackgroundSession[]): void {
  mkdirSync(dirname(registryPath), { recursive: true });
  const temporary = `${registryPath}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(sessions, null, 2)}\n`, "utf8");
  renameSync(temporary, registryPath);
}

function updateSession(path: string, status: BackgroundSession["status"]): void {
  const sessions = readSessions();
  const updated = sessions.map((session) => session.path === path ? { ...session, status } : session);
  writeSessions(updated);
}

function removeSession(path: string): void {
  const sessions = readSessions().filter((session) => session.path !== path);
  writeSessions(sessions);
}

function getBridge(): BackgroundBridge | undefined {
  return (globalThis as Record<string, unknown>)[bridgeKey] as BackgroundBridge | undefined;
}

export default function backgroundExtension(pi: ExtensionAPI) {
  let refresh: (() => void) | undefined;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  const backgroundPath = process.env.PI_BACKGROUND_SESSION_FILE;

  const redraw = () => refresh?.();

  const installBridge = () => {
    const bridge: BackgroundBridge = {
      getSessions: readSessions,
      setRefresh: (callback) => { refresh = callback; redraw(); },
    };
    (globalThis as Record<string, unknown>)[bridgeKey] = bridge;
  };

  pi.registerCommand("background", {
    description: "Run a copy of this session in the background",
    handler: async (args, ctx) => {
      const source = ctx.sessionManager.getSessionFile();
      if (!source || !existsSync(source)) {
        ctx.ui.notify("Cannot background an unsaved session", "error");
        return;
      }

      const name = ctx.sessionManager.getSessionName() ?? "Unnamed session";
      const suffix = `${Date.now()}-${randomBytes(3).toString("hex")}`;
      const target = join(dirname(source), `${basename(source, ".jsonl")}-background-${suffix}.jsonl`);
      copyFileSync(source, target);
      const sessions = readSessions().filter((session) => session.path !== target);
      sessions.push({ path: target, name, status: "running", createdAt: Date.now() });
      writeSessions(sessions);
      redraw();

      const executable = process.argv[1];
      const child = executable
        ? spawn(process.execPath, [executable, "--mode", "rpc", "--session", target], {
            cwd: ctx.cwd,
            detached: true,
            stdio: ["pipe", "ignore", "ignore"],
            env: { ...process.env, PI_BACKGROUND_SESSION_FILE: target },
          })
        : spawn("pi", ["--mode", "rpc", "--session", target], {
            cwd: ctx.cwd,
            detached: true,
            stdio: ["pipe", "ignore", "ignore"],
            env: { ...process.env, PI_BACKGROUND_SESSION_FILE: target },
          });

      child.once("error", () => { updateSession(target, "done"); redraw(); });
      child.once("exit", () => { updateSession(target, "done"); redraw(); });
      // RPC accepts commands from stdin as soon as it starts; sending the prompt
      // here also makes /background useful without requiring a second command.
      child.stdin?.write(`${JSON.stringify({ type: "prompt", message: args?.trim() || "Continue working on the current task." })}\n`);
      child.unref();
      ctx.ui.notify(`Background session started: ${name}`, "info");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    installBridge();
    if (backgroundPath) {
      updateSession(backgroundPath, "running");
      redraw();
      return;
    }
    const current = ctx.sessionManager.getSessionFile();
    if (current) removeSession(current);
    redraw();
    pollTimer = setInterval(redraw, 1000);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (!backgroundPath) return;
    updateSession(backgroundPath, "done");
    redraw();
    ctx.shutdown();
  });

  pi.on("session_shutdown", async () => {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = undefined;
  });
}
