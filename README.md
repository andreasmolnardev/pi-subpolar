# Subpolar
Turning Pi into a general-purpose agent

## Core Principles
- Isolation
- Modularity
- Transparency
- Portability

## Blank proxy

The local `blank-proxy` extension exposes Pi's currently selected model as an
OpenAI-compatible endpoint, while discarding incoming `system` and `developer`
messages. Start Pi in this project, then use:

```sh
export PI_BLANK_PROXY_PORT=8787  # optional
pi
```

Clients can connect to `http://127.0.0.1:8787/v1` using any API key and call
`/chat/completions`. The request is run through Pi's already configured model
(use `provider/model` or a configured model ID in the request's `model` field).

For example:

```sh
curl http://127.0.0.1:8787/v1/chat/completions \\
  -H 'Content-Type: application/json' \\
  -d '{"model":"anything","messages":[{"role":"user","content":"Hello"}]}'
```

## WebUI

`@webui` is a local browser UI connected to Pi through `pi --mode rpc`. Read
`WEBUI_FEATURES.md` for feature scope and `@webui/README.md` for startup and
endpoint details.

Start bridge and Vite together:

```sh
./start-webui.sh
```

Open `http://localhost:5173`.
