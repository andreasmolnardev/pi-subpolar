# Pi WebUI

Local browser UI for the Pi SDK embedded in this repository. The bridge creates transient in-memory SDK execution contexts from PocketBase-backed session state and forwards typed events over WebSocket.

## Start

From any directory:

```sh
./start-webui.sh
```

Equivalent manual startup (using the repository's absolute path):

```sh
bun /path/to/pi-subpolar/@webui/bridge.ts
cd /path/to/pi-subpolar/@webui && npm run dev
```

Open `http://localhost:5173`.

The bridge binds to `127.0.0.1:4173`. Set `WEBUI_PORT` to change it. Vite proxies `/api` to that port.

The bridge requires a running PocketBase instance. Copy the repository `.env.example` to
`.env` and set `POCKETBASE_URL`, `POCKETBASE_EMAIL`, and `POCKETBASE_PASSWORD` to a
PocketBase superuser. The bridge creates its application collections on first startup.
If `ADMIN_EMAIL` and `ADMIN_PASSWORD` are set, that user is provisioned on startup and
public registration is disabled.

Authentication uses PocketBase user records and an `HttpOnly` `pb_auth` cookie. All
application routes require that cookie; only health and auth discovery/sign-in/sign-up
routes are public.

## SDK Boundary

The bridge imports `@earendil-works/pi-coding-agent` and creates a transient,
in-memory `AgentSession` for each run. Session metadata and transcript entries are
loaded from and written to PocketBase; no Pi CLI process or native Pi JSONL session
persistence is used.

Core routes live under `/api/sessions/:id` for prompt, state, messages, stats, abort, and arbitrary allowlisted Pi RPC commands. Streaming events use `/api/sessions/:id/events`.

Extension routes live under `/api/extensions`: `projects`, `profiles`, `tools`, `commands`, `usage`, `session-title`, `session-search`, and `openapi-tools`. The old file-backed Pi CLI extension commands are not loaded by the WebUI; use these application routes instead.

Tool routing is centralized under `/api/subpolar-cli/tools/*`.
Pi built-in tools are centrally exposed as `read`, `write`, `edit`, `bash`, `grep`,
`find`, and `ls`. External tools use canonical `provider/tool` IDs and are called
through `subpolar-tools`; `search-tool` discovers them with a required query. The PocketBase router applies agent policies and run overrides,
creates approval records for writes and commands, waits for approval, and writes an audit
record for every decision. The `search-tool` Pi tool requires a non-empty query and
returns `tool | description | usage` rows. The `subpolar-tools` Pi tool exposes
list/describe/call for registered external tools.

PocketBase stores users, preferences, agent profiles, tool definitions, policies,
approvals, tool-call audit records, canonical Subpolar runs/run events, and rich
session transcripts. Canonical `/runs` requests use a fresh stateless runtime with
owner-bound PocketBase run/event ports; the transient Pi adapter is wrapped around
an in-memory SDK session. The process-local active-session map is only a
reconstructable streaming/cancellation fast path; PocketBase remains authoritative
across bridge restarts. Existing Pi JSONL transcripts are a legacy CLI format and
are not imported automatically.
