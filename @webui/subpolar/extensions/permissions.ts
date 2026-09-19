/** Per-agent, per-tool permissions.
 *
 * Configuration (project values override global values):
 *   ~/.pi/agent/permissions.json
 *   .pi/permissions.json
 *
 * {
 *   "permissionAutoApprovalModel": "openai-codex/gpt-5.4-mini",
 *   "agents": { "reviewer": { "bash": "manual", "read": "auto" } }
 * }
 *
 * `deny`, `manual`, and `auto` are intentionally different from Pi's active
 * tool list: a manually approved tool remains visible to the model. This
 * makes changing a permission in the TUI or web client take effect without a
 * restart or without rebuilding the agent's prompt.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

type Level = "deny" | "manual" | "auto";
type Permissions = Record<string, Record<string, Level>>;
type Config = { permissionAutoApprovalModel?: string; agents?: Permissions };

function compatibilityPermissions(value: any): Permissions {
  const result: Permissions = {};
  for (const [name, profile] of Object.entries(object(value))) {
    const item = object(profile);
    const rules: Record<string, Level> = {};
    for (const tool of Array.isArray(item.toolAccess) ? item.toolAccess : []) {
      const entry = object(tool);
      const permission = entry.permission === "allow" ? "auto" : entry.permission === "ask" ? "manual" : entry.permission;
      if (typeof entry.id === "string" && level(permission)) rules[entry.id] = permission as Level;
    }
    const legacy = object(item.permission);
    for (const [tool, permission] of Object.entries(legacy)) {
      const mapped = permission === "allow" ? "auto" : permission === "ask" ? "manual" : permission;
      if (typeof mapped === "string" && level(mapped)) rules[tool] = mapped as Level;
    }
    if (Object.keys(rules).length) result[name] = rules;
  }
  return result;
}
const MASTER = "master";
const DEFAULT_MODEL = "openai-codex/gpt-5.4-mini";

function object(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}
function readConfig(path: string): Config {
  if (!existsSync(path)) return {};
  try { return JSON.parse(readFileSync(path, "utf8")) as Config; }
  catch (error) { console.error(`Failed to read permissions from ${path}:`, error); return {}; }
}
function mergeConfig(global: Config, local: Config): Config {
  const agents: Permissions = {};
  for (const source of [global.agents ?? global, local.agents ?? local]) {
    for (const [agent, values] of Object.entries(source)) {
      if (agent === "agents" || agent === "permissionAutoApprovalModel" || !object(values)) continue;
      agents[agent] = { ...(agents[agent] ?? {}), ...values } as Record<string, Level>;
    }
  }
  return { permissionAutoApprovalModel: local.permissionAutoApprovalModel ?? global.permissionAutoApprovalModel ?? DEFAULT_MODEL, agents };
}
function level(value: unknown): Level | undefined {
  return value === "deny" || value === "manual" || value === "auto" ? value : undefined;
}
function formatInput(input: Record<string, unknown>): string {
  try { return JSON.stringify(input, null, 2); } catch { return String(input); }
}
function modelId(value: string): { provider: string; id: string } | undefined {
  const slash = value.indexOf("/");
  return slash > 0 && slash < value.length - 1 ? { provider: value.slice(0, slash), id: value.slice(slash + 1) } : undefined;
}

export default function permissionsExtension(pi: ExtensionAPI) {
  let config: Config = { permissionAutoApprovalModel: DEFAULT_MODEL, agents: {} };
  let cwd = process.cwd();
  let agent = MASTER;

  const paths = () => [join(getAgentDir(), "permissions.json"), join(cwd, ".pi", "permissions.json")];
  const reload = () => {
    const [global, local] = paths().map(readConfig);
    config = mergeConfig(global, local);
    // Also understand the profile/toolAccess shape used by the web client and
    // older agent-profiles.json files. Explicit permissions.json wins.
    for (const path of [join(getAgentDir(), "agents.json"), join(cwd, ".pi", "agents.json")]) {
      if (!existsSync(path)) continue;
      try {
        const compatibility = compatibilityPermissions(JSON.parse(readFileSync(path, "utf8")));
        config.agents = Object.fromEntries(Object.entries(compatibility).map(([name, values]) => [name, { ...values, ...(config.agents?.[name] ?? {}) }]));
      } catch { /* malformed profile files are handled by agent-profiles */ }
    }
  };
  const currentLevel = (tool: string): Level => {
    if (agent === MASTER) return "auto";
    const rules = config.agents?.[agent] ?? {};
    return level(rules[tool]) ?? level(rules["*"]) ?? "deny";
  };
  const saveProject = () => {
    const path = paths()[1];
    const root: Config = { permissionAutoApprovalModel: config.permissionAutoApprovalModel, agents: config.agents };
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(root, null, 2)}\n`, "utf8");
  };
  const stateAgent = (ctx: ExtensionContext): string => {
    let result = MASTER;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === "agent-profile-state" && typeof (entry.data as any)?.name === "string") result = (entry.data as any).name;
    }
    return result;
  };
  const result = (text: string, details: unknown = {}) => ({ content: [{ type: "text" as const, text }], details });

  pi.registerCommand("permissions", {
    description: "View or change per-agent tool permissions",
    handler: async (args, ctx) => {
      reload();
      const names = [MASTER, ...Object.keys(config.agents ?? {}).filter(name => name !== MASTER).sort()];
      const parts = args?.trim().split(/\s+/).filter(Boolean) ?? [];
      if (parts[0] === "list" || (!parts.length && !ctx.hasUI)) {
        ctx.ui.notify(names.map(name => `${name}: ${name === MASTER ? "all auto" : JSON.stringify(config.agents?.[name] ?? {})}`).join("\n"), "info");
        return;
      }
      const selectedAgent = parts[0] && names.includes(parts[0]) ? parts[0] : (await ctx.ui.select("Agent", names));
      if (!selectedAgent) return;
      const tools = [...new Set(pi.getAllTools().map(tool => tool.name))].sort();
      const selectedTool = parts[1] && tools.includes(parts[1]) ? parts[1] : await ctx.ui.select("Tool", tools);
      if (!selectedTool) return;
      const selectedLevel = parts[2] as Level | undefined;
      const next = selectedLevel && ["deny", "manual", "auto"].includes(selectedLevel)
        ? selectedLevel
        : await ctx.ui.select(`Permission for ${selectedAgent}/${selectedTool}`, ["deny", "manual", "auto"]);
      if (!next || selectedAgent === MASTER) { if (selectedAgent === MASTER) ctx.ui.notify("master always has all permissions", "info"); return; }
      config.agents ??= {};
      config.agents[selectedAgent] = { ...(config.agents[selectedAgent] ?? {}), [selectedTool]: next as Level };
      saveProject();
      ctx.ui.notify(`${selectedAgent}/${selectedTool}: ${next}`, "info");
    },
  });

  pi.registerTool({
    name: "manage_permissions",
    label: "Manage Permissions",
    description: "List or set per-agent, per-tool deny/manual/auto permissions. Master only.",
    promptSnippet: "Manage agent tool permissions",
    parameters: Type.Object({ agent: Type.Optional(Type.String()), tool: Type.Optional(Type.String()), permission: Type.Optional(Type.String()) }),
    async execute(_id, params) {
      reload();
      if (agent !== MASTER) return result("Only the master agent can manage permissions.");
      if (!params.agent || !params.tool) return result(JSON.stringify({ permissionAutoApprovalModel: config.permissionAutoApprovalModel, agents: config.agents }, null, 2), { config });
      const next = level(params.permission);
      if (!next) return result("permission must be deny, manual, or auto");
      config.agents ??= {};
      config.agents[params.agent] = { ...(config.agents[params.agent] ?? {}), [params.tool]: next };
      saveProject();
      return result(`Set ${params.agent}/${params.tool} to ${next}`);
    },
  });

  pi.on("tool_call", async (event: ToolCallEvent, ctx) => {
    // Profile switching appends its state entry after the command handler;
    // resolve it here as well as on session events so the next tool call uses
    // the newly selected agent immediately.
    agent = stateAgent(ctx);
    // Master is the trusted controller and must never be gated by its own
    // permission reviewer (including management tools).
    if (agent === MASTER) return;
    const selected = currentLevel(event.toolName);
    if (selected === "auto") {
      const configured = modelId(config.permissionAutoApprovalModel ?? DEFAULT_MODEL);
      const model = configured && ctx.modelRegistry.find(configured.provider, configured.id);
      if (!model || !ctx.modelRegistry.hasConfiguredAuth(model)) return { block: true, reason: `Auto-approval model unavailable: ${config.permissionAutoApprovalModel}` };
      try {
        const response = await ctx.modelRegistry.complete(model, {
          systemPrompt: "You are a security permission reviewer. Reply with exactly ALLOW or DENY. Allow only if the proposed tool call is clearly safe and useful for the agent's task.",
          messages: [{ role: "user", content: [{ type: "text", text: `Tool: ${event.toolName}\nArguments:\n${formatInput(event.input)}\nShould this call be allowed?` }], timestamp: Date.now() }],
        }, { signal: ctx.signal, cacheRetention: "none" });
        const text = response.content.filter((part): part is { type: "text"; text: string } => part.type === "text").map(part => part.text).join(" ").trim().toUpperCase();
        if (/\bALLOW\b/.test(text) && !/\bDENY\b/.test(text)) return;
        return { block: true, reason: "Auto-approval model denied this tool call" };
      } catch (error) { return { block: true, reason: `Auto-approval failed: ${error instanceof Error ? error.message : String(error)}` }; }
    }
    if (selected === "manual") {
      if (!ctx.hasUI) return { block: true, reason: "Manual approval requires an interactive UI" };
      const approved = await ctx.ui.confirm(`Approve ${event.toolName}?`, formatInput(event.input));
      if (approved) return;
      return { block: true, reason: "Permission denied by user" };
    }
    return { block: true, reason: `Tool ${event.toolName} is denied for agent ${agent}` };
  });

  pi.on("session_start", async (_event, ctx) => { cwd = ctx.cwd; reload(); agent = stateAgent(ctx); });
  pi.on("session_tree", async (_event, ctx) => { agent = stateAgent(ctx); });
}
