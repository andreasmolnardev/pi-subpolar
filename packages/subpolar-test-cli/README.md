# `@subpolar/test-cli`

Small command-line client for exercising Subpolar's authenticated Automations API and provider login flows. It uses the public HTTP API and a normal Subpolar user token; it does not connect to PocketBase or call internal bridge endpoints.

## Authentication

Supply an application user token with `SUBPOLAR_API_TOKEN` (recommended) or `--token`. Do not use PocketBase superuser credentials or internal administrator/bridge tokens. The CLI sends the value as a bearer token and never includes it in normal output or error messages. The API URL defaults to `http://localhost:4173`; set `SUBPOLAR_API_URL` or pass `--base-url` to override it.

```sh
export SUBPOLAR_API_URL=http://localhost:4173
read -s SUBPOLAR_API_TOKEN
export SUBPOLAR_API_TOKEN
bun packages/subpolar-test-cli/src/cli.ts automations list
```

The `read -s` prompt keeps the token out of shell history and terminal echo. Avoid putting credentials directly in a shared command transcript.

## Commands

```sh
bun packages/subpolar-test-cli/src/cli.ts automations list
bun packages/subpolar-test-cli/src/cli.ts automations get <automation-id>
bun packages/subpolar-test-cli/src/cli.ts automations create '{"name":"Daily digest","agentId":"research","promptTemplate":"Summarize AI news","trigger":{"type":"manual"},"actions":[]}'
bun packages/subpolar-test-cli/src/cli.ts automations enable <automation-id>
bun packages/subpolar-test-cli/src/cli.ts automations disable <automation-id>
bun packages/subpolar-test-cli/src/cli.ts automations run <automation-id> '{"source":"test"}'
bun packages/subpolar-test-cli/src/cli.ts automations executions <automation-id>
bun packages/subpolar-test-cli/src/cli.ts automations execution <automation-id> <execution-id>
bun packages/subpolar-test-cli/src/cli.ts automations cancel <automation-id> <execution-id>
bun packages/subpolar-test-cli/src/cli.ts providers login nvidia "NVIDIA NIM"
```

Use `--json` for the same response in JSON output mode. `automations create` accepts one JSON object argument. `automations run` optionally accepts JSON trigger payload.

`providers login <provider-id> [account-label]` runs the same authenticated provider API-key flow as the WebUI. Enter the API key only at the hidden prompt; it is sent to the server login endpoint and is never printed by the CLI. NVIDIA NIM is available under provider id `nvidia`.

## Tests

```sh
bun test packages/subpolar-test-cli
```
