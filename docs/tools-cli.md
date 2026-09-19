# `subpolar-tools` CLI

`subpolar-tools` is a bounded, authenticated HTTP client for the Subpolar tool
gateway. It is remote-only: it does not import Subpolar core, Pi, PocketBase,
Hono, or React, and it never creates a local adapter or session. The available
commands are `health`, `list`, `query <text>`, `describe <id>`, `add`, `call
<id>`, `approvals list`, `approvals continue <id>`, `approvals reject <id>`, and
`events`.

## Credentials

Provide a bearer credential with `--token`, `--token-file`, `--token-stdin`, or
`SUBPOLAR_TOOLS_TOKEN`. The CLI never supplies an internal token, `allow_all`,
or a fallback credential, and it does not print the credential. `--base-url`
selects the gateway (the default is `http://127.0.0.1:4173`).

Input for `call` and `add` can be supplied with `--input`, `--input-file`, or
stdin. Normal commands print human-readable summaries; `--json` selects stable
JSON envelopes for scripting. `events` always emits one JSON object per line.
`--timeout` bounds each request with `AbortController`, while SIGINT and SIGTERM
cancel in-flight requests with exit code 4 (`CLI_CANCELLED`). Timeout uses exit
code 3 (`CLI_TIMEOUT`).

## Authorized context

`call` requires an existing owned session supplied by `--session-id`. It does
not provide prompt, send, run, or session-creation commands. Optional
`--user-id`, `--agent`, `--cwd`, and `--call-id` are forwarded as caller context;
the server remains authoritative for ownership and session context. Approval
continuation and rejection also require the existing session ID. `--permission
allow_all` is never implicit and should only be used when the caller explicitly
chooses it.

`--wait` is forwarded as `waitForApproval: true`. The current compatibility
route may still return a resumable approval instead of holding the HTTP request
open; use `approvals continue` after the approval is resolved. A call or
continuation that returns `approvalRequired: true` preserves that result and
uses the remote exit code 1.

`add` only submits a tool definition to the gateway registration endpoint. It
does not call the new tool. Definitions require a canonical non-built-in
`namespace/operation` ID, an explicit adapter and risk enum, target and
operation, object input/output schemas, boolean `requiresApproval` and
`enabled` flags, and bounded non-secret object metadata. Invalid definitions
are rejected locally.

## Server compatibility

The current compatibility route may require a PocketBase bearer credential
until scoped gateway credentials are added. Use a user access token authorized
for the target user and session. The compatibility route currently exposes
approval listing through `/api/permission`, continuation through the tool
gateway, rejection through the session permissions endpoint, and events through
the authenticated SSE stream.

The compatibility registration endpoint may still require the server's legacy
internal registration credential. The CLI intentionally never defaults to that
credential, so `add` can remain unavailable until scoped gateway credentials
are added.

The CLI does not make these routes more privileged: registration remains subject
to the server's registration authorization, and tool calls remain subject to
the server's policy, approval, ownership, and audit checks.
