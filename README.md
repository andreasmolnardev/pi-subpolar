# Subpolar
Turning Pi into a general-purpose agent

What I learnt from this:
Pi is a coding agent. While I could make the Subpolar Agent work, compatibility feels a bit forced.

## Core Principles
- Isolation: Stateless where possible
- Modularity: Pi's extensibility at its core
- Transparency
- Portability: Run anywhere you need it to

## Modifications

This repository extends Pi into a local, general-purpose agent platform:

- **Agent customization:** named agent profiles with tool allowlists, per-agent
  tool permissions (`deny`, `manual`, or `auto`), project-specific system
  context, and a registered-tool browser.
- **Virtual projects:** switch the effective project root without changing the
  Pi process directory; project-local configuration and `AGENTS.md` files are
  respected.
- **Session workflows:** archive and restore sessions, search history across
  sessions, create blank or background sessions, and generate session titles.
- **External tools:** configure stateless OpenAPI operations as Pi tools and
  manage providers through the master agent.
- **Model integration:** expose the selected Pi model through an optional
  OpenAI-compatible blank proxy.
- **Local Subpolar Agent:** a browser client connected to the embedded Pi SDK with chat,
  streaming transcripts, tool-call rendering, session resume/fork/clone,
  model and thinking-level selection, usage statistics, activity/unread
  indicators, settings, and extension management.
- **PocketBase application layer:** email auth, HttpOnly session cookies, user-scoped
  preferences and agent records, centralized tool policies, approval records, and
  tool-call audit history.
- **Tool routing:** Pi built-in tools and registered external tools pass through a
  PocketBase-backed registry and policy gateway before execution.
- **Operational improvements:** a one-command Subpolar Agent startup flow, typed
  bridge endpoints, live thinking markers, and more reliable transcript
  projection and large-prompt handling.

Pi remains the agent and session engine embedded in Subpolar; the Subpolar Agent is its
browser presentation layer. Application integrations live under
[`@subpolar-agent/subpolar`](./@subpolar-agent/subpolar) and are loaded through the Pi SDK. See
[`SUBPOLAR_AGENT_FEATURES.md`](./SUBPOLAR_AGENT_FEATURES.md) for the Subpolar Agent feature scope.

## Install and validate

Use **Bun 1.3.14** from the repository root. `@subpolar-agent` and `packages/*` are one
workspace; `bunfig.toml` selects the hoisted linker and `bun.lock` is the lockfile.

```sh
bun --version
bun install --frozen-lockfile
bun run typecheck
bun run build
bun run test:core
bun run test:ui
bun run test:server
bun run test:voice
```

Install once at the root, not separately in `@subpolar-agent` or individual packages.
Hoisting shares compatible dependencies; incompatible versions may still need
nested copies. It is not a universal deduplication guarantee.
Vitest suites require a supported Node runtime on `PATH` (Node 22.12+ on the
22.x line, or a supported newer LTS). Their scripts use `bun x --no-install`
without forcing Vitest onto Bun. Bun remains the package manager and application
runtime; npm is not required.
See [Bun and multi-user operations](docs/bun-and-multi-user.md) for details.

## Subpolar Agent

`@subpolar-agent` is a local browser UI backed by an in-process Pi SDK session manager. Read
`SUBPOLAR_AGENT_FEATURES.md` for feature scope and `@subpolar-agent/README.md` for startup and
endpoint details.

Run the application and its backend services through the development Compose stack. Do not start PocketBase, the bridge, Vite, or `start-subpolar-agent.sh` directly on the host. See [Docker development](#docker-development) for setup.

Open `http://localhost:5173`. The first unauthenticated visit opens the PocketBase-backed
setup flow; subsequent application routes require a valid `pb_auth` session cookie.

### Current multi-user limits

Subpolar Agent inference requires the authenticated user's **owned provider accounts**;
server environment keys and local Pi auth/model files are not a tenant fallback.
Custom-provider CRUD/discovery exists, but custom-provider inference is not wired
up and fails closed. Proxy clients need an owner token and an account-qualified
model from that owner's model list.

Owner-scoped records and workspace checks are application boundaries, **not an
OS sandbox**. The shared-host tool gateway disables arbitrary shell, subprocess
search, registered CLI by default, and MCP stdio. Other subprocess/management
paths still require review. Do not expose this host to hostile tenants; no
per-tenant worker dispatch is implemented. Live two-user verification remains
outstanding; focused/stubbed tests are not deployment certification.
See [operational limits and verification](docs/bun-and-multi-user.md#multi-user-boundaries).

### ChatGPT sign-in

In **Settings → Providers → Providers**, choose **Sign in with ChatGPT** to connect
an eligible ChatGPT account through Pi 1.0.2's native normal `openai` provider.
The new flow uses browser authorization, with a full redirect-URL fallback for
remote servers. Device-code login belongs to the separate `openai-codex` provider.
OpenAI API-key authentication remains available, and account/model limits apply.
See [ChatGPT sign-in](docs/chatgpt-sign-in.md) for callback, storage, and account details.

### Integration progress

See [parallel feature progress](docs/feature-progress.md) for the current implementation,
validation results, and remaining deployment/design gates across the feature workstreams.

### Docker development

Docker Compose runs PocketBase and the Subpolar Agent in separate containers. Create the local
configuration first, and set the PocketBase superuser credentials:

```sh
cp .env.example .env
# Edit .env and set POCKETBASE_EMAIL and POCKETBASE_PASSWORD

docker compose -f docker-compose.dev.yaml up --build
```

Then open `http://localhost:5173`. PocketBase is available at `http://localhost:8090`.
The image uses Bun 1.3.14 and a Node 22 runtime (without npm) for Vitest. It
installs the root workspace with the frozen Bun lockfile. Compose is a shared
application container, not a per-tenant sandbox.
The PocketBase data is persisted in `pocketbase/pb_data`. Stop the stack with
`Ctrl-C`, or run `docker compose -f docker-compose.dev.yaml down` from another terminal.

For local CLI debugging only, set `SUBPOLAR_DEV_ADMIN_TOKEN_ENABLED=true` in `.env`, then
`POST /api/auth/dev-admin-token` at the Docker-published API. The endpoint is disabled by
default, requires development mode, and logs a one-time **normal application-admin user
bearer token** without returning it in the HTTP response. Read it from the `subpolar-agent`
container logs and treat those logs as secret. This is not a PocketBase superuser token or
the bridge internal token; use it only as a user token with `subpolar-test-cli`. The dev
Compose API and WebUI ports bind to loopback.
