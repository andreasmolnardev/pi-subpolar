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
A transcript is history, not a durable run outcome: `SessionStore` persistence
alone never makes a failed or cancelled run recoverable. `RunResult.recoverable`
is `true` only when the caller injects a `RunStore` with the
`run.outcome.persistence` capability and an `EventReplayPort` with the
`event.replay` capability, and both final writes succeed. Without both ports,
the run service returns `interrupted` or `unknown` with `recoverable: false` as
appropriate. It does not write interrupted/unknown run metadata through an
unsupported `RunStore`. Cancellation observed after executor completion is
`unknown` without those ports; it cannot be treated as recoverable from the
session transcript.

The JSON file is a local single-process convenience, not a transaction,
multi-user, approval, run-outcome, or event-replay store.

## CLI Smoke Composition

`subpolar-cli run <prompt>` composes the contracts, core policy gateway, run
service, and local adapter in one process. The CLI still uses the explicitly
named `local-fixture-echo` executor; it is a local fixture, not a Pi adapter.
The policy allows that one fixture tool by canonical ID; there is no implicit
`allow_all` policy. Use `--json` for the stable result/error envelope.

`createRunService()` is the composition seam for the future Pi adapter. A Pi
adapter should implement `AgentExecutor` or `AgentRunPort`, receive the
correlated `RunRequest` and `AbortSignal`, and return its output without
bringing Pi runtime types into contracts or core. The adapter can be wired at
the CLI/application boundary later; no Pi adapter is wired today.

An application adapter must construct the `RunContext` from its authenticated
owner and session boundary before calling the service. It must provide an
owner-scoped `SessionStore`, if transcript history is desired, and separate
owner-scoped `RunStore`/`EventReplayPort` bridges if durable recovery is
desired. Do not cast an owner repository or transcript store to one of these
ports: implement the port methods explicitly and preserve `runId`, `requestId`,
and `sessionId` on every outcome and event.

The fixture is a smoke seam, not full Pi execution. The packages intentionally
do not import Pi, WebUI, PocketBase, Hono, or HTTP modules.

Run the package tests with:

```sh
bun run test:core
```
