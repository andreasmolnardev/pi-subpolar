# Pi WebUI

Local browser UI for the Pi SDK embedded in this repository. The bridge creates one in-process SDK session per WebUI session and forwards typed events over WebSocket.

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

The bridge imports `@earendil-works/pi-coding-agent` and creates an `AgentSession`
for each WebUI session. Subpolar integrations are registered as SDK extension
factories from `subpolar/extensions`; no Pi CLI process is started.

Core routes live under `/api/sessions/:id` for prompt, state, messages, stats, abort, and arbitrary allowlisted Pi RPC commands. Streaming events use `/api/sessions/:id/events`.

Extension routes live under `/api/extensions`: `projects`, `profiles` (`agent-profiles`), `tools` (`list-tools`), `commands`, `usage`, `session-title`, `session-search` (`session-history-search`), and `openapi-tools`.

Tool routing is centralized under `/api/subpolar-cli/tools/*` (with `/api/pi/tools/authorize` retained as a compatibility route).
Pi built-in tools are centrally exposed as `read`, `write`, `edit`, `bash`, `grep`,
`find`, and `ls`. External tools use canonical `provider/tool` IDs and are called
through `subpolar-tools`; `search-tool` discovers them with a required query. The PocketBase router applies agent policies and run overrides,
creates approval records for writes and commands, waits for approval, and writes an audit
record for every decision. The `search-tool` Pi tool requires a non-empty query and
returns `tool | description | usage` rows. The `subpolar-tools` Pi tool exposes
list/describe/call for registered external tools.

PocketBase stores users, preferences, agent profiles, tool definitions, policies,
approvals, and tool-call audit records. Pi conversation data remains in Pi's normal
session directory; local SQLite is retained only for session/project compatibility metadata.
