/**
 * Show every registered tool, dimming tools unavailable to the active profile.
 *
 * Use /list-tools to open the list.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

const MAX_VISIBLE = 18;

export default function listToolsExtension(pi: ExtensionAPI) {
  pi.registerCommand("list-tools", {
    description: "List tools available to the active profile",
    handler: async (_args, ctx) => {
      const allTools = [...pi.getAllTools()].sort((a, b) => a.name.localeCompare(b.name));
      const activeTools = new Set(pi.getActiveTools());

      if (ctx.mode !== "tui") {
        const available = allTools.filter((tool) => activeTools.has(tool.name)).map((tool) => tool.name);
        const unavailable = allTools.filter((tool) => !activeTools.has(tool.name)).map((tool) => tool.name);
        ctx.ui.notify(
          `Available: ${available.join(", ") || "none"}\nUnavailable: ${unavailable.join(", ") || "none"}`,
          "info",
        );
        return;
      }

      await ctx.ui.custom((tui, theme, _keybindings, done) => {
        let offset = 0;

        const border = new DynamicBorder((s: string) => theme.fg("accent", s));
        const component = {
          render(width: number): string[] {
            const lines: string[] = [
              theme.fg("accent", theme.bold("Tools for active profile")),
              theme.fg("dim", "● available   ○ unavailable"),
              "",
            ];
            const visible = allTools.slice(offset, offset + MAX_VISIBLE);
            for (const tool of visible) {
              const available = activeTools.has(tool.name);
              const line = `${available ? "●" : "○"} ${tool.name}`;
              lines.push(theme.fg(available ? "text" : "dim", truncateToWidth(line, width)));
            }
            if (allTools.length > MAX_VISIBLE) {
              lines.push("");
              lines.push(theme.fg("dim", `${offset + 1}-${Math.min(offset + MAX_VISIBLE, allTools.length)} of ${allTools.length}  ↑↓ scroll • esc close`));
            } else {
              lines.push("");
              lines.push(theme.fg("dim", "esc close"));
            }
            return lines.map((line) => truncateToWidth(line, width));
          },
          invalidate() {},
          handleInput(data: string) {
            if (matchesKey(data, Key.escape)) {
              done(undefined);
            } else if (matchesKey(data, Key.up)) {
              offset = Math.max(0, offset - 1);
              tui.requestRender();
            } else if (matchesKey(data, Key.down)) {
              offset = Math.min(Math.max(0, allTools.length - MAX_VISIBLE), offset + 1);
              tui.requestRender();
            } else if (matchesKey(data, Key.home)) {
              offset = 0;
              tui.requestRender();
            } else if (matchesKey(data, Key.end)) {
              offset = Math.max(0, allTools.length - MAX_VISIBLE);
              tui.requestRender();
            }
          },
        };

        return {
          render(width: number) {
            return [...border.render(width), ...component.render(width), ...border.render(width)];
          },
          invalidate() {
            border.invalidate();
            component.invalidate();
          },
          handleInput: component.handleInput,
        };
      });
    },
  });
}
