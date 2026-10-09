import type { AutomationContext, JsonValue } from "../types.ts";

export const MAX_RENDERED_TEMPLATE_LENGTH = 64_000;
export const MAX_AUTOMATION_JSON_BYTES = 256_000;
const BLOCKED_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function lookup(context: AutomationContext, path: string): unknown {
  const parts = path.trim().split(".");
  if (parts.length < 2 || parts.length > 8 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part) || BLOCKED_KEYS.has(part))) {
    throw new TypeError("Invalid automation template path");
  }
  let value: unknown = context;
  for (const part of parts) {
    if (value === null || typeof value !== "object" || !Object.hasOwn(value, part)) return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

function stringify(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || value === null) return String(value);
  return JSON.stringify(value);
}

/** Replaces simple {{ dotted.path }} references. No loops, filters, property calls, or code execution. */
export function renderTemplate(template: string, context: AutomationContext, maxLength = MAX_RENDERED_TEMPLATE_LENGTH): string {
  if (typeof template !== "string" || template.length > maxLength) throw new TypeError("Automation template exceeds the configured limit");
  const rendered = template.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_match, path: string) => stringify(lookup(context, path)));
  if (rendered.length > maxLength) throw new TypeError("Rendered automation template exceeds the configured limit");
  if (/\{\{|\}\}/.test(rendered)) throw new TypeError("Invalid automation template expression");
  return rendered;
}

export function asJsonValue(value: unknown): JsonValue {
  let nodes = 0;
  const convert = (item: unknown, depth: number): JsonValue => {
    nodes += 1;
    if (nodes > 20_000 || depth > 24) throw new TypeError("Automation JSON value exceeds the configured limits");
    if (item === null || typeof item === "string" || typeof item === "boolean") return item;
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (Array.isArray(item)) return item.map((child) => convert(child, depth + 1));
    if (typeof item === "object") {
      const record: Record<string, JsonValue> = {};
      for (const [key, child] of Object.entries(item)) {
        if (!BLOCKED_KEYS.has(key)) record[key] = convert(child, depth + 1);
      }
      return record;
    }
    return String(item);
  };
  const converted = convert(value, 0);
  if (JSON.stringify(converted).length > MAX_AUTOMATION_JSON_BYTES) throw new TypeError("Automation JSON value exceeds the configured size limit");
  return converted;
}
