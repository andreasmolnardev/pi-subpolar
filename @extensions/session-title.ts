/** Generate a short session title after the first assistant response. */
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { type Message, uuidv7 } from "@earendil-works/pi-ai";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

const SYSTEM_PROMPT = `Create a concise title for this coding-agent session.
Return only the title, with no quotes, punctuation at the end, or explanation.
Use 3-8 words and describe the user's main task.`;

type Settings = Record<string, unknown>;

function readSettings(file: string): Settings {
  if (!existsSync(file)) return {};
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return value && typeof value === "object" ? value as Settings : {};
  } catch { return {}; }
}

function configuredModel(cwd: string): string | undefined {
  const global = readSettings(join(homedir(), ".pi", "agent", "settings.json"));
  const local = readSettings(join(cwd, ".pi", "settings.json"));
  const value = local.sessionTitleGenModel ?? global.sessionTitleGenModel;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function textOf(content: Message["content"]): string {
  if (typeof content === "string") return content;
  return content.filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text).join("\n");
}

function resolveModel(ctx: ExtensionContext, configured: string) {
  const slash = configured.indexOf("/");
  if (slash > 0) return ctx.modelRegistry.find(configured.slice(0, slash), configured.slice(slash + 1));
  const matches = ctx.modelRegistry.getAvailable().filter((model) => model.id === configured);
  return matches.length === 1 ? matches[0] : undefined;
}

function updateTerminalTitle(ctx: ExtensionContext, title?: string) {
  const project = basename(ctx.cwd) || "project";
  ctx.ui.setTitle(title ? `pi - ${project}: ${title}` : `pi - ${project}`);
}

function updateSessionStatus(ctx: ExtensionContext, title?: string) {
  ctx.ui.setStatus("session-title", title ? ctx.ui.theme.fg("accent", `title:${title}`) : undefined);
}

export default function sessionTitleExtension(pi: ExtensionAPI) {
  pi.registerCommand("sessions", {
    description: "Browse and switch sessions for this project",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return ctx.ui.notify("/sessions requires interactive mode", "error");
      const sessions = await SessionManager.list(ctx.cwd);
      if (!sessions.length) return ctx.ui.notify("No saved sessions", "info");
      const choices = sessions.map((session) => ({
        label: `${session.name ?? (session.firstMessage.slice(0, 70) || "Unnamed session")} · ${session.messageCount} messages · ${session.id.slice(-6)}`,
        path: session.path,
      }));
      const selected = await ctx.ui.select("Switch session", choices.map((choice) => choice.label));
      const choice = choices.find((item) => item.label === selected);
      if (choice) await ctx.switchSession(choice.path);
    },
  });

  let sawAssistant = false;
  let generating = false;

  pi.on("session_start", async (_event, ctx) => {
    sawAssistant = ctx.sessionManager.getBranch().some((entry) =>
      entry.type === "message" && entry.message.role === "assistant",
    );
    const title = pi.getSessionName();
    updateTerminalTitle(ctx, title);
    updateSessionStatus(ctx, title);
  });

  pi.on("session_info_changed", async (_event, ctx) => {
    const title = pi.getSessionName();
    updateTerminalTitle(ctx, title);
    updateSessionStatus(ctx, title);
  });

  pi.on("message_end", async (event, ctx) => {
    if (event.message.role !== "assistant" || sawAssistant || generating) return;
    sawAssistant = true;
    if (pi.getSessionName()) return;

    const configured = configuredModel(ctx.cwd);
    if (!configured) return;
    const model = resolveModel(ctx, configured);
    if (!model) {
      ctx.ui.notify(`Session title model not found: ${configured}`, "warning");
      return;
    }

    const firstUser = ctx.sessionManager.getBranch().find((entry) =>
      entry.type === "message" && entry.message.role === "user",
    );
    if (!firstUser || firstUser.type !== "message") return;
    generating = true;
    try {
      const prompt: Message = {
        role: "user",
        content: `User's first request:\n\n${textOf(firstUser.message.content)}`,
        timestamp: Date.now(),
      };
      const response = await ctx.modelRegistry.complete(model, {
        systemPrompt: SYSTEM_PROMPT,
        messages: [prompt],
      }, { cacheRetention: "none", sessionId: uuidv7() });
      const title = response.content.filter((part): part is { type: "text"; text: string } => part.type === "text")
        .map((part) => part.text).join(" ").replace(/[\r\n]+/g, " ").replace(/^['\"`]+|['\"`]+$/g, "").trim();
      if (title) {
        const sessionTitle = title.slice(0, 120);
        pi.setSessionName(sessionTitle);
        updateSessionStatus(ctx, sessionTitle);
      }
    } catch (error) {
      console.error("Session title generation failed:", error);
    } finally {
      generating = false;
    }
  });
}
