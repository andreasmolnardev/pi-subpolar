# @subpolar/test-cli

An interactive development/debugging CLI for manually operating a running Subpolar instance. It is not a unit, E2E, or scenario runner. All backend operations go through `@subpolar/client`; this package does not call HTTP routes directly or accept an admin token.

## Usage

```sh
bun run --cwd packages/subpolar-test-cli start -- status --json
bun run --cwd packages/subpolar-test-cli start -- --url http://localhost:4173 projects list
bun run --cwd packages/subpolar-test-cli start -- sessions create --title "Debug session"
bun run --cwd packages/subpolar-test-cli start -- sessions send SESSION_ID "hello" --follow
bun run --cwd packages/subpolar-test-cli start -- sessions inspect SESSION_ID --json
bun run --cwd packages/subpolar-test-cli start -- sessions tool-call SESSION_ID CALL_ID --json
bun run --cwd packages/subpolar-test-cli start -- approvals list --session SESSION_ID
bun run --cwd packages/subpolar-test-cli start -- worktrees create PROJECT_ID --branch debug --source-ref main --expected-sha SHA
bun run --cwd packages/subpolar-test-cli start -- tools policies set master --policy=shell=deny
```

The default server URL is `http://localhost:4173`. Global options may appear anywhere:

- `--url URL` overrides the target URL.
- `--env NAME` selects `SUBPOLAR_ENV_<NAME>_URL` and `SUBPOLAR_ENV_<NAME>_TOKEN`.
- `--profile NAME` selects `SUBPOLAR_PROFILE_<NAME>_URL` and `SUBPOLAR_PROFILE_<NAME>_TOKEN`.
- `--token USER_TOKEN` or `SUBPOLAR_TOKEN` supplies the signed-in user's bearer token. There is no admin-token option. Bearer tokens are refused over plaintext HTTP except for loopback development URLs.
- `--timeout MS` sets the HTTP request timeout (default 30000 ms); once an SSE response is established it does not truncate the live stream. Each invocation uses one stable `x-request-id`; message delivery uses that same value for its message ID and idempotency metadata.
- Human-readable output is the default. `--json` emits JSON result/error envelopes and JSON Lines stream records. Use `--` after `sessions send SESSION_ID` when the prompt contains standalone option-like words, so they are not parsed as CLI options. `sessions events` and `sessions send --follow` emit distinct stream event records, then a final result record. Use `--limit N` to stop a stream after N events; otherwise it continues until interrupted.

Exit codes: `0` success, `1` request/runtime failure, `2` usage error, `3` timeout, `4` authentication/authorization failure, `5` valid operation not available through the installed `@subpolar/client`.

## Commands

- `status` — health and capability information.
- `agents list`, `models list`, `projects list`, plus owner-scoped `projects create NAME`, `projects update ID`, and `projects delete ID`.
- `sessions list [--project ID] [--search TEXT]` and `sessions delete SESSION_ID`.
- `sessions create` with optional `--title`, `--project`, `--directory`, `--agent`, `--model`, `--thinking`, `--permission`, and `--worktree`.
- `sessions send SESSION_ID MESSAGE [--follow]` — send a message and start its run; `--follow` then streams session events.
- `sessions inspect SESSION_ID`, `sessions messages SESSION_ID`, `sessions events SESSION_ID [--after ID] [--limit N]`, `sessions tool-call SESSION_ID CALL_ID`, `sessions errors SESSION_ID`, `sessions update SESSION_ID [--title TEXT] [--archived true|false] [--model PROVIDER/MODEL]`, and `sessions abort SESSION_ID`.
- `worktrees create PROJECT_ID --branch NAME --source-ref REF --expected-sha SHA` uses the authenticated repository/worktree API; session creation can attach an owned worktree using `--repository ID --worktree ID`.
- `tools policies set AGENT_ID --policy=TOOL_ID=allow|deny|approval [...]` replaces the selected agent's policies through the authenticated settings API.
- `runs inspect RUN_ID` inspects a run using the owner-scoped server route.
- `approvals list [--session ID]`, `approvals inspect ID [--session ID]`, and `approvals decision ID --session ID --response approve|reject|once|always`.
- `tools list [--agent ID]`, `agents inspect ID`, approvals list/inspect/decision, and settings inspect/update use the installed client's actual API operations. Agent inspection is derived from the authorized agent listing. Approval inspection can only find currently pending approvals because the server has no approval-by-ID history endpoint.

The current `@subpolar/client` includes session, status, project/model/agent listing, worktree creation, tool-call inspection, tool listing/policy replacement, settings inspection/update, approval list/decision, and owner-scoped SSE operations. No direct HTTP fallback is used. Authentication uses standard bearer tokens or browser-style cookies; CLI sign-in/token persistence is not implemented yet, so supply a user token with `--token`, `SUBPOLAR_TOKEN`, or a named environment/profile.

## Tests

```sh
bun run --cwd packages/subpolar-test-cli test
```
