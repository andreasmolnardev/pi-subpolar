/** Archive sessions out of /sessions and browse archived sessions. */
import { mkdir, rename } from "node:fs/promises";
import { basename, join } from "node:path";
import { SessionManager, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext, type SessionInfo } from "@earendil-works/pi-coding-agent";

const ARCHIVE_DIRECTORY = "archive";

function archiveDirectory(ctx: ExtensionContext): string {
  const sessionDir = ctx.sessionManager.getSessionDir();
  // Keep one archive beside the regular project session directory even when
  // the currently opened session came from the archive.
  return basename(sessionDir) === ARCHIVE_DIRECTORY
    ? sessionDir
    : join(sessionDir, ARCHIVE_DIRECTORY);
}

function sessionLabel(session: SessionInfo): string {
  const title = session.name ?? session.firstMessage.replace(/\s+/g, " ").slice(0, 70);
  return `${title || "Unnamed session"} · ${session.messageCount} messages · ${session.modified.toLocaleString()}`;
}

async function browseArchived(ctx: ExtensionCommandContext): Promise<void> {
  const sessions = await SessionManager.list(ctx.cwd, archiveDirectory(ctx));
  if (!sessions.length) {
    ctx.ui.notify("No archived sessions", "info");
    return;
  }

  const choices = sessions.map((session) => ({ label: sessionLabel(session), path: session.path }));
  const selected = await ctx.ui.select("Archived sessions", choices.map((choice) => choice.label));
  const choice = choices.find((item) => item.label === selected);
  if (choice) await ctx.switchSession(choice.path);
}

export default function sessionArchiveExtension(pi: ExtensionAPI) {
  pi.registerCommand("archive", {
    description: "Archive the current session and start a new one",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/archive requires interactive mode", "error");
        return;
      }

      const sessionPath = ctx.sessionManager.getSessionFile();
      if (!sessionPath) {
        ctx.ui.notify("The current session is not persisted", "warning");
        return;
      }

      const destinationDirectory = archiveDirectory(ctx);
      const destination = join(destinationDirectory, basename(sessionPath));
      try {
        await mkdir(destinationDirectory, { recursive: true });
        await rename(sessionPath, destination);
      } catch (error) {
        ctx.ui.notify(`Unable to archive session: ${error instanceof Error ? error.message : String(error)}`, "error");
        return;
      }

      const result = await ctx.newSession({ parentSession: destination });
      if (result.cancelled) {
        ctx.ui.notify("Session archived, but starting a new session was cancelled", "warning");
      }
    },
  });

  pi.registerCommand("archived", {
    description: "Browse and switch to archived sessions",
    handler: async (_args, ctx: ExtensionCommandContext) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/archived requires interactive mode", "error");
        return;
      }
      await browseArchived(ctx);
    },
  });
}
