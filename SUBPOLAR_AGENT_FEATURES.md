# Subpolar Agent Feature Disposition

Subpolar Agent uses the embedded Pi SDK for execution and session authority, with a Bun bridge providing the application boundary. PocketBase is the identity and application-policy store; browser state remains presentation state. The Subpolar Agent includes project/session workspace and Git integrations, alongside the Pi SDK and PocketBase-backed application features described below. Some broader repository and provider workflows remain limited or unimplemented.

## Core Subpolar Agent

| Source feature | Decision | SDK surface |
| --- | --- | --- |
| Chat and live assistant output | Keep | `prompt`, `steer`, `follow_up`, RPC events |
| Tool-call and tool-result transcript | Keep | `tool_execution_*` events |
| Abort and queued prompts | Keep | `abort`, `clear_queue`, `steer`, `follow_up` |
| Session transcript and resume | Keep | `get_messages`, `get_entries`, `switch_session` |
| New, fork, and clone session | Keep | `new_session`, `fork`, `clone` |
| Session naming and search | Keep | `set_session_name`; `sessions` and `search` extension commands/endpoints |
| Model picker | Keep | `get_available_models`, `set_model` |
| Thinking-level picker | Keep | `get_available_thinking_levels`, `set_thinking_level` |
| Context usage and token statistics | Keep | `get_state`, `get_session_stats`; `usage` extension endpoint |
| Slash-command discovery and execution | Keep | `get_commands`, `prompt` |
| Markdown, code, diff, and Mermaid rendering | Keep | Client-only rendering |
| Responsive/mobile layout | Keep | Client-only |
| PocketBase email authentication | Keep | `/api/auth`; `pb_auth` HttpOnly cookie |
| Authenticated application routes | Keep | Bridge auth middleware |
| PocketBase user preferences | Keep | `user_preferences` collection |
| Central tool registry and policy checks | Keep | `/api/subpolar-cli/tools/*` |
| Tool approvals and audit records | Keep | `tool_approvals`; `tool_call_audit` |
| Session workspace panel | Implemented | Files, Changes, and provider Browser views; `SessionWorkspaceChanges` |
| Workspace files and quick open | Implemented | Browse/search session files, edit text with conflict checks, and open files from quick search |
| Git changes and review | Implemented | Project Changes status/diff view; session workspace snapshot groups and confirmed commits |
| Worktree creation and context | Implemented | Create a clean linked checkout and session; inspect local repository refs and worktrees |
| GitHub/Gitea provider context | Implemented, read-only | Browse mapped repository branches, issues, pull requests, comments, and checks; add issue context or start an ask-permission session |

## Subpolar SDK integrations

| Source feature | Decision | SDK/application surface |
| --- | --- | --- |
| Virtual project roots | Application route | PocketBase project/session repository; `/api/extensions/projects` |
| Agent profiles and tool allowlists | Application route | PocketBase agent runtime and policy store; `/api/extensions/profiles` |
| Registered-tool browser | Active SDK integration | `@subpolar-agent/subpolar/extensions/list-tools.ts`; `/api/extensions/tools` |
| Session title generation | Application runtime | Subpolar Agent session runtime; `/api/extensions/session-title` |
| Cross-session history search | Application route | PocketBase session repository; `/api/extensions/session-search` |
| OpenAPI-generated tools | Active SDK integration | `@subpolar-agent/subpolar/extensions/openapi-tools.ts`; `/api/extensions/openapi-tools` |

## Remaining limits

| Capability | Current limit |
| --- | --- |
| General-purpose repository discovery and cloning | Worktrees can be created from an already linked/owned project; this is not a general remote repository discovery or clone workflow. |
| Worktree lifecycle | The UI can create a linked checkout and session and display local worktrees. Coding subagent worktrees are temporary and cleaned up after the task; general merge/cherry-pick orchestration is not provided. |
| Git mutations and remote operations | The Changes review surface displays status and diffs. Session workspace snapshot groups support controlled commits; ordinary provider browsing is read-only. Authenticated remote fetch/push and finish/merge lifecycle are not implemented. |
| Provider integration | GitHub/Gitea browsing requires an explicit repository mapping and connected owner account. Issue context can be sent to the agent, but provider mutations (such as creating PRs or comments) are not available. |
| Browser tab | This is a GitHub/Gitea repository context browser, not an interactive website browser. |
| ZIP/archive and broad file-service features | These are not part of the session workspace panel. Workspace editing/search is bounded by ownership, protected-path, symlink, and size checks. |
| MCP server management UI | Adapter and browser CRUD work remains; tool routing currently supports internal/HTTP records. |
| Provider API-key and OAuth management | Credentials remain in Pi auth storage and must not pass through browser endpoints. |
| External TTS/STT | Not part of Pi RPC; can be added as separate browser integrations later. |
| Push notifications and service-worker install flow | No server event broker selected. |
| SSH host-key and remote-repository management | No matching Pi RPC primitive. |

## Bridge Rules

- Browser talks only to local Subpolar Agent bridge HTTP/WebSocket endpoints.
- Bridge translates requests to SDK session operations and forwards typed events without exposing a process or stdin/stdout.
- Every Subpolar integration gets a typed bridge endpoint; slash commands are dispatched by the in-process SDK.
- Bridge binds to loopback by default and requires an origin check.
- PocketBase superuser credentials stay server-side; bridge responses never expose them.
- Pi provider credentials remain in Pi auth/config storage unless an explicit server-side provider adapter is added.
