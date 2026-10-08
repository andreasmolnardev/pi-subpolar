# @subpolar/test-cli

A user-authenticated command-line client for the Subpolar HTTP API. All API transport goes through `@subpolar/client`; this package does not call HTTP routes directly and does not accept an admin token.

## Usage

```sh
bun run --cwd packages/subpolar-test-cli start -- status
bun run --cwd packages/subpolar-test-cli start -- --url http://localhost:4173 projects list --json
bun run --cwd packages/subpolar-test-cli start -- sessions create --title "CLI test"
bun run --cwd packages/subpolar-test-cli start -- sessions send SESSION_ID "hello"
bun run --cwd packages/subpolar-test-cli start -- sessions events SESSION_ID --limit 10 --jsonl
bun run --cwd packages/subpolar-test-cli start -- test scenario.yaml
```

The default server URL is `http://localhost:4173`. Options may appear anywhere:

- `--url URL` overrides the target URL.
- `--env NAME` selects `SUBPOLAR_ENV_<NAME>_URL` and `SUBPOLAR_ENV_<NAME>_TOKEN`.
- `--profile NAME` selects `SUBPOLAR_PROFILE_<NAME>_URL` and `SUBPOLAR_PROFILE_<NAME>_TOKEN`.
- `--token USER_TOKEN` or `SUBPOLAR_TOKEN` supplies the signed-in user's bearer token. There is no admin-token option.
- `--timeout MS` sets the request timeout (default 30000 ms); each invocation sends a stable `x-request-id`, and message delivery uses the same ID for idempotency metadata.
- `--json` prints one JSON result/error envelope. `--jsonl` prints event records as JSON Lines where applicable. Session events stream until `--limit` is reached or the command is interrupted.

Exit codes: `0` success, `1` request/runtime failure, `2` usage/scenario error, `3` timeout, `4` authentication/authorization failure, `5` valid command unavailable through `@subpolar/client`.

## Supported command boundary

Supported operations use current client exports: `status` (health and capabilities), `agents list`, `models list` (the authenticated provider catalog), `projects list`, session list/create/send/inspect/errors/abort/events, and `test <scenario.yaml>`. Session `errors` filters the session message transcript for records with an `error` property or `type: error`. Session inspect combines `getSession` and `messages`. Send/test start a run using the client's `run()` method.

`runs inspect` is intentionally reported as unavailable (exit 5): the current server exposes no public per-run inspection route. This CLI does not bypass that boundary with guessed routes. It also does not implement auth sign-in, project mutations, approvals, worktrees, or per-session WebSocket events. SSE events use the client's owner-scoped stream.

## Scenario schema

Scenarios create one session and send each listed message in order. Supported YAML is intentionally a small subset: top-level `title` (string), `project` (string or number), and `messages` (list of non-empty strings). Comments and blank lines are accepted. JSON objects with the same schema are accepted as well. Other keys/structures fail with a usage error.

```yaml
title: smoke test
project: 4
messages:
  - Say hello
  - Summarize the previous response
```

`project` is passed to the client as the project identifier; no project is inferred when omitted. Scenario runs use unique message IDs derived from the invocation request ID.

## Tests

```sh
bun run --cwd packages/subpolar-test-cli test
```
