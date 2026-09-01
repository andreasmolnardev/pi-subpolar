# Agent profiles and virtual projects

## Session archive

`session-archive.ts` adds `/archive`, which moves the current persisted session
into an `archive/` directory beside the project's regular session directory and
starts a new session. `/archived` browses those sessions and resumes a selected
one. Archived files are not returned by `/sessions`.


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
with an `operationId` becomes `provider_operationId`; the example registers
`web_search` (shown as `web.search` in the label) and maps its arguments to
query, path, header, or JSON body parameters. Tool names cannot contain dots
because model APIs restrict them to letters, numbers, underscores, and dashes. Configure `baseUrl` to override the first OpenAPI server. Set
`skipTlsVerify: true` only for providers using self-signed certificates.
Reload Pi after changing the file. The master profile has access to every
registered tool, including generated `provider_operationId` tools, and also
has the `manage_external_tools` tool for `add`, `edit`, `delete`, and `get`; pass a
`provider`, optional `scope` (`local` or `global`), and `config` for add/edit.

## Virtual projects

`projects.ts` adds `/project`, which selects a directory for pi's tools without changing pi's actual process directory. Relative paths passed to `read`, `write`, `edit`, `grep`, `find`, and `ls` are resolved against the selected directory; bash and `!` commands execute there. The selected directory's `AGENTS.md` files are added to the agent context.

Project definitions can be stored globally in `~/.pi/agent/projects.json` (or `~/.pi/projects.json`) and locally in `.pi/projects.json`. Local definitions override global definitions:

```json
{
  "frontend": "/Users/me/src/frontend",
  "backend": { "path": "/Users/me/src/backend" }
}
```

Commands:

```text
/project          # choose interactively
/project list     # list definitions
/project frontend          # switch virtual project
/project /tmp/foo          # switch directly to a directory
/project new NAME DIRECTORY # add and switch to a project
```

## Permissions

`permissions.ts` enforces per-agent, per-tool `deny`, `manual`, or `auto` approval. The master agent bypasses the gate and has every tool. Configure it in `~/.pi/agent/permissions.json` or `.pi/permissions.json` (local wins):

```json
{
  "permissionAutoApprovalModel": "openai-codex/gpt-5.4-mini",
  "agents": { "reviewer": { "read": "auto", "bash": "manual", "write": "deny" } }
}
```

Use `/permissions` in the TUI to inspect or change a rule. The web agent editor exposes the same three choices; the detailed `toolAccess` value is retained for the extension.

## Agent profiles

`agent-profiles.ts` adds named profiles containing a replacement system prompt and an allowlist of active tools. `list-tools.ts` adds `/list-tools`, which shows all registered tools and dims those unavailable to the active profile.

Commands:

```text
/profile              # choose interactively
/profile NAME         # activate directly
/profile create NAME  # create a profile interactively
/profile list         # list profiles
```

Profiles are loaded from `~/.pi/agent/agents.json` and `.pi/agents.json`; project-local values override global values.

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