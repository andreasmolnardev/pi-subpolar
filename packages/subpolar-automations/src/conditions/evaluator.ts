import type { AutomationContext } from "../types.ts";
import { validateConditionSyntax } from "../validation.ts";

const BLOCKED_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function readPath(context: AutomationContext, path: string): unknown {
  let value: unknown = context;
  for (const segment of path.split(".")) {
    if (!segment || BLOCKED_KEYS.has(segment) || value === null || typeof value !== "object" || !Object.hasOwn(value, segment)) return undefined;
    value = (value as Record<string, unknown>)[segment];
  }
  return value;
}

function parseLiteral(source: string): unknown {
  const value = source.trim();
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  if (value.startsWith('"')) return JSON.parse(value);
  if (value.startsWith("'")) return value.slice(1, -1);
  throw new TypeError("Invalid automation condition literal");
}

/** Evaluate the restricted condition grammar without eval or dynamic code. */
export function evaluateCondition(expression: string | undefined, context: AutomationContext): boolean {
  if (!expression) return true;
  validateConditionSyntax(expression);
  const match = expression.match(/^\s*((?:trigger|execution|agent|output|run)(?:\.[A-Za-z0-9_-]+){0,7})\s+(exists|==|!=|contains)(?:\s+(.+?))?\s*$/);
  if (!match) return false;
  const [, path, operator, literal] = match;
  const actual = readPath(context, path);
  if (operator === "exists") return actual !== undefined && actual !== null;
  const expected = parseLiteral(literal ?? "");
  if (operator === "==") return actual === expected;
  if (operator === "!=") return actual !== expected;
  if (typeof actual === "string" && typeof expected === "string") return actual.includes(expected);
  if (Array.isArray(actual)) return actual.some((item) => item === expected);
  return false;
}
