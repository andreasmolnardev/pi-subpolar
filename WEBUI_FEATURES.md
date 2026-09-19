# WebUI Feature Disposition

WebUI uses the embedded Pi SDK for execution and session authority, with a Bun bridge providing the application boundary. PocketBase is the identity and application-policy store; browser state remains presentation state. The bridge does not yet carry over the sibling repository's repository, file-service, automation, or integration adapters.

## Core WebUI

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
| Central tool registry and policy checks | Keep | `/api/pi/tools/authorize`; `/api/subpolar-cli/tools/*` |
| Tool approvals and audit records | Keep | `tool_approvals`; `tool_call_audit` |

## Subpolar SDK integrations

| Source feature | Decision | SDK/application surface |
| --- | --- | --- |
| Virtual project roots | SDK integration | `@webui/subpolar/extensions/projects.ts`; `/api/extensions/projects` |
| Agent profiles and tool allowlists | SDK integration | `@webui/subpolar/extensions/agent-profiles.ts`; `/api/extensions/profiles` |
| Registered-tool browser | SDK integration | `@webui/subpolar/extensions/list-tools.ts`; `/api/extensions/tools` |
| Session title generation | SDK integration | `@webui/subpolar/extensions/session-title.ts`; `/api/extensions/session-title` |
| Cross-session history search | SDK integration | `@webui/subpolar/extensions/session-history-search.ts`; `/api/extensions/session-search` |
| OpenAPI-generated tools | SDK integration | `@webui/subpolar/extensions/openapi-tools.ts`; `/api/extensions/openapi-tools` |

## Still Left Out

| Source feature | Reason |
| --- | --- |
| Sibling repository's full server-side domain schema and repository persistence | Pi still owns conversation/session files; PocketBase currently stores identity, preferences, agents, and tool policy data |
| Repository cloning, discovery, worktrees, and source-control panel | Requires a repository service; Pi tools can operate on a selected local project |
| File browser CRUD, uploads, ZIP archives, and virtualized preview | Requires a file service; use Pi `read`, `write`, `edit`, `find`, `grep`, and `ls` through RPC |
| Automations, schedules, run history, and productivity workspace | Requires a durable scheduler and database, neither supplied by Pi RPC |
| MCP server management UI | Adapter and browser CRUD work remains; tool routing currently supports internal/HTTP records |
| Provider API-key and OAuth management | Credentials remain in Pi auth storage and must not pass through browser endpoints |
| External TTS/STT | Not part of Pi RPC; can be added as separate browser integrations later |
| Push notifications and service-worker install flow | No server event broker selected |
| SSH host-key and remote-repository management | No matching Pi RPC primitive |

## Bridge Rules

- Browser talks only to local WebUI bridge HTTP/WebSocket endpoints.
- Bridge translates requests to SDK session operations and forwards typed events without exposing a process or stdin/stdout.
- Every Subpolar integration gets a typed bridge endpoint; slash commands are dispatched by the in-process SDK.
- Bridge binds to loopback by default and requires an origin check.
- PocketBase superuser credentials stay server-side; bridge responses never expose them.
- Pi provider credentials remain in Pi auth/config storage unless an explicit server-side provider adapter is added.
