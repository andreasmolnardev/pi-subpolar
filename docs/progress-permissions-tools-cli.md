# Permissions, approvals, audit, and tools CLI progress

## Ownership and authority

The original parity slice changes only `packages/subpolar-tools/src/cli.ts`, `@webui/server/routes/tools.ts`, `@webui/server/routes/gateway.ts`, the new `@webui/server/tests/gateway-parity-progress.test.ts`, and this document. The handoffs 1/2 closure additionally owns `@webui/server/bridge-request-handler.ts`, **only the SSE stream section** of `@webui/server/routes/legacy.ts`, and new `@webui/server/tests/gateway-bridge-scoped.test.ts`. It does not write `bridge-runtime.ts` or other agents' files. Existing uncommitted work and other agents' edits are preserved. There are no existing `@webui/server/core/tool*.ts` or `approval*.ts` files.

The execution authority remains `packages/subpolar-core/src/index.ts` (`createPolicyGateway`/`createGateway`). WebUI composes it in `@webui/server/application/tools/tools.ts:createCoreToolGateway` with owner-bound approval, audit, and idempotency adapters. HTTP routes do credential/ownership boundary checks; they do not execute adapters directly or implement another policy engine. `packages/subpolar-tools/src/cli.ts` remains an HTTP client without core/runtime imports. The standalone registry in `packages/subpolar-tools/src/index.ts` is unchanged and is not introduced as a second bridge authority.

## Fixed

- Discovery, call, and continuation scope checks use an owned persisted session's project, profile, and session ID rather than untrusted project claims or incomplete preflight context. Scoped calls also check the actual resolved agent before creating the gateway.
- CLI `list`, `query`, and `describe` forward `--session-id`; credentials restricted to a session/project can now use discovery in that session. Discovery without required context still fails closed.
- List/describe/search resolve the owned persisted session's actual agent, project and durable permission override without forwarding client hints. Resolver default permissions are not converted into overrides. Search obtains effective visible candidates before ranking and the 12-result cap, rather than intersecting capped baseline results; standard search excludes on-demand tools while explicit list/describe retain them. Existing owner visibility and capability ceilings remain authoritative.
- Registration writes a global registry. A project/session/agent-scoped credential cannot authorize this global operation by submitting matching scope claims. Registration requires unscoped `add` permission or the existing internal path.
- CLI and legacy approval continuation derive cwd, agent, project, and permission override from persisted session context. CLI continuation does not forward a replacement `callId`, preserving the stored approval call identity and idempotency key.
- Legacy approval retries notify waiters using the **stored** terminal status. Retrying an approval request against an already rejected approval does not incorrectly announce approval or continue execution. `always` remains a compatibility alias for approval, not a persisted policy grant.
- Approval-list and legacy approval-response bodies pass through existing response redaction, including continuation output.
- Credential creation rejects malformed scope objects/arrays, unknown scope fields, and nonnumeric/nonfinite expiry instead of silently dropping constraints. Credential-store failures return structured errors without raw diagnostics.
- CLI recognizes both legacy `approvalRequired: true` and core `status: "approval_required"` pending responses, retaining approval IDs in the result envelope and the existing remote exit code. Structured gateway auth/scope errors retain code/status and redact credentials.

## Tests and verification

All calls in these tests are local stubs or in-memory ports. No server was started, no live API calls were made, and no real credentials were used.

The new parity suite tests persisted scope for list/query/describe/call/continuation, cross-user session access, an actual approval-service cross-user approval-ID denial, global registration isolation, redacted responses, rejected-decision retry behavior, and legacy/CLI continuation context parity. It also exercises the **existing core** for deny-over-approval-over-allow and pending/approved concurrent retry idempotency with input/output/JSON-encoded audit redaction. CLI tests cover invalid, expired, revoked, permission-denied, and scope-denied structured errors and the core 202 approval shape.

Core idempotency coverage here is in-memory within one gateway. It does not establish multi-process guarantees or durable WebUI continuation correctness.

Commands (each bounded to 60 seconds):

```sh
# From @webui:
bun x --no-install vitest run server/tests/gateway-parity-progress.test.ts server/tests/approval-flow.test.ts server/tests/approval-event.test.ts server/tests/approval-execution.test.ts server/tests/security-redaction.test.ts server/tests/tool-routing.test.ts

# From repository root (these suites use bun:test):
bun test packages/subpolar-tools/test
bun test @webui/server/tests/gateway-credentials.test.ts packages/subpolar-core/test/gateway.test.ts

# From @webui, targeted strict typecheck:
bun run --bun tsc --noEmit --strict --noUnusedLocals --noUnusedParameters --skipLibCheck --module preserve --moduleResolution bundler --target ES2022 --allowImportingTsExtensions --types node server/tests/gateway-parity-progress.test.ts
```

Final reruns passed:

- Vitest: **52 tests across 6 files**, including **32 new parity/security tests**.
- Bun (tools, gateway credentials, core gateway combined): **40 tests across 4 files**.
- Targeted strict TypeScript check: **passed**.
- Scoped `git diff --check`: **passed**.

An initial attempt to run `gateway-credentials.test.ts` with Vitest failed because that existing suite imports `bun:test`; its subsequent Bun run passed (15 tests including core gateway tests). A temporary node-environment annotation on the new suite was removed because the repository's global test setup requires `window`.

Earlier parity-slice `tsconfig.bridge.json` runs reported errors in provider runtime, MCP/tool composition, other progress tests, browser transport, and core runtime, followed by a concurrent `worktree-integration.test.ts` syntax error. Those files were not modified by this work. **The handoffs 1/2 closure rerun passed the full bridge typecheck** after concurrent parent fixes; see the exact commands below. This is a local snapshot result, not a claim about every concurrent agent's changes.

## Remaining / exact integration handoffs

1. **CLOSED locally — bridge gateway principal allowlist.** The request coordinator rejects every unsupported gateway method/path with `403 GATEWAY_ROUTE_DENIED` before domain dispatch, for both scoped and unscoped gateway credentials. A gateway bearer never falls back to cookie/user identity, including invalid, unavailable, or null authentication results. Existing user authentication and exact internal-token handling remain intact. This is a principal boundary; existing route checks and core execution remain authoritative. Exact supported surface and public exceptions are documented below.
2. **CLOSED locally — SSE persisted scope and credential owner.** Gateway subscriptions use `gatewayCredential.ownerId` even if a user identity is also supplied. Query `sessionId`, when supplied, must resolve to that owner's persisted session; project and enabled agent name (ID/name lookup, with the existing master fallback) are derived from persistence before the existing `assertGatewayAccess(..., 'events', context)`. Missing context fails closed for session/project/agent-scoped credentials. Replay requires matching durable owner/session metadata. Live delivery retains the inspected runtime owner filter and adds a subscription-bound session filter. No runtime file or second permission policy was added. See limitations below.
3. **Application/core owners — durable approval continuation.** `continueCoreApprovedTool` currently consumes in-process approval input before calling core and maps every non-approved record to pending, including rejected/expired records. Retry after consuming input may require configured encrypted persisted input; this slice preserves identity but does not fix input lifetime, expiration mapping, or durable claiming. WebUI gateway composition uses owner-bound idempotency but does not wire the core continuation/approval-claim ports. Prove concurrent continuation across independently constructed gateways/processes with the actual persistence adapter and migrations before claiming durable exactly-once behavior.
4. **Application/core owners — approval request binding.** Core validates approved call/tool IDs; WebUI approval store loading is owner-bound. Inspect and enforce session/agent/input binding as well: reusing the original call ID must not apply an approval to a changed input or another session owned by the same user. No new authority was added in the route to compensate for this.
5. **CLOSED locally — scoped discovery and search completeness.** `searchToolsForAgent(..., query, projectId?, permissionOverride?, includeOnDemand = false)` now uses `listToolsForAgent` with effective project/permission context before existing ranking/capping. The route's post-filter intersection is removed, so effective-context candidates absent from baseline search are not omitted and excluded candidates do not consume the 12-result cap. List/describe/search resolve the owned persisted session without client agent/permission hints, authorize actual resolved agent/project scope, and forward non-default durable permission only. Project IDs use resolved `project.id` with stored `session.projectId` fallback. Explicit list still includes on-demand tools; standard search does not. This closes propagation/completeness only: it does not make project policy a privilege grant or change capability ceilings, core authority, execution, or approval state. Exact real-policy coverage and validation are below.
6. **Bridge/tool capability owner — caller capability assertions.** The call route still forwards caller-supplied capability names to core metadata, as before this slice. Audit how internal adapters authorize those values; a user-submitted capability string must not create a grant. Derive grants from authenticated/persisted context in the owning composition layer.
7. **CLI/bridge wait semantics.** CLI sends `waitForApproval` for `--wait`; the owned route currently returns pending rather than implementing a wait. No open-ended polling or live wait was added. HTTP approval continuation also remains subject to the durable-input limitation above.
8. **Auth error status consistency.** Bridge authentication maps expired/revoked tokens to 403; tool-route auth error mapping uses 401 for those codes. CLI preserves the remote status rather than imposing a new mapping. Central status semantics belong to bridge auth.

## Handoffs 1/2: exact protected surface and verification

Gateway-principal dispatch permits only:

- `POST /api/subpolar-cli/tools/{list,search,describe,register,call,continue}`.
- `GET /api/permission` and `POST /api/session/:sessionId/permissions/:approvalId`.
- `GET /api/sse/stream`.
- Voice `GET /api/{stt,tts}/{status,models}`, `GET /api/tts/voices`, `POST /api/stt/transcribe`, and `POST /api/tts/synthesize`. The inspected production `voiceAuthorization` already requires an owned persisted session and enabled resolved agent and checks gateway `call` against session/project/agent scope. Local tests stub that composition and prove the coordinator invokes it and stops dispatch on denial; they do not execute production voice backends.

All other gateway-principal paths/methods are denied, including providers, projects, settings, general session APIs, agents, runtime/management, auth endpoints, gateway credential management, question polling, SSE subscribe/unsubscribe/visibility no-ops, and extra route suffixes. Exact matching intentionally does not accept trailing-slash variants. Permission grants are still checked in each supported handler, not conferred by the allowlist. Existing public `GET /api/v1/{capabilities,health}` probes and `OPTIONS` retain their pre-auth behavior and are **not** protected by this allowlist.

The inspected `bridge-runtime.ts:broadcastSse` already discards missing owner IDs and selects clients by `client.userId === userId`; it has no session delivery filter. Without modifying that file, the SSE subscription's live `enqueue` accepts only complete JSON SSE frames whose `properties.sessionID` matches the authorized persisted session, dropping absent/malformed/mismatched session context. Owner identity on live frames remains enforced by that existing broadcaster, not inferred from event payloads. Replay uses durable `ownerId`/`sessionId` metadata. Connected counts are session-filtered for gateway session subscriptions; subscription-generated reset/connected/heartbeat control frames bypass the data-frame filter. Unscoped gateway credentials without a requested session retain owner-wide `events` subscriptions. Credentials with only project/agent scope still require an owned session, and subscribe only to that session rather than all project/agent sessions.

Bounded to 60 seconds, from `@webui`:

```sh
bun x --no-install vitest run server/tests/gateway-bridge-scoped.test.ts server/tests/gateway-parity-progress.test.ts server/tests/new-session-route.test.ts
bun run --bun tsc --noEmit -p tsconfig.bridge.json
bun run --bun tsc --noEmit --strict --noUnusedLocals --noUnusedParameters --skipLibCheck --module preserve --moduleResolution bundler --target ES2022 --allowImportingTsExtensions --types node server/tests/gateway-bridge-scoped.test.ts
```

Closure rerun: **83 tests across 3 suites passed**, including **41 new scoped bridge tests**; full bridge typecheck and targeted strict typecheck **passed**. The first closure typecheck caught new-test tuple/JSON typing errors; these were fixed before the successful rerun. The Vitest invocation also named `server/voice/routes.spec.ts`, but repository discovery did not select that file; no pass is claimed for it. Scoped `git diff --check` emitted no whitespace diagnostics for the owned tracked files. The new untracked test was checked with `git diff --no-index --check /dev/null ...`: no whitespace diagnostics; exit 1 denotes the new-file difference, not a whitespace finding.

Coverage includes denied unrelated/malformed method/path combinations, no cookie downgrade, preserved user/internal tool identity, supported approval dispatch, scoped voice composition denial/success, cross-user SSE session denial, every missing/mismatched scope dimension, missing events permission, disabled/unavailable agent context, exact persisted project/session/resolved-agent checks, replay owner/session filtering, malformed/unscoped live-frame rejection, accepted exact-session delivery, unscoped owner-wide subscriptions, and stream cleanup.

No live PocketBase schema, migrations, deployed SSE behavior, credential deployment, voice backend, or durable multi-process approval guarantees are claimed verified. All new tests use synthetic credentials and local stubs; the runtime broadcaster was inspected, not executed by these tests. Handoffs 3/4/6/7/8 remain outside these closures; handoff 5 is closed below.

## Handoff 5: discovery closure and verification

This closure edits only list/search/describe handling in `@webui/server/routes/tools.ts`, `searchToolsForAgent` in `@webui/server/application/tools/tools.ts`, related `gateway-parity-progress.test.ts` tests, and progress paragraphs here and in `progress-integrations-routing.md` #1. Prior work is preserved; execution, continuation, legacy approval handling, bridge composition, and other agents' tests remain unchanged.

The parity suite now has **49 tests**. New regressions invoke real discovery/policy/search functions over in-memory records for durable `none`, default-permission semantics, effective-context candidates absent from baseline search under session `allow_all`, project/agent capability ceilings, ranking before the full 12-result cap, and standard on-demand exclusion versus explicit list/describe. Boundary tests cover actual resolved agent and project authorization instead of hints/stored profile IDs, and legacy scoped credentials' approvals permission checks.

Commands from `@webui`, each bounded to 60 seconds:

```sh
bun x --no-install vitest run server/tests/gateway-parity-progress.test.ts server/tests/integrations-routing-progress.test.ts src/api/integrations-routing-progress.test.ts server/tests/tool-routing.test.ts server/tests/approval-flow.test.ts server/tests/approval-event.test.ts server/tests/approval-execution.test.ts server/tests/security-redaction.test.ts
bun test server/tests/gateway-credentials.test.ts server/tests/mcp-adapter.test.ts server/tests/mcp-registry.test.ts
bun run --bun tsc --noEmit -p tsconfig.bridge.json
```

Results: **89 Vitest tests across 8 files passed**, **11 Bun tests across 3 files passed**, full bridge typecheck **passed**. Scoped tracked-file `git diff --check` and the untracked parity test's `git diff --no-index --check /dev/null ...` emitted no whitespace diagnostics (no-index exit 1 denotes the new-file difference). An additional targeted strict check using the earlier `--types node` command failed solely in imported `server/core/network-policy.ts:299`: `Uint8Array<ArrayBufferLike>` is incompatible with Node-only `RequestInit.body`. That out-of-scope file was not changed; the project bridge configuration passed. No live API/provider/persistence calls were made.

The additional broader run of `gateway-parity-progress`, `gateway-bridge-scoped`, both `integrations-routing-progress` suites and `tool-routing` returned **112 passed / 1 failed**. `gateway-bridge-scoped.test.ts`'s supported-discovery fixture lacks `resolveToolSessionContext`; error reporting then calls its also-missing `redactedDiagnostic`. Its credential/assertion also expect persisted `agent-id`, whereas real resolution yields agent name `worker`. That fixture's owner must provide the resolver and authorize/assert the resolved name. This out-of-scope test was not changed, and no passing claim is made for that broader run.
