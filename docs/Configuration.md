# Configuration

## PocketBase and authentication

The bridge uses PocketBase for user accounts, session authentication, preferences,
agent records, tool policies, approvals, and tool-call audit history. Run PocketBase
on the configured URL and copy `.env.example` to `.env`:

```sh
cp .env.example .env
```

Required server credentials:

```sh
POCKETBASE_URL=http://127.0.0.1:8090
POCKETBASE_EMAIL=admin@example.com
POCKETBASE_PASSWORD=your-pocketbase-superuser-password
```

The bridge authenticates to PocketBase as a superuser for application persistence and
uses PocketBase's `users` collection for browser sign-in. It issues an `HttpOnly`
`pb_auth` cookie after sign-in or registration. `AUTH_SECURE_COOKIES=true` should be
used when the bridge is served over HTTPS.

Set `ADMIN_EMAIL` and `ADMIN_PASSWORD` to provision an initial application user at
startup and disable public registration. Alternatively, leave those variables empty
and create the first account through `/setup`.

`SUBPOLAR_INTERNAL_TOKEN` authenticates bridge-to-Pi tool authorization requests. If
omitted, a random process-local token is generated for development.

Pi reads project-local configuration from `.pi/`. This repository ignores
`.pi/` because project paths, provider definitions, and local settings are
machine-specific. Create these files locally when needed.

## `projects.json`

Defines virtual project roots used by `@webui/subpolar/extensions/projects.ts`. The SDK integration
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
    "./subpolar/extensions/agent-profiles.ts",
    "./subpolar/extensions/projects.ts",
    "./subpolar/extensions/usage.ts",
    "./subpolar/extensions/session-title.ts",
    "./subpolar/extensions/session-history-search.ts",
    "./subpolar/extensions/list-tools.ts",
    "./subpolar/extensions/openapi-tools.ts"
  ]
}
```

`defaultModel` selects the default SDK model. `sessionTitleGenModel` is used by
`session-title.ts` after a session's first assistant response. The WebUI bridge
registers the integrations directly with the Pi SDK; this configuration is not
loaded by a Pi CLI process.

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
`manage_external_tools` tool from the master profile.

Never commit credentials. Prefer environment-variable references over literal
header values.
