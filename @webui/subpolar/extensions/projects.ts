/**
 * Virtual project roots for pi.
 *
 * /project changes the root used by pi's tools without changing process.cwd().
 * Projects are read from ~/.pi/agent/projects.json and .pi/projects.json;
 * the project-local file overrides global entries.
 *
 * Accepted formats:
 *   { "frontend": "/work/frontend" }
 *   { "projects": { "frontend": { "path": "/work/frontend" } } }
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  CONFIG_DIR_NAME,
  createLocalBashOperations,
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const STATE_TYPE = "projects-state";
type ProjectMap = Record<string, string>;

function readProjects(file: string, base: string): ProjectMap {
  if (!existsSync(file)) return {};
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as unknown;
    const object = value && typeof value === "object" ? value as Record<string, unknown> : {};
    const source = object.projects && typeof object.projects === "object"
      ? object.projects as Record<string, unknown>
      : object;
    const result: ProjectMap = {};
    for (const [name, entry] of Object.entries(source)) {
      const path = typeof entry === "string"
        ? entry
        : entry && typeof entry === "object" && typeof (entry as { path?: unknown }).path === "string"
          ? (entry as { path: string }).path
          : undefined;
      if (path) result[name] = resolve(base, path);
    }
    return result;
  } catch (error) {
    console.error(`Failed to read projects from ${file}:`, error);
    return {};
  }
}

function addProject(file: string, base: string, name: string, projectPath: string): void {
  let value: Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
      if (parsed && typeof parsed === "object") value = parsed as Record<string, unknown>;
    } catch {
      // Replace malformed configuration with a valid one below.
    }
  }
  const container = value.projects && typeof value.projects === "object"
    ? value.projects as Record<string, unknown>
    : value;
  container[name] = resolve(base, projectPath);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function projectsFor(cwd: string): ProjectMap {
  return {
    ...readProjects(join(homedir(), ".pi", "projects.json"), homedir()),
    ...readProjects(join(getAgentDir(), "projects.json"), homedir()),
    ...readProjects(join(cwd, CONFIG_DIR_NAME, "projects.json"), cwd),
  };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function projectContext(root: string): string {
  const files: string[] = [];
  let directory = root;
  while (true) {
    const file = join(directory, "AGENTS.md");
    if (existsSync(file)) files.unshift(file);
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  if (!files.length) return `## Virtual project\nTools are operating in: ${root}\n`;
  return `## Virtual project\nTools and file lookup are rooted at: ${root}\n\n` +
    files.map((file) => `### ${file}\n\n${readFileSync(file, "utf8")}`).join("\n\n");
}

function previousProject(ctx: ExtensionContext, projects: ProjectMap): { name?: string; path?: string } {
  let selected: { name?: string; path?: string } = {};
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "custom" || entry.customType !== STATE_TYPE) continue;
    const data = entry.data as { name?: unknown; path?: unknown } | undefined;
    if (typeof data?.name === "string" && data.name && projects[data.name]) selected = { name: data.name };
    else if (typeof data?.path === "string" && data.path) selected = { path: data.path };
    else if (data?.name === "") selected = {};
  }
  return selected;
}

export default function projectsExtension(pi: ExtensionAPI) {
  let projects: ProjectMap = {};
  let activeName: string | undefined;
  let activeRoot: string | undefined;
  let originalCwd = "";

  const names = () => Object.keys(projects).sort();
  const root = () => activeRoot ?? originalCwd;

  function showStatus(ctx: ExtensionContext) {
    const label = activeName ? `${activeName}: ${root()}` : root();
    ctx.ui.setStatus("project", ctx.ui.theme.fg("accent", `project:${label}`));
  }

  async function createNew(ctx: ExtensionContext): Promise<void> {
    if (!ctx.hasUI) {
      ctx.ui.notify("Creating a project requires interactive mode (use /project new NAME DIRECTORY).", "error");
      return;
    }
    const name = await ctx.ui.input("Project name");
    if (!name?.trim()) return;
    const projectPath = await ctx.ui.input("Directory", originalCwd);
    if (!projectPath?.trim()) return;
    const absolutePath = resolve(originalCwd, projectPath.trim());
    if (!existsSync(absolutePath) || !statSync(absolutePath).isDirectory()) {
      ctx.ui.notify(`Directory does not exist: ${absolutePath}`, "error");
      return;
    }
    const destinationChoice = await ctx.ui.select("Save project definition to", [
      "Project (.pi/projects.json)",
      "Global (~/.pi/agent/projects.json)",
    ]);
    if (!destinationChoice) return;
    const global = destinationChoice.startsWith("Global");
    const destination = global
      ? join(getAgentDir(), "projects.json")
      : join(originalCwd, CONFIG_DIR_NAME, "projects.json");
    addProject(destination, global ? homedir() : originalCwd, name.trim(), absolutePath);
    projects = projectsFor(originalCwd);
    activate(name.trim(), ctx);
  }

  async function choose(ctx: ExtensionContext) {
    if (!ctx.hasUI) {
      ctx.ui.notify(names().map((name) => `${name}${name === activeName ? " (active)" : ""}`).join(", ") || "No projects configured", "info");
      return;
    }
    const choice = await ctx.ui.select("Choose virtual project", ["(original directory)", "(create new)", ...names()]);
    if (choice === "(original directory)") return activate(undefined, ctx);
    if (choice === "(create new)") return createNew(ctx);
    if (choice) activate(choice, ctx);
  }

  function activate(name: string | undefined, ctx: ExtensionContext) {
    if (name && !projects[name]) {
      ctx.ui.notify(`Unknown project "${name}". Available: ${names().join(", ") || "none"}`, "error");
      return;
    }
    activeName = name;
    activeRoot = name ? projects[name] : undefined;
    pi.appendEntry(STATE_TYPE, name ? { name } : { name: "" });
    showStatus(ctx);
    ctx.ui.notify(name ? `Virtual project: ${name} (${root()})` : `Virtual project cleared (${root()})`, "info");
  }

  pi.registerCommand("project", {
    description: "List or switch the virtual project root used by pi tools",
    getArgumentCompletions: (prefix) => names().filter((name) => name.startsWith(prefix)).map((name) => ({ value: name, label: name })),
    handler: async (args, ctx) => {
      const value = args?.trim();
      if (!value) return choose(ctx);
      if (value === "list") {
        ctx.ui.notify(names().map((name) => `${name}${name === activeName ? " (active)" : ""}: ${projects[name]}`).join("\n") || "No projects configured", "info");
        return;
      }
      if (value === "new" || value.startsWith("new ")) {
        const parts = value.match(/^new(?:\\s+(\\S+))?(?:\\s+(.+))?$/);
        let name = parts?.[1];
        let projectPath = parts?.[2];
        if (ctx.hasUI) {
          name ??= await ctx.ui.input("Project name");
          projectPath ??= name ? await ctx.ui.input("Directory", originalCwd) : undefined;
        }
        if (!name || !projectPath) {
          ctx.ui.notify("Usage: /project new NAME DIRECTORY", "error");
          return;
        }
        const absolutePath = resolve(originalCwd, projectPath);
        if (!existsSync(absolutePath) || !statSync(absolutePath).isDirectory()) {
          ctx.ui.notify(`Directory does not exist: ${absolutePath}`, "error");
          return;
        }
        let destination = join(originalCwd, CONFIG_DIR_NAME, "projects.json");
        if (ctx.hasUI) {
          const choice = await ctx.ui.select("Save project definition to", [
            "Project (.pi/projects.json)",
            "Global (~/.pi/agent/projects.json)",
          ]);
          if (!choice) return;
          if (choice.startsWith("Global")) destination = join(getAgentDir(), "projects.json");
        }
        addProject(destination, destination.includes(getAgentDir()) ? homedir() : originalCwd, name, absolutePath);
        projects = projectsFor(originalCwd);
        activate(name, ctx);
        return;
      }
      // A direct path is convenient even when it has not been added to projects.json.
      if (value.startsWith("/") || value.startsWith(".")) {
        const path = resolve(originalCwd, value);
        if (!existsSync(path) || !statSync(path).isDirectory()) return ctx.ui.notify(`Directory does not exist: ${path}`, "error");
        activeName = undefined;
        activeRoot = path;
        pi.appendEntry(STATE_TYPE, { name: "", path });
        showStatus(ctx);
        ctx.ui.notify(`Virtual project: ${path}`, "info");
        return;
      }
      activate(value, ctx);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    originalCwd = ctx.cwd;
    projects = projectsFor(originalCwd);
    const saved = previousProject(ctx, projects);
    activeName = saved.name;
    activeRoot = saved.name ? projects[saved.name] : saved.path;
    showStatus(ctx);
  });

  pi.on("before_agent_start", async (event) => {
    if (!activeRoot) return;
    return { systemPrompt: `${event.systemPrompt}\n\n${projectContext(activeRoot)}\nDo not assume Pi's process directory changed; use the virtual project root through its tools.` };
  });

  pi.on("tool_call", (event) => {
    const target = root();
    if (!target) return;
    if (event.toolName === "bash") {
      event.input.command = `cd -- ${shellQuote(target)} &&\n${event.input.command}`;
      return;
    }
    if (["read", "write", "edit", "grep", "find", "ls"].includes(event.toolName)) {
      const input = event.input as { path?: string };
      if (!input.path) input.path = target;
      else if (!isAbsolute(input.path)) input.path = resolve(target, input.path);
    }
  });

  pi.on("user_bash", (_event) => {
    const target = root();
    if (!target) return;
    const local = createLocalBashOperations();
    return { operations: { exec: (command, _cwd, options) => local.exec(command, target, options) } };
  });
}
