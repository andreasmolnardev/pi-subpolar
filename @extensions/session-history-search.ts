/** Search saved session titles and message history, then resume a matching session. */
import { basename } from "node:path";
import { SessionManager, type ExtensionAPI, type SessionInfo } from "@earendil-works/pi-coding-agent";

function snippet(session: SessionInfo, query: string): string {
  const text = session.allMessagesText;
  const index = text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
  if (index < 0) return session.name ?? session.firstMessage;

  const start = Math.max(0, index - 45);
  const end = Math.min(text.length, index + query.length + 75);
  return `${start > 0 ? "…" : ""}${text.slice(start, end).replace(/\s+/g, " ")}${end < text.length ? "…" : ""}`;
}

function sessionLabel(session: SessionInfo, query: string): string {
  const title = session.name ?? session.firstMessage.replace(/\s+/g, " ").slice(0, 70);
  const project = session.cwd ? basename(session.cwd) : "unknown project";
  const date = session.modified.toLocaleDateString();
  return `${title || "Unnamed session"} · ${project} · ${date}\n  ${snippet(session, query)}`;
}

export default function sessionHistorySearchExtension(pi: ExtensionAPI) {
  pi.registerCommand("search", {
    description: "Search session message history and switch to a matching session",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/search requires interactive mode", "error");
        return;
      }

      const query = (args?.trim() || await ctx.ui.input("Search session history")).trim();
      if (!query) return;

      const sessions = await SessionManager.listAll();
      const foldedQuery = query.toLocaleLowerCase();
      const matches = sessions
        .filter((session) => {
          const title = session.name ?? "";
          return `${title}\n${session.allMessagesText}`.toLocaleLowerCase().includes(foldedQuery);
        })
        .sort((a, b) => b.modified.getTime() - a.modified.getTime());

      if (!matches.length) {
        ctx.ui.notify(`No sessions matched “${query}”`, "info");
        return;
      }

      const choices = matches.map((session) => ({
        label: sessionLabel(session, query),
        path: session.path,
      }));
      const selected = await ctx.ui.select(`Sessions matching “${query}”`, choices.map((choice) => choice.label));
      const choice = choices.find((item) => item.label === selected);
      if (choice) await ctx.switchSession(choice.path);
    },
  });
}
