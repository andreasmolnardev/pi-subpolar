import type { ActionDefinition, AutomationInput, AutomationUpdate, TriggerDefinition } from "./types.ts";

export const AUTOMATION_LIMITS = {
  name: 200,
  description: 4000,
  promptTemplate: 32_000,
  template: 16_000,
  actions: 20,
  identifier: 160,
} as const;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown, field: string, max: number, required = false): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || (required && !value.trim()) || value.length > max) {
    throw new TypeError(`Invalid automation ${field}`);
  }
  return value;
}

function identifier(value: unknown, field: string): string {
  const result = text(value, field, AUTOMATION_LIMITS.identifier, true)!;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(result)) throw new TypeError(`Invalid automation ${field}`);
  return result;
}

export function validateTriggerDefinition(value: unknown): TriggerDefinition {
  if (!object(value) || typeof value.type !== "string") throw new TypeError("Invalid automation trigger");
  switch (value.type) {
    case "manual":
      return { type: "manual" };
    case "schedule": {
      const cron = text(value.cron, "schedule cron", 200, true)!;
      const timezone = text(value.timezone, "schedule timezone", 128, true)!;
      if (!/^[0-9*,/ -]+$/.test(cron) || cron.trim().split(/\s+/).length !== 5) throw new TypeError("Invalid automation schedule cron");
      // Full IANA timezone validation belongs to the host's timezone implementation.
      if (!/^[A-Za-z_+-]+(?:\/[A-Za-z0-9_+.-]+)*$/.test(timezone)) throw new TypeError("Invalid automation schedule timezone");
      return { type: "schedule", cron, timezone };
    }
    case "webhook":
      return { type: "webhook", credentialRef: identifier(value.credentialRef, "webhook credential reference") };
    case "event": {
      const eventType = identifier(value.eventType, "event type");
      const where = text(value.where, "event filter", 1000);
      if (where !== undefined) validateConditionSyntax(where);
      return { type: "event", eventType, ...(where === undefined ? {} : { where }) };
    }
    default:
      throw new TypeError("Unsupported automation trigger type");
  }
}

export function validateActionDefinition(value: unknown): ActionDefinition {
  if (!object(value) || typeof value.type !== "string") throw new TypeError("Invalid automation action");
  const id = identifier(value.id, "action id");
  const when = text(value.when, "action condition", 1000);
  if (when !== undefined) validateConditionSyntax(when);
  switch (value.type) {
    case "store":
      return { id, type: "store", ...(when ? { when } : {}) };
    case "notification":
      return {
        id,
        type: "notification",
        titleTemplate: text(value.titleTemplate, "notification title template", AUTOMATION_LIMITS.template, true)!,
        bodyTemplate: text(value.bodyTemplate, "notification body template", AUTOMATION_LIMITS.template, true)!,
        ...(when ? { when } : {}),
      };
    case "webhook": {
      const url = text(value.url, "webhook URL", 2048, true)!;
      let parsed: URL;
      try { parsed = new URL(url); } catch { throw new TypeError("Invalid automation webhook URL"); }
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new TypeError("Automation webhook URL must use HTTP(S)");
      const credentialRef = value.credentialRef === undefined ? undefined : identifier(value.credentialRef, "webhook credential reference");
      const method = value.method === undefined ? undefined : value.method;
      if (method !== undefined && method !== "POST" && method !== "PUT") throw new TypeError("Invalid automation webhook method");
      const bodyTemplate = text(value.bodyTemplate, "webhook body template", AUTOMATION_LIMITS.template);
      return { id, type: "webhook", url, ...(method ? { method } : {}), ...(credentialRef ? { credentialRef } : {}), ...(bodyTemplate === undefined ? {} : { bodyTemplate }), ...(when ? { when } : {}) };
    }
    case "tool":
      return {
        id,
        type: "tool",
        toolId: identifier(value.toolId, "tool id"),
        inputTemplate: text(value.inputTemplate, "tool input template", AUTOMATION_LIMITS.template, true)!,
        ...(when ? { when } : {}),
      };
    default:
      throw new TypeError("Unsupported automation action type");
  }
}

export function validateAutomationInput(value: unknown): AutomationInput {
  if (!object(value)) throw new TypeError("Invalid automation input");
  const name = text(value.name, "name", AUTOMATION_LIMITS.name, true)!;
  const description = text(value.description, "description", AUTOMATION_LIMITS.description);
  const agentId = identifier(value.agentId, "agent id");
  const projectId = value.projectId === undefined ? undefined : identifier(value.projectId, "project id");
  const promptTemplate = text(value.promptTemplate, "prompt template", AUTOMATION_LIMITS.promptTemplate, true)!;
  const executionConfig = validateExecutionConfig(value.executionConfig);
  if (!promptTemplate.trim()) throw new TypeError("Automation prompt template cannot be empty");
  const trigger = validateTriggerDefinition(value.trigger);
  const actionsValue = value.actions ?? [];
  if (!Array.isArray(actionsValue) || actionsValue.length > AUTOMATION_LIMITS.actions) throw new TypeError("Invalid automation actions");
  const actions = actionsValue.map(validateActionDefinition);
  if (new Set(actions.map((action) => action.id)).size !== actions.length) throw new TypeError("Automation action ids must be unique");
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") throw new TypeError("Invalid automation enabled state");
  return { name, ...(description === undefined ? {} : { description }), enabled: value.enabled ?? true, agentId, ...(projectId ? { projectId } : {}), promptTemplate, ...(executionConfig ? { executionConfig } : {}), trigger, actions };
}

export function validateAutomationUpdate(value: unknown): AutomationUpdate {
  if (!object(value) || Object.keys(value).length === 0) throw new TypeError("Invalid automation update");
  const result: AutomationUpdate = {};
  if ("name" in value) result.name = text(value.name, "name", AUTOMATION_LIMITS.name, true)!;
  if ("description" in value) result.description = text(value.description, "description", AUTOMATION_LIMITS.description);
  if ("enabled" in value) {
    if (typeof value.enabled !== "boolean") throw new TypeError("Invalid automation enabled state");
    result.enabled = value.enabled;
  }
  if ("agentId" in value) result.agentId = identifier(value.agentId, "agent id");
  if ("projectId" in value) result.projectId = value.projectId === undefined ? undefined : identifier(value.projectId, "project id");
  if ("promptTemplate" in value) result.promptTemplate = text(value.promptTemplate, "prompt template", AUTOMATION_LIMITS.promptTemplate, true)!;
  if ("executionConfig" in value) result.executionConfig = validateExecutionConfig(value.executionConfig);
  if ("trigger" in value) result.trigger = validateTriggerDefinition(value.trigger);
  if ("actions" in value) {
    if (!Array.isArray(value.actions) || value.actions.length > AUTOMATION_LIMITS.actions) throw new TypeError("Invalid automation actions");
    result.actions = value.actions.map(validateActionDefinition);
    if (new Set(result.actions.map((action) => action.id)).size !== result.actions.length) throw new TypeError("Automation action ids must be unique");
  }
  return result;
}

function validateExecutionConfig(value: unknown): AutomationInput["executionConfig"] {
  if (value === undefined) return undefined;
  if (!object(value) || Object.keys(value).some((key) => key !== "timeoutMs")) throw new TypeError("Invalid automation execution configuration");
  if (value.timeoutMs !== undefined && (!Number.isInteger(value.timeoutMs) || (value.timeoutMs as number) < 1000 || (value.timeoutMs as number) > 3_600_000)) {
    throw new TypeError("Invalid automation execution timeout");
  }
  return value.timeoutMs === undefined ? {} : { timeoutMs: value.timeoutMs as number };
}

/** Grammar is deliberately conservative; the evaluator supports no calls, operators, or executable code. */
export function validateConditionSyntax(expression: string): void {
  const path = String.raw`(?:trigger|execution|agent|output|run)(?:\.[A-Za-z0-9_-]+){0,7}`;
  const literal = String.raw`(?:"(?:[^"\\]|\\.)*"|'[^']*'|-?\d+(?:\.\d+)?|true|false|null)`;
  if (!new RegExp(`^\\s*${path}\\s+(?:exists|==\\s+${literal}|!=\\s+${literal}|contains\\s+${literal})\\s*$`).test(expression)) {
    throw new TypeError("Invalid automation condition expression");
  }
}
