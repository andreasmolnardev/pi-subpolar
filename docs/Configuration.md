# Configuration

Pi reads project-local configuration from `.pi/`. This repository ignores
`.pi/` because project paths, provider definitions, and local settings are
machine-specific. Create these files locally when needed.

## `projects.json`

Defines virtual project roots used by `@extensions/projects.ts`. The extension
changes the root used by Pi tools without changing Pi's process directory.

Accepted simple format:

```json
{
  "frontend": "/Users/me/src/frontend",
  "backend": "/Users/me/src/backend"
}
```

Entries can also use an object with a `path` field:

```json
{
  "projects": {
    "frontend": { "path": "/Users/me/src/frontend" }
  }
}
```

Supported locations, from lower to higher precedence:

1. `~/.pi/projects.json`
2. `~/.pi/agent/projects.json`
3. `<project>/.pi/projects.json`

Project-local names override global names. Paths are resolved relative to the
configuration file's owning directory. Use `/project NAME` in Pi or
`POST /api/extensions/projects` through the WebUI bridge to activate a root.

## `settings.json`

Controls Pi defaults and loads this repository's extensions:

```json
{
  "defaultModel": "openai-codex/gpt-5.4-mini",
  "sessionTitleGenModel": "openai-codex/gpt-5.4-mini",
  "extensions": [
    "../@extensions/agent-profiles.ts",
    "../@extensions/projects.ts",
    "../@extensions/usage.ts",
    "../@extensions/session-title.ts",
    "../@extensions/session-history-search.ts",
    "../@extensions/list-tools.ts",
    "../@extensions/openapi-tools.ts"
  ]
}
```

`defaultModel` selects Pi's normal model. `sessionTitleGenModel` is used by
`session-title.ts` after a session's first assistant response. Extension paths
are resolved by Pi relative to the `.pi` configuration context.

The WebUI bridge passes these extensions explicitly with `--extension` and
starts Pi using:

```sh
pi --mode rpc --no-approve --no-extensions
```

Do not put API keys or tokens in `settings.json`.

## `tools.json`

Configures stateless OpenAPI operations exposed by `openapi-tools.ts` as Pi
tools. Each operation with an `operationId` becomes
`<provider>_<operationId>`.

```json
{
  "web": {
    "baseUrl": "https://search.example.test",
    "openapi": "./search.openapi.yaml",
    "headers": {
      "X-API-Key": { "env": "SEARCH_API_KEY" }
    },
    "operations": ["search"]
  }
}
```

`openapi` accepts a JSON/YAML file path or an inline OpenAPI document.
`baseUrl` overrides the first server in that document. `operations` can be an
allowlist, or an object with operation IDs mapped to `false`. Header values can
reference environment variables with `{ "env": "NAME" }`.

Supported locations, from lower to higher precedence:

1. `~/.pi/tools.json`
2. `~/.pi/agent/tools.json`
3. `<project>/.pi/tools.json`

Project-local providers override global providers with the same name. Set
`skipTlsVerify` only for a provider that uses a trusted self-signed
certificate. Reload Pi after changing this file, or use the extension's
`manage_openapi_tools` tool from the master profile.

Never commit credentials. Prefer environment-variable references over literal
header values.
