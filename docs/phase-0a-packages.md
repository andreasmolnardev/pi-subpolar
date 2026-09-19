# Phase 0A Local Packages

The new `packages/subpolar-contracts`, `packages/subpolar-core`,
`packages/subpolar-adapter-local`, and `packages/subpolar-cli` packages are the
bounded foundation for later Pi composition.

## State And Persistence

The local adapter is ephemeral by default. Its session transcript exists only in
the adapter instance and is not recoverable after the process exits. A request
for durability against that adapter raises the typed
`UNSUPPORTED_CAPABILITY` error instead of making a false persistence claim.

Persistence is explicit: construct the adapter with a JSON file path, or run
the CLI with `--session-file <path>`. Use `--session <id>` to select the session
ID. The JSON store contains only session transcript records; provider
credentials and secrets are not part of the session contract or adapter API.
The JSON file is a local single-process convenience, not a transaction,
multi-user, approval, or event-replay store.

## CLI Smoke Composition

`subpolar-cli run <prompt>` composes the contracts, core policy gateway, and
local adapter in one process. Its only current executor is the explicitly
named `local-fixture-echo` executor. The policy allows that one fixture tool by
canonical ID; there is no implicit `allow_all` policy. Use `--json` for the
stable result/error envelope.

The fixture is a smoke seam, not full Pi execution. The next integration task
is to inject the Pi-backed run/tool executor into the same core boundary without
adding Pi, WebUI, PocketBase, Hono, or HTTP imports to these packages.

Run the package tests with:

```sh
bun test packages/subpolar-contracts packages/subpolar-core packages/subpolar-adapter-local packages/subpolar-cli
```
