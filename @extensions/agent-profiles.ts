/**
 * Agent profiles for pi.
 *
 * Profiles are named combinations of a system prompt and an active tool list.
 * The built-in `master` profile (also called `omniscient`) leaves pi's normal
 * system prompt intact and has access to every registered tool. Every other profile replaces the
 * system prompt completely, so it does not receive pi's runtime instructions.
 *
 * Config files (project overrides global):
 *   ~/.pi/agent/agents.json
 *   .pi/agents.json
 *
 * Commands:
 *   /profile                 Select a profile
 *   /profile NAME            Activate a profile
 *   /profile create NAME     Create a profile interactively
 *   /profile list             List profiles
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const MASTER = "master";
const MASTER_ALIASES = new Set(["master", "omniscient"]);
const MASTER_PROFILE_TOOLS = ["list_agent_profiles", "create_agent_profile", "edit_agent_profile", "manage_openapi_tools"];

type Profile = {
  systemPrompt: string;
  tools: string[];
};

type Profiles = Record<string, Profile>;

type ProfileState = { name: string };

function readProfiles(path: string): Profiles {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    return parsed as Profiles;
  } catch (error) {
    console.error(`Failed to read profiles from ${path}:`, error);
    return {};
  }
}

function loadProfiles(cwd: string): Profiles {
  return {
    ...readProfiles(join(getAgentDir(), "agents.json")),
    ...readProfiles(join(cwd, CONFIG_DIR_NAME, "agents.json")),
  };
}

function saveProfiles(path: string, profiles: Profiles): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(profiles, null, 2)}\n`, "utf8");
}

function saveGlobalProfiles(profiles: Profiles): void {
  saveProfiles(join(getAgentDir(), "agents.json"), profiles);
}

function isValidName(name: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(name) && !MASTER_ALIASES.has(name.toLowerCase());
}

function lastState(ctx: ExtensionContext): ProfileState | undefined {
  let state: ProfileState | undefined;
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "custom" || entry.customType !== "agent-profile-state") continue;
    const data = entry.data as Partial<ProfileState> | undefined;
    if (typeof data?.name === "string") state = { name: data.name };
  }
  return state;
}

export default function agentProfiles(pi: ExtensionAPI) {
  let profiles: Profiles = {};
  let activeName = MASTER;
  let activeProfile: Profile | undefined;

  // The master profile is omniscient: it always receives every tool currently
  // registered, including tools generated later by extensions (for example,
  // provider_operationId tools from openapi-tools.ts).
  function allToolNames(): string[] {
    return [...new Set(pi.getAllTools().map((tool) => tool.name))];
  }

  pi.registerFlag("profile", {
    description: "Start with an agent profile",
    type: "string",
  });

  function profileNames(): string[] {
    return [MASTER, ...Object.keys(profiles).filter((name) => !MASTER_ALIASES.has(name.toLowerCase())).sort()];
  }

  function updateStatus(ctx: ExtensionContext): void {
    ctx.ui.setStatus("agent-profile", ctx.ui.theme.fg("accent", `profile:${activeName}`));
    ctx.ui.setWidget("agent-profiles", [
      "[Profiles]",
      `  ${profileNames().join(", ")}`,
    ]);
  }

  function apply(name: string, ctx: ExtensionContext): boolean {
    const normalized = name.toLowerCase() === "omniscient" ? MASTER : name;
    if (normalized !== MASTER && !profiles[normalized]) return false;

    activeName = normalized;
    activeProfile = normalized === MASTER ? undefined : profiles[normalized];
    // Profile-management tools are deliberately master-only, even if a config
    // file accidentally includes them in another profile's tool list.
    const profileTools = activeProfile?.tools.filter((tool) => !MASTER_PROFILE_TOOLS.includes(tool));
    pi.setActiveTools(activeProfile ? profileTools ?? [] : allToolNames());
    updateStatus(ctx);
    return true;
  }

  function profileToolResult(text: string, details: unknown = {}) {
    return { content: [{ type: "text" as const, text }], details };
  }

  pi.registerTool({
    name: "list_agent_profiles",
    label: "List Agent Profiles",
    description: "Read all available agent profiles, including their system prompts and tools.",
    promptSnippet: "Read available agent profiles",
    parameters: Type.Object({}),
    async execute() {
      const available = {
        master: {
          systemPrompt: "Pi's normal omniscient runtime prompt",
          tools: allToolNames(),
        },
        ...profiles,
      };
      return profileToolResult(JSON.stringify(available, null, 2), { profiles: available });
    },
  });

  pi.registerTool({
    name: "create_agent_profile",
    label: "Create Agent Profile",
    description: "Create a named agent profile with its own system prompt and allowed tools.",
    promptSnippet: "Create an agent profile",
    parameters: Type.Object({
      name: Type.String({ description: "Profile name; letters, numbers, _ and - only" }),
      systemPrompt: Type.String({ description: "Complete system prompt for the profile" }),
      tools: Type.Optional(Type.Array(Type.String(), { description: "Allowed pi tool names" })),
    }),
    async execute(_toolCallId, params) {
      if (!isValidName(params.name)) {
        return profileToolResult("Invalid or reserved profile name.");
      }
      if (profiles[params.name]) {
        return profileToolResult(`Profile "${params.name}" already exists.`);
      }
      if (!params.systemPrompt.trim()) {
        return profileToolResult("The system prompt cannot be empty.");
      }

      const allTools = new Set(pi.getAllTools().map((tool) => tool.name));
      const requestedTools = params.tools ?? [];
      const tools = requestedTools.filter((tool) => allTools.has(tool) && !MASTER_PROFILE_TOOLS.includes(tool));
      const unknownTools = requestedTools.filter((tool) => !allTools.has(tool));
      const restrictedTools = requestedTools.filter((tool) => MASTER_PROFILE_TOOLS.includes(tool));
      profiles[params.name] = { systemPrompt: params.systemPrompt.trim(), tools };
      saveGlobalProfiles(profiles);

      return profileToolResult(
        `Created profile "${params.name}".${unknownTools.length ? ` Ignored unknown tools: ${unknownTools.join(", ")}.` : ""}${restrictedTools.length ? ` Management tools are master-only: ${restrictedTools.join(", ")}.` : ""}`,
        { profile: profiles[params.name], unknownTools, restrictedTools },
      );
    },
  });

  pi.registerTool({
    name: "edit_agent_profile",
    label: "Edit Agent Profile",
    description: "Update an existing named agent profile's system prompt and/or allowed tools.",
    promptSnippet: "Edit an agent profile",
    parameters: Type.Object({
      name: Type.String({ description: "Existing profile name" }),
      systemPrompt: Type.Optional(Type.String({ description: "Replacement system prompt" })),
      tools: Type.Optional(Type.Array(Type.String(), { description: "Replacement allowed pi tool names" })),
    }),
    async execute(_toolCallId, params) {
      if (!isValidName(params.name)) {
        return profileToolResult("Invalid or reserved profile name.");
      }
      const profile = profiles[params.name];
      if (!profile) {
        return profileToolResult(`Profile "${params.name}" does not exist.`);
      }
      if (params.systemPrompt !== undefined && !params.systemPrompt.trim()) {
        return profileToolResult("The system prompt cannot be empty.");
      }

      const allTools = new Set(pi.getAllTools().map((tool) => tool.name));
      const requestedTools = params.tools;
      const tools = requestedTools === undefined
        ? profile.tools
        : requestedTools.filter((tool) => allTools.has(tool) && !MASTER_PROFILE_TOOLS.includes(tool));
      const unknownTools = requestedTools?.filter((tool) => !allTools.has(tool)) ?? [];
      const restrictedTools = requestedTools?.filter((tool) => MASTER_PROFILE_TOOLS.includes(tool)) ?? [];

      profiles[params.name] = {
        systemPrompt: params.systemPrompt?.trim() ?? profile.systemPrompt,
        tools,
      };
      saveGlobalProfiles(profiles);

      return profileToolResult(
        `Updated profile "${params.name}".${unknownTools.length ? ` Ignored unknown tools: ${unknownTools.join(", ")}.` : ""}${restrictedTools.length ? ` Management tools are master-only: ${restrictedTools.join(", ")}.` : ""}`,
        { profile: profiles[params.name], unknownTools, restrictedTools },
      );
    },
  });

  async function selectProfile(ctx: ExtensionContext): Promise<void> {
    if (!ctx.hasUI) {
      ctx.ui.notify(`Profiles: ${profileNames().join(", ")}`, "info");
      return;
    }
    const choice = await ctx.ui.select("Choose agent profile", profileNames());
    if (choice && apply(choice, ctx)) {
      pi.appendEntry<ProfileState>("agent-profile-state", { name: activeName });
      ctx.ui.notify(`Profile "${activeName}" activated`, "info");
    }
  }

  async function createProfile(name: string, ctx: ExtensionContext): Promise<void> {
    if (!isValidName(name)) {
      ctx.ui.notify("Profile names must use letters, numbers, _ or -; master/omniscient are reserved.", "error");
      return;
    }
    if (!ctx.hasUI) {
      ctx.ui.notify("Creating a profile requires interactive mode (use /profile create NAME).", "error");
      return;
    }

    const destination = await ctx.ui.select("Add profile to", [
      "Global (~/.pi/agent/agents.json)",
      "Project (.pi/agents.json)",
    ]);
    if (!destination) return;

    const isProject = destination.startsWith("Project");
    const path = isProject
      ? join(ctx.cwd, CONFIG_DIR_NAME, "agents.json")
      : join(getAgentDir(), "agents.json");
    const destinationProfiles = readProfiles(path);
    if (destinationProfiles[name]) {
      ctx.ui.notify(`Profile "${name}" already exists in ${isProject ? "the project" : "the global"} file`, "error");
      return;
    }

    const systemPrompt = await ctx.ui.editor(`System prompt for ${name}`, "You are a helpful agent.\n");
    if (!systemPrompt?.trim()) return;
    const defaultTools = pi.getActiveTools().join(",");
    const toolText = await ctx.ui.input("Tools (comma-separated; empty means no tools)", defaultTools);
    if (toolText === undefined) return;

    const allTools = new Set(pi.getAllTools().map((tool) => tool.name));
    const requested = toolText.split(",").map((tool) => tool.trim()).filter(Boolean);
    const unknown = requested.filter((tool) => !allTools.has(tool));
    if (unknown.length) ctx.ui.notify(`Ignoring unknown tools: ${unknown.join(", ")}`, "warning");

    destinationProfiles[name] = {
      systemPrompt: systemPrompt.trim(),
      tools: requested.filter((tool) => allTools.has(tool)),
    };
    saveProfiles(path, destinationProfiles);
    profiles = loadProfiles(ctx.cwd);
    updateStatus(ctx);
    ctx.ui.notify(`Created profile "${name}" in ${path}`, "info");
  }

  pi.registerCommand("profile", {
    description: "Create, list, or switch agent profiles",
    getArgumentCompletions: (prefix) =>
      profileNames().filter((name) => name.startsWith(prefix)).map((name) => ({ value: name, label: name })),
    handler: async (args, ctx) => {
      const parts = args?.trim().split(/\s+/).filter(Boolean) ?? [];
      if (!parts.length) return selectProfile(ctx);
      if (parts[0] === "list") {
        ctx.ui.notify(profileNames().map((name) => `${name}${name === activeName ? " (active)" : ""}`).join(", "), "info");
        return;
      }
      if (parts[0] === "create") {
        if (!parts[1]) {
          ctx.ui.notify("Usage: /profile create NAME", "error");
          return;
        }
        return createProfile(parts[1], ctx);
      }
      if (!apply(parts[0], ctx)) {
        ctx.ui.notify(`Unknown profile "${parts[0]}". Available: ${profileNames().join(", ")}`, "error");
        return;
      }
      pi.appendEntry<ProfileState>("agent-profile-state", { name: activeName });
      ctx.ui.notify(`Profile "${activeName}" activated`, "info");
    },
  });

  // This is intentionally a replacement, not an append: non-master profiles
  // must not inherit pi's runtime/system instructions or discovered context.
  pi.on("before_agent_start", async (event) => {
    if (activeProfile) return { systemPrompt: activeProfile.systemPrompt };
  });

  pi.on("session_start", async (event, ctx) => {
    profiles = loadProfiles(ctx.cwd);
    // Do not derive master access from the current active list: that list may
    // not yet include tools registered by another extension during startup.
    // Master must expose every registered tool.

    const requested = pi.getFlag("profile");
    const saved = lastState(ctx)?.name;
    const name = typeof requested === "string" && requested ? requested : saved ?? MASTER;
    if (!apply(name, ctx)) {
      activeName = MASTER;
      activeProfile = undefined;
      pi.setActiveTools(allToolNames());
      ctx.ui.notify(`Profile "${name}" no longer exists; using master`, "warning");
    }
    updateStatus(ctx);

    // A new session has no saved profile state, so ask explicitly instead of
    // silently falling back to master when the user runs /new.
    if (event.reason === "new") await selectProfile(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    const state = lastState(ctx);
    if (state && !apply(state.name, ctx)) apply(MASTER, ctx);
  });
}
