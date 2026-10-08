# Subpolar Agent

Local browser UI for the Pi SDK embedded in this repository. The bridge creates transient in-memory SDK execution contexts from PocketBase-backed session state and forwards typed events over WebSocket.

## Start

Install the whole workspace once from the repository root using Bun 1.3.14:

```sh
bun install --frozen-lockfile
```

The root `bunfig.toml` selects hoisted dependencies. Compatible versions can be
shared, but incompatible versions may retain nested copies; do not install a
separate dependency tree here. Start PocketBase and configure `.env` as below,
then start from any directory:

```sh
/path/to/pi-subpolar/start-subpolar-agent.sh
```

Equivalent manual startup (using the repository's absolute path):

```sh
bun --env-file=/path/to/pi-subpolar/.env /path/to/pi-subpolar/@subpolar-agent/bridge.ts
# In a second terminal:
bun run --cwd /path/to/pi-subpolar/@subpolar-agent dev
```

Open `http://localhost:5173`.

The bridge binds to `127.0.0.1:4173`. Set `SUBPOLAR_AGENT_PORT` to change it. Vite proxies `/api` to that port.

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

Extension routes live under `/api/extensions`: `projects`, `profiles`, `tools`, `commands`, `usage`, `session-title`, `session-search`, and `openapi-tools`. The old file-backed Pi CLI extension commands are not loaded by Subpolar Agent; use these application routes instead.

Tool routing is centralized under `/api/subpolar-cli/tools/*`.
Pi built-in file tools `read`, `write`, `edit`, and `ls` require a validated,
owned session workspace and relative, unlinked paths. Arbitrary `bash`, subprocess
`grep`/`find`, and MCP stdio are disabled at the shared-host tool gateway;
registered CLI is disabled by default. External tools use canonical `provider/tool` IDs and are called
through `subpolar-tools`; `search-tool` discovers them with a required query. The PocketBase router applies agent policies and run overrides,
creates approval records for writes and commands, waits for approval, and writes an audit
record for every decision. The `search-tool` Pi tool requires a non-empty query and
returns `tool | description | usage` rows. The `subpolar-tools` Pi tool exposes
list/describe/call for registered external tools. The separately assignable
`discover-mcp` tool temporarily inspects a known MCP HTTP/SSE endpoint with
`tools/list`; it does not register the server or make discovered tools callable.
It accepts environment-backed header references for authentication (secrets are
never passed inline), allows explicit private/homelab endpoints, and applies
bounded timeouts, response sizes, tool counts, and redirects. Use `search-tool`
for tools already registered in
Subpolar, `discover-mcp` to inspect an unregistered server, and the registered
integration flow plus `subpolar-tools` for subsequent authorized execution.

Example: when asked to inspect `http://192.168.1.40:8080/mcp`, an agent calls
`discover-mcp` and may receive `get_state`, `turn_on`, `turn_off`, and
`list_entities`. The server remains unregistered; those capabilities stay out of
`search-tool` and cannot be called through `subpolar-tools` until registered and
authorized through the normal integration flow.

PocketBase stores users, preferences, agent profiles, tool definitions, policies,
approvals, tool-call audit records, canonical Subpolar runs/run events, and rich
session transcripts. Canonical `/runs` requests use a fresh stateless runtime with
owner-bound PocketBase run/event ports; the transient Pi adapter is wrapped around
an in-memory SDK session. The process-local active-session map is only a
reconstructable streaming/cancellation fast path; PocketBase remains authoritative
across bridge restarts. Existing Pi JSONL transcripts are a legacy CLI format and
are not imported automatically.

## Validation

From the repository root:

```sh
bun run typecheck
bun run build
bun run test:ui
bun run test:server
bun run test:voice
```

Vitest is launched with `bun x --no-install` using a supported Node runtime on
`PATH`, not `bun run --bun vitest`. Use Node 22.12+ on the 22.x line or a supported
newer LTS. Bun-native server tests remain on Bun. The Docker image includes Node
without npm for the Vitest suites.

## Multi-user operating limits

Provider credentials must belong to the authenticated user. Subpolar Agent/proxy inference
does not fall back to server environment keys or local Pi auth/model files.
Custom-provider CRUD/discovery is not inference support: unknown/custom inference
fails closed until an owner-bound secret-loading implementation exists. Proxy
clients use an owner token and that owner's account-qualified model IDs.

There is **no OS sandbox** or implemented per-tenant worker dispatch. Workspace
fences and owner-scoped persistence do not make a shared host safe for hostile
tenants. The tool gateway restrictions do not certify every direct MCP management,
git, browser, voice, or other subprocess path. Local MCP command examples in the
UI describe argv syntax, not permission to execute stdio on a shared host.
Live two-user verification remains outstanding. See
[Bun and multi-user operations](../docs/bun-and-multi-user.md) for deployment
constraints, focused checks, and the remaining live verification checklist.
