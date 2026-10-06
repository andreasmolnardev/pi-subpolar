# Pi extensions

Subpolar Agent's extension boundary is limited to the active tool integrations:
`list-tools.ts`, `openapi-tools.ts`, and bridge-owned `tool-routing.ts`. The
remaining sections document standalone Pi CLI extensions. Session state,
projects, profiles, search, titles, usage, and skills are owned by the Subpolar Agent
application boundary rather than file-backed compatibility extensions.

## Background sessions

`background.ts` adds `/background [prompt]`. It copies the current saved session,
starts it in a detached RPC-mode Pi process, and displays its progress under
`[Background sessions]` in the profiles widget. Completed sessions are marked
`✓`; switching to one removes it from that list. `/new-bg [prompt]` starts a
blank session in the same project with the current model and profile.

## Stateless OpenAPI tools

`openapi-tools.ts` turns OpenAPI operations into stateless HTTP tools. Add a
provider to `~/.pi/tools.json`, `~/.pi/agent/tools.json`, or the project-local
`.pi/tools.json` (later/local definitions override earlier ones):

```json
{
  "web": {
    "openapi": "./searxng.openapi.yaml",
    "headers": {
      "X-API-Key": { "env": "SEARXNG_API_KEY" }
    },
    "operations": ["search"]
  }
}
```

The OpenAPI document can be JSON, YAML, or an embedded object. Each operation
with an `operationId` is registered centrally as `provider/operationId`, for
example `web/search`. The operation's query, path, header, and JSON body
parameters are retained by the bridge adapter. External tools are not
registered as individual Pi functions; use `search-tool` to discover already
registered tools and `subpolar-tools` to describe or call them. The separate
`discover-mcp` tool temporarily runs `tools/list` against a known, unregistered
HTTP/SSE endpoint and returns its advertised schemas only. It does not register,
trust, enable, or execute those tools; registration and normal resolver-backed
calls remain separate. Configure `baseUrl` to override the first OpenAPI server.
Tool policy, approvals, auditing, credentials, and HTTP execution all happen in
the bridge.


## Permissions

`permissions.ts` enforces per-agent, per-tool `deny`, `manual`, or `auto` approval. The master agent bypasses the gate and has every tool. Configure it in `~/.pi/agent/permissions.json` or `.pi/permissions.json` (local wins):

```json
{
  "permissionAutoApprovalModel": "openai-codex/gpt-5.4-mini",
  "agents": { "reviewer": { "read": "auto", "bash": "manual", "write": "deny" } }
}
```

Use `/permissions` in the TUI to inspect or change a rule. The web agent editor exposes the same three choices; the detailed `toolAccess` value is retained for the extension.

## Registered tools

`list-tools.ts` adds `/list-tools`, which shows the registered tools exposed by
the Subpolar Agent tool registry and their availability to the active profile.

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