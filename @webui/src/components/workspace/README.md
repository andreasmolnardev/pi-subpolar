# Session workspace frontend

`SessionDetail` renders the launcher immediately above `ChatInputBar`:

```tsx
import { SessionWorkspaceChanges } from '@/components/workspace'

// Render immediately above ChatInputBar, inside the app QueryClientProvider.
<SessionWorkspaceChanges sessionId={sessionId} />
```

The only prop is `sessionId: string`. The component handles fetching, the launcher,
and a portal-rendered, nonmodal right-hand panel. No parent callbacks or layout
changes are required. The panel is full-width on small screens and bounded on desktop;
Escape inside the panel or its close button closes it and restores launcher focus.
Tabs support arrow keys, Home, and End. The Browser tab is currently a GitHub/Gitee provider context view: it can browse bounded, read-only repository branches, issues/comments, pull requests/discussion comments, and checks through an explicitly mapped repository and connected owner account. It can add issue text to the current composer or start an `ask`-permission session from an issue. It does not provide interactive website browsing; the server-side browser and persistent website profiles remain future work.

Workspace polling uses `useSessionStatusForSession`: every 4 seconds while busy,
compacting, or retrying; every 10 seconds while the panel is open and idle. Status
transitions and mutations trigger refreshes. Failed requests have no automatic
retry loop; errors are bounded to 400 characters, with manual query retries.

Git totals/diffs describe the worktree relative to HEAD, including pre-existing
changes, not changes attributed to an agent. Non-Git workspaces use the backend
baseline and have no commit controls. Staging areas store backend snapshots, not
the real Git index. Stage/Restage/Move captures current content; displayed diffs
are explicitly current-worktree diffs, not snapshot previews. Committing requires
an area with snapshots and a saved message, then a separate confirmation.

Group commits contain only the selected snapshots. Clean Git index entries for those
paths advance to the commit; pre-existing staged content and unrelated index entries
are preserved. Later worktree edits remain unstaged. Commits use repository-local
Git author configuration and plumbing operations: Git hooks and commit signing are
not run. Configure `user.name` and `user.email` locally before committing.

The backend persists groups and non-Git baselines under
`~/.subpolar/workspace-review`, or `SUBPOLAR_WORKSPACE_REVIEW_DIR`. For container
restarts, mount this location on persistent storage. Non-Git tracking begins with
its first workspace request, not historical session creation. Protected files and
symlinks are excluded; individual file/diff size is limited to 1 MiB.

Files are loaded lazily by directory. The manual text editor submits the content
originally read as `expectedContent`. A conflict preserves the draft and requires
explicit reload/discard rather than silently overwriting disk content. Tab and panel
switches preserve drafts; dirty drafts also survive component/session remounts in
memory. Close/reload of dirty files prompts before discarding, and browser unload
is guarded even after navigating away from the session. Drafts are not persisted
to browser storage and do not survive a confirmed page reload.

## Quick open

The existing global command palette opens with **Ctrl+K or Cmd+K**, including from
composer and file-editor focus. The configured `commandPalette` shortcut and its
existing direct/leader setting take precedence over the default. The launcher also
has a **Quick open** button. On `/projects/:id/sessions/:sessionId`, the palette
searches filenames in the stored session workspace/worktree; type `>` to switch to
existing actions. Outside a session it retains the original command behavior.

Search is debounced by 150 ms and uses the owned workspace search endpoint, which
excludes ignored/protected files and symlinks. Requests are cancelled on query,
mode, close, or route changes; stale responses cannot replace current results.
Loading, errors, no matches, and the 100-result limit are displayed explicitly.
Arrow keys select results, Enter opens, and Escape or backdrop click closes.
The dialog traps focus and restores it on dismissal, except file selection hands
focus to the editor after the palette closes.

`quickOpen.ts` defines the typed session-scoped CustomEvent bridge. The global
palette sends `{ sessionId, path, requestId }`; `SessionWorkspaceChanges` validates
the payload and session ID, opens its existing panel, and selects Files.
`WorkspaceFiles` accepts `openRequest: { path, requestId }`, queues requests during
saves/loads, reselects existing tabs without fetching over drafts, and permits
retries of the same filename. Selection never navigates or changes composer drafts.

Provider context is added to the composer through a typed window event; issue content is bounded and treated as untrusted prompt context. Starting an issue session creates a project session and queues the issue prompt. It does not select/create a worktree or perform provider mutations.

Tests are colocated here, including API contract checks:

```sh
bun x --no-install vitest run src/components/workspace
bun x --no-install vitest run src --maxWorkers=4
bun run --bun tsc --noEmit -p tsconfig.app.json
```
