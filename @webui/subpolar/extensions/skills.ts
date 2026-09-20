/**
 * Markdown skills for pi.
 *
 * Skills are discovered from:
 *   <project>/.subpolar/skills
 *   ~/.config/subpolar/skills
 *   ~/.pi/skills
 *
 * A skill can be a SKILL.md file or a directory containing SKILL.md. The
 * optional front matter controls how it is exposed to the agent:
 *
 *   ---
 *   load: metadata       # name-only (default), metadata, or agent-skill
 *   profiles:            # profiles for which agent-skill is included
 *     - reviewer
 *   ---
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SkillContextMode, SkillRepository } from "../../../packages/subpolar-contracts/src/index.ts";


type LoadMode = "name-only" | "metadata" | "agent-skill";

type Skill = {
  name: string;
  description: string;
  body: string;
  load: LoadMode;
  profiles: string[];
  path: string;
};

export type DurableSkillContextOptions = {
  repository: SkillRepository;
  ownerId: string;
  agentId: string;
  projectId?: string;
  skillContextModes?: Record<string, SkillContextMode>;
  audit?: (event: { action: "discovery" | "load"; ownerId: string; agentId: string; projectId?: string; skillId: string; mode: SkillContextMode }) => Promise<void> | void;
};

type FrontMatter = {
  load?: string;
  profiles: string[];
};

function skillDirectories(cwd: string): string[] {
  return [
    join(cwd, ".subpolar", "skills"),
    join(homedir(), ".config", "subpolar", "skills"),
    join(homedir(), ".pi", "skills"),
  ];
}

function parseScalar(value: string): string {
  return value.trim().replace(/^['"]|['"]$/g, "");
}

function parseFrontMatter(content: string): { frontMatter: FrontMatter; body: string } {
  const match = content.match(/^\uFEFF?---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?([\s\S]*)$/);
  if (!match) return { frontMatter: { profiles: [] }, body: content };

  const frontMatter: FrontMatter = { profiles: [] };
  let readingProfiles = false;
  for (const line of match[1].split(/\r?\n/)) {
    const property = line.match(/^\s*([A-Za-z][\w-]*)\s*:\s*(.*?)\s*$/);
    const item = line.match(/^\s*-\s*(.+?)\s*$/);
    if (item && readingProfiles) {
      frontMatter.profiles.push(parseScalar(item[1]));
      continue;
    }
    if (!property) {
      readingProfiles = false;
      continue;
    }
    const [, key, rawValue] = property;
    if (key === "profiles") {
      readingProfiles = true;
      if (rawValue) {
        const inline = rawValue.replace(/^\[|\]$/g, "");
        frontMatter.profiles.push(...inline.split(",").map(parseScalar).filter(Boolean));
      }
    } else if (key === "load") {
      frontMatter.load = parseScalar(rawValue);
      readingProfiles = false;
    } else {
      readingProfiles = false;
    }
  }

  return { frontMatter, body: match[2].trim() };
}

function descriptionFrom(body: string, name: string): string {
  const explicit = body.match(/^(?:description|summary):\s*(.+)$/im)?.[1]?.trim();
  if (explicit) return explicit;
  return body.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? name;
}

function normalizeLoad(value: string | undefined): LoadMode {
  if (value === "metadata" || value === "agent-skill") return value;
  return "name-only";
}

function readSkills(cwd: string): Skill[] {
  const skills: Skill[] = [];
  const seen = new Set<string>();
  for (const directory of skillDirectories(cwd)) {
    if (!existsSync(directory)) continue;
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const file = entry.isDirectory()
        ? join(directory, entry.name, "SKILL.md")
        : entry.name === "SKILL.md" ? join(directory, entry.name) : undefined;
      if (!file || !existsSync(file)) continue;
      const name = entry.isDirectory() ? entry.name : directory.split("/").pop() ?? "skill";
      if (seen.has(name)) continue;
      seen.add(name);
      try {
        const parsed = parseFrontMatter(readFileSync(file, "utf8"));
        skills.push({
          name,
          description: descriptionFrom(parsed.body, name),
          body: parsed.body,
          load: normalizeLoad(parsed.frontMatter.load),
          profiles: parsed.frontMatter.profiles,
          path: file,
        });
      } catch (error) {
        console.error(`Failed to read skill ${file}:`, error);
      }
    }
  }
  return skills;
}

function activeProfile(ctx: ExtensionContext): string {
  let profile = "master";
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "custom" || entry.customType !== "agent-profile-state") continue;
    const name = (entry.data as { name?: unknown } | undefined)?.name;
    if (typeof name === "string" && name) profile = name;
  }
  return profile;
}

function skillContext(skills: Skill[], profile: string): string {
  const index = skills
    .filter((skill) => skill.load === "name-only" || skill.load === "metadata")
    .map((skill) => skill.load === "metadata"
      ? `- ${skill.name}: ${skill.description}`
      : `- ${skill.name}`)
    .join("\n");
  const selected = skills
    .filter((skill) => skill.load === "agent-skill" && (skill.profiles.includes("*") || skill.profiles.includes(profile)))
    .map((skill) => `### ${skill.name}\n\n${skill.body}`)
    .join("\n\n");

  const sections: string[] = [];
  if (index) sections.push(`## Available skills\n${index}`);
  if (selected) sections.push(`## Profile skills\n${selected}`);
  return sections.join("\n\n");
}

const modeRank: Record<SkillContextMode, number> = { disabled: 0, "explicit-only": 1, discoverable: 2, "always-loaded": 3 };

function durableMode(repositoryMode: SkillContextMode, configuredMode: SkillContextMode | undefined): SkillContextMode {
  if (!configuredMode) return repositoryMode;
  return modeRank[configuredMode] < modeRank[repositoryMode] ? configuredMode : repositoryMode;
}

export async function durableSkillContext(
  options: DurableSkillContextOptions,
  explicitSkillIds: readonly string[] = [],
): Promise<string> {
  const explicit = new Set(explicitSkillIds);
  const skills = await options.repository.resolve(options.ownerId, {
    agentId: options.agentId,
    ...(options.projectId ? { projectId: options.projectId } : {}),
    explicitSkillIds,
  });
  const sections: string[] = [];
  const metadata: string[] = [];
  for (const skill of skills) {
    const mode = durableMode(skill.exposure, options.skillContextModes?.[skill.id]);
    if (mode === "disabled" || (mode === "explicit-only" && !explicit.has(skill.id))) continue;
    const event = { action: mode === "always-loaded" || explicit.has(skill.id) ? "load" as const : "discovery" as const, ownerId: options.ownerId, agentId: options.agentId, ...(options.projectId ? { projectId: options.projectId } : {}), skillId: skill.id, mode };
    await options.audit?.(event);
    if (mode === "always-loaded" || explicit.has(skill.id)) sections.push(`### ${skill.name}\n\n${skill.body}`);
    else metadata.push(`- ${skill.name}: ${skill.metadata.description ?? skill.name}`);
  }
  if (metadata.length) sections.unshift(`## Available skills\n${metadata.join("\n")}`);
  if (sections.length && sections[0]?.startsWith("### ")) sections.unshift("## Loaded skills");
  return sections.join("\n\n");
}

export default function skillsExtension(pi: ExtensionAPI, durable?: DurableSkillContextOptions) {
  let cwd = "";
  const explicitSkillIds = new Set<string>();

  pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
    cwd = ctx.cwd;
  });

  pi.on("before_agent_start", async (event: { systemPrompt: string }, ctx: ExtensionContext) => {
    const context = durable
      ? await durableSkillContext(durable, [...explicitSkillIds])
      : skillContext(readSkills(cwd || ctx.cwd), activeProfile(ctx));
    if (!context) return;
    return { systemPrompt: `${event.systemPrompt}\n\n${context}` };
  });

  if (durable) {
    pi.registerCommand("skill", {
      description: "Explicitly load a durable skill",
      handler: async (args) => {
        const id = args?.trim();
        if (id) explicitSkillIds.add(id);
      },
    });
  }
}
