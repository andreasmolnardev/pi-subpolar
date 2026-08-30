# WebUI Feature Disposition

WebUI targets one local Pi installation. Pi RPC is execution and session authority; browser state is presentation state. No Subpolar backend, PocketBase, SDK runtime, or OpenCode compatibility API is carried over.

## Core WebUI

| Source feature | Decision | RPC surface |
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

## Pi Extensions

| Source feature | Decision | Extension/RPC surface |
| --- | --- | --- |
| Virtual project roots | Extension | Existing `projects.ts`; `/api/extensions/projects` |
| Agent profiles and tool allowlists | Extension | Existing `agent-profiles.ts`; `/api/extensions/profiles` |
| Registered-tool browser | Extension | Existing `list-tools.ts`; `/api/extensions/tools` |
| Session title generation | Extension | Existing `session-title.ts`; `/api/extensions/session-title` |
| Cross-session history search | Extension | Existing `session-history-search.ts`; `/api/extensions/session-search` |
| OpenAPI-generated tools | Extension | Existing `openapi-tools.ts`; `/api/extensions/openapi-tools` |

## Left Out

| Source feature | Reason |
| --- | --- |
| Login, registration, setup, and multi-user auth | Local Pi process has no Subpolar account boundary |
| PocketBase persistence and Subpolar database schema | Pi owns session files and local configuration |
| Repository cloning, discovery, worktrees, and source-control panel | Requires a repository service; Pi tools can operate on a selected local project |
| File browser CRUD, uploads, ZIP archives, and virtualized preview | Requires a file service; use Pi `read`, `write`, `edit`, `find`, `grep`, and `ls` through RPC |
| Automations, schedules, run history, and productivity workspace | Requires a durable scheduler and database, neither supplied by Pi RPC |
| MCP server management UI | Pi configuration/extension scope; no safe browser CRUD contract selected yet |
| Provider API-key and OAuth management | Credentials remain in Pi auth storage and must not pass through browser endpoints |
| External TTS/STT | Not part of Pi RPC; can be added as separate browser integrations later |
| Push notifications and service-worker install flow | No server event broker selected |
| SSH host-key and remote-repository management | No matching Pi RPC primitive |

## Bridge Rules

- Browser talks only to local WebUI bridge HTTP/WebSocket endpoints.
- Bridge translates requests to Pi RPC commands and forwards RPC events without exposing stdin/stdout directly.
- Every extension surface gets a typed bridge endpoint, even when implementation invokes a Pi slash command internally.
- Bridge binds to loopback by default and requires an origin check.
- Secrets stay in Pi auth/config storage; bridge responses redact them.
