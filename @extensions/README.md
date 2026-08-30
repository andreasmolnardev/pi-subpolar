# Agent profiles and virtual projects

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
has the `manage_openapi_tools` tool for `add`, `edit`, `delete`, and `get`; pass a
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
