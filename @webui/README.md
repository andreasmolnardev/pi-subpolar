# Pi WebUI

Local browser UI for the Pi installation in this repository. The bridge starts one `pi --mode rpc` process per WebUI session and forwards JSONL events over WebSocket.

## Start

From repository root:

```sh
./start-webui.sh
```

Equivalent manual startup:

```sh
bun @webui/bridge.ts
cd @webui && npm run dev
```

Open `http://localhost:5173`.

The bridge binds to `127.0.0.1:4173`. Set `WEBUI_PORT` to change it. Vite proxies `/api` to that port.

## RPC Boundary

Bridge child processes use:

```sh
pi --mode rpc --session-id <id> --no-approve --no-extensions \
  --extension @extensions/agent-profiles.ts \
  --extension @extensions/projects.ts \
  --extension @extensions/usage.ts \
  --extension @extensions/session-title.ts \
  --extension @extensions/session-history-search.ts \
  --extension @extensions/list-tools.ts \
  --extension @extensions/openapi-tools.ts
```

Core routes live under `/api/sessions/:id` for prompt, state, messages, stats, abort, and arbitrary allowlisted Pi RPC commands. Streaming events use `/api/sessions/:id/events`.

Extension routes live under `/api/extensions`: `projects`, `profiles` (`agent-profiles`), `tools` (`list-tools`), `commands`, `usage`, `session-title`, `session-search` (`session-history-search`), and `openapi-tools`.

Session metadata is stored in `@webui/.sessions.json`, which is ignored. Conversation data remains in Pi's normal session directory.
