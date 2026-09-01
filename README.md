# Subpolar
Turning Pi into a general-purpose agent

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
- **Local WebUI:** a browser client connected through Pi RPC with chat,
  streaming transcripts, tool-call rendering, session resume/fork/clone,
  model and thinking-level selection, usage statistics, activity/unread
  indicators, settings, and extension management.
- **Operational improvements:** a one-command WebUI startup flow, typed
  bridge endpoints, live thinking markers, and more reliable transcript
  projection and large-prompt handling.

Pi remains the execution and session authority; the WebUI is a presentation
layer over the local RPC process. See [`@extensions/README.md`](./@extensions/README.md)
for extension commands and configuration, and [`WEBUI_FEATURES.md`](./WEBUI_FEATURES.md)
for the WebUI feature scope.

## WebUI

`@webui` is a local browser UI connected to Pi through `pi --mode rpc`. Read
`WEBUI_FEATURES.md` for feature scope and `@webui/README.md` for startup and
endpoint details.

Start bridge and Vite together:

```sh
./start-webui.sh
```

Open `http://localhost:5173`.
