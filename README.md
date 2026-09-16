# Subpolar
Turning Pi into a general-purpose agent

What I learnt from this:
Pi is a coding agent. While I could make the webui thing work, compatibility feels a bit forced.

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
- **Local WebUI:** a browser client connected to the embedded Pi SDK with chat,
  streaming transcripts, tool-call rendering, session resume/fork/clone,
  model and thinking-level selection, usage statistics, activity/unread
  indicators, settings, and extension management.
- **PocketBase application layer:** email auth, HttpOnly session cookies, user-scoped
  preferences and agent records, centralized tool policies, approval records, and
  tool-call audit history.
- **Tool routing:** Pi built-in tools and registered external tools pass through a
  PocketBase-backed registry and policy gateway before execution.
- **Operational improvements:** a one-command WebUI startup flow, typed
  bridge endpoints, live thinking markers, and more reliable transcript
  projection and large-prompt handling.

Pi remains the agent and session engine embedded in Subpolar; the WebUI is its
browser presentation layer. Application integrations live under
[`@webui/subpolar`](./@webui/subpolar) and are loaded through the Pi SDK. See
[`WEBUI_FEATURES.md`](./WEBUI_FEATURES.md) for the WebUI feature scope.

## WebUI

`@webui` is a local browser UI backed by an in-process Pi SDK session manager. Read
`WEBUI_FEATURES.md` for feature scope and `@webui/README.md` for startup and
endpoint details.

Start PocketBase first, then start the bridge and Vite together from any directory:

```sh
cp /path/to/pi-subpolar/.env.example /path/to/pi-subpolar/.env
# Set POCKETBASE_URL, POCKETBASE_EMAIL, and POCKETBASE_PASSWORD in .env
/path/to/pi-subpolar/start-webui.sh
```

Open `http://localhost:5173`. The first unauthenticated visit opens the PocketBase-backed
setup flow; subsequent application routes require a valid `pb_auth` session cookie.

### Docker development

Docker Compose runs PocketBase and the WebUI in separate containers. Create the local
configuration first, and set the PocketBase superuser credentials:

```sh
cp .env.example .env
# Edit .env and set POCKETBASE_EMAIL and POCKETBASE_PASSWORD

docker compose -f docker-compose.dev.yaml up --build
```

Then open `http://localhost:5173`. PocketBase is available at `http://localhost:8090`.
The PocketBase data is persisted in `pocketbase/pb_data`. Stop the stack with
`Ctrl-C`, or run `docker compose -f docker-compose.dev.yaml down` from another terminal.
