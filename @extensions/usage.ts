/** Show token usage across persisted Pi sessions. */
import { readFileSync } from "node:fs";
import {
  parseSessionEntries,
  SessionManager,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

const WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
type Totals = { input: number; output: number; cacheRead: number; cacheWrite: number };
function emptyTotals(): Totals { return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }; }
function addUsage(total: Totals, usage: Partial<Totals> | undefined): void {
  if (!usage) return;
  for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
    const value = usage[key];
    if (typeof value === "number" && Number.isFinite(value)) total[key] += value;
  }
}
function tokens(usage: Totals): number { return usage.input + usage.output + usage.cacheRead + usage.cacheWrite; }
function formatTokens(value: number): string { return Math.round(value).toLocaleString(); }
function formatUsage(usage: Totals): string {
  return `in ${formatTokens(usage.input)}  out ${formatTokens(usage.output)}  cache-read ${formatTokens(usage.cacheRead)}  cache-write ${formatTokens(usage.cacheWrite)}`;
}

export default function usageExtension(pi: ExtensionAPI) {
  pi.registerCommand("usage", {
    description: "Show token usage by model and session for the last 30 days",
    handler: async (_args, ctx) => {
      const since = Date.now() - WINDOW_MS;
      const totalsByModel = new Map<string, Totals>();
      const sessionTotals: { name: string; total: Totals }[] = [];
      const countedEntries = new Set<string>();
      let sessionCount = 0;
      try {
        const sessions = await SessionManager.listAll(ctx.sessionManager.getSessionDir());
        for (const session of sessions) {
          sessionCount++;
          const total = emptyTotals();
          const entries = parseSessionEntries(readFileSync(session.path, "utf8"));
          for (const entry of entries) {
            if (entry.type !== "message" || entry.message.role !== "assistant") continue;
            if (countedEntries.has(entry.id)) continue;
            countedEntries.add(entry.id);
            const timestamp = Date.parse(entry.timestamp);
            if (!Number.isFinite(timestamp) || timestamp < since) continue;
            addUsage(total, entry.message.usage);
            const model = `${entry.message.provider}/${entry.message.model}`;
            const modelTotal = totalsByModel.get(model) ?? emptyTotals();
            addUsage(modelTotal, entry.message.usage);
            totalsByModel.set(model, modelTotal);
          }
          if (tokens(total) > 0) sessionTotals.push({ name: session.name ?? (session.firstMessage.slice(0, 70) || "Unnamed session"), total });
        }
      } catch (error) {
        ctx.ui.notify(`Unable to read Pi sessions: ${error instanceof Error ? error.message : String(error)}`, "error");
        return;
      }
      const grandTotal = emptyTotals();
      for (const value of totalsByModel.values()) addUsage(grandTotal, value);
      const topSessions = sessionTotals.sort((a, b) => tokens(b.total) - tokens(a.total)).slice(0, 10);
      const lines = topSessions.length
        ? ["Top sessions by tokens", ...topSessions.map((s) => `${s.name}\n  ${formatUsage(s.total)}`), ""]
        : [];
      lines.push(`Total\n  ${formatUsage(grandTotal)}`);
      lines.push(`\nScanned ${sessionCount} session${sessionCount === 1 ? "" : "s"} (last 30 days).`);
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
