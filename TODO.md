# Subpolar Implementation TODO

## Pi Durable migration branch progress (2026-10-08)

Branch: `pi-durable` (created from clean `main` at `339d6e0`). This section records work for the requested modular architecture, shared API client, remote test CLI, and Pi Durable migration; the historic roadmap/checkpoint below is retained as prior project context and is not evidence that these new acceptance criteria are complete.

- [x] Audited current package boundaries, `docs/ARCHITECTURE.md`, and historical `fcf4137`; found package manifest/source-name drift and a 1,768-line bridge composition module.
- [x] Read the latest `@earendil-works/pi-durable` documentation and examples. Current documented latest is 1.1.0; the package is experimental, requires a single storage owner, and does not provide exactly-once external effects or a transcript importer.
- [x] Added initial `@subpolar/client` for existing authenticated HTTP routes and owner-scoped SSE, with request/error types and focused tests.
- [x] Added initial `@subpolar/test-cli` using `@subpolar/client`, defaulting to `http://localhost:4173`, with user bearer auth, JSON/JSONL output, stable request IDs, timeout, session operations, approvals, tools/policies, settings, and worktree creation. This is an interactive development client, not a scenario runner.
- [x] Migrate ordinary WebUI project list/get reads and repository metadata reads through `@subpolar/client` while preserving General Chat's compatibility route and auth-generation-aware transport.
- [ ] Expand API/CLI coverage and verify each operation against a running authenticated server. Current gaps include CLI sign-in/token persistence, approval history inspection, WebUI WebSocket parity, and live reconnect behavior.
- [x] Added an opt-in, development-only one-shot API-admin-user token issuance endpoint for Docker local debugging; token is logged only and not returned. Fixed the in-process concurrent-issuance race and added regression coverage. The token is a standard application user token, not a PocketBase superuser or internal bridge credential. After live debugging, rotated the application user's password through the normal authenticated API, updated `.env` without printing secrets, and confirmed the prior bearer was rejected; dev-token opt-in remains false in `.env`.
- [x] Legacy-path live verification through `subpolar-test-cli`: a prior `research` session executed `web_search` and exposed the tool result through the legacy transcript/API; this did not prove Durable execution.
- [x] Durable live verification through the public `subpolar-test-cli` API in Docker: created `research` sessions and completed prompts with actual `web_search`/`web_fetch` gateway tasks in owner/session SQLite. Provider-safe Durable names map back to original Subpolar tool IDs. Fixed the SSE session-ID compatibility mapping; live `--follow` received committed progress and tool events. Durable messages/tool results now project into the owner-scoped `session_transcripts` store, `sessions messages`, and tool-call inspection with stable IDs and legacy entries preserved. A live CLI check retrieved the tool call and result. Existing-session migration, compaction/branch parity, and restart-safe transcript projection remain open.
- [x] Same-process approval continuation was exercised through Docker and the public CLI with a session-level `ask` override: pending `web.search` approvals were decided through `subpolar-test-cli approvals decision`, and the Durable task resumed through the original gateway call identity. A long multi-approval run exceeded the CLI's 180-second request timeout before all pending approvals were decided; approvals remained available and the session transcript completed after decisions. Restart-safe approval continuation remains open.
- [x] Fixed the owner-scoped session-message route's `ownerId` temporal-dead-zone error found by the CLI live test; added a route regression test.
- [x] Apply authenticated-user `sessionId` ownership validation and filtering to SSE replay/live frames; previously that query parameter was only honored for gateway credentials. Added replay and live-frame regression coverage and verified a live session-scoped event via the CLI.
- [x] Restore CLI/client per-tool-call inspection through the existing owner-scoped `GET /api/sessions/{sessionId}/tool-calls/{callId}` route, correlating assistant call arguments with tool results; package tests and live CLI inspection pass.
- [ ] Persist General Chat workspaces/transcripts independently of the replaceable agent container. A Compose container recreation removed a just-created session workspace; the server correctly rejected a subsequent prompt as read-only. PocketBase session metadata alone does not preserve the Pi SDK workspace/transcript.
- [ ] Add isolated real-server integration coverage with deterministic model support, user isolation, tool-policy/approval behavior, cancellation, and server restart/recovery. Current CLI tests are package-level mocked transport tests; live E2E remains opt-in and no restart recovery is verified.
- [ ] Establish target package exports and dependency boundaries while preserving compatible existing package names; the current contracts canonical-name repair and Durable adapter spike are only partial architecture restoration.
- [x] Production Durable composition uses a per-owner/session engine and owner-scoped provider runtime; it does not capture one user's runtime globally. The adapter rejects mismatched owner/session/request/run identity and has deterministic owner-scoped inference coverage. Single-process SQLite ownership and cross-process coordination remain deployment constraints.
- [ ] Fully align Pi AI runtime instances across the WebUI/server (`1.0.2`) and Durable adapter (`1.1.x`, Durable `1.1.0`). A forced override was tried and reverted because it introduced additional provider errors. The adapter now isolates one localized cast at the Harness boundary; deterministic owner-scoped inference tests and the Docker-backed live Durable run pass. Do not widen this cast or claim all providers are compatible without coverage.
- [ ] Extract bridge composition/domain responsibilities into packages and verify WebUI uses the shared HTTP/streaming client exclusively. A first project-read slice now uses the shared client, but the WebUI still has many direct API calls and the bridge remains large.
- [x] Define an initial internal agent-engine/`StatelessExecutor` seam and an experimental Pi Durable adapter backed by single-process SQLite. Added an isolated faux-model tool invocation/result round-trip test through the injected Subpolar tool invoker; resolve provider credential/model/profile/approval integration, gateway binding recovery, event projection, and replay classifications before production wiring.
- [x] Reject Durable submissions when owner/session/request/run identifiers disagree with the trusted `RuntimeExecution`, before binding an invoker or queuing work; adapter regression test passes.
- [x] Add a package-level smoke test that opens the Durable Harness with Subpolar's account-scoped provider runtime and verifies account-qualified provider IDs and per-owner credential-store reads. This does not test model inference or recover a server run.
- [x] Add typed `@subpolar/client` and `subpolar-test-cli repository status PROJECT_ID` operation against the existing authenticated route; client/CLI package tests pass.
- [ ] Build and test transcript migration preserving tool calls, compaction and existing session access; retain the legacy executor until parity and recovery pass.
- [ ] Add explicit restart recovery, session reattachment, committed event projection, and interrupted-side-effect tests before execution cutover.
- [ ] Reconcile `runtime_runs`, `subpolar_runs`/`subpolar_run_events`, and `durable_events` with Pi Durable submission identity and status; current adapter `recover()` is only lookup plumbing and does not reattach a server run.
- [ ] Replace the adapter's in-memory request-to-tool-invoker binding with a restart-safe, owner/session/request-resolved gateway capability. Durable must never resume an external tool call without revalidating current authorization; tools remain `replay: "unsafe"` until each operation's replay semantics are proven.
- [ ] Resolve canonical transcript integration/migration before cutover. Durable conversation state is currently separate from `session_transcripts`; preserve old session access and test assistant tool calls/results, compaction, and idempotent retries.
- [ ] Complete Durable terminal status, model/tool error, shutdown, and recovery projection in the existing Subpolar run/API/SSE contracts. Current-run committed events and live cancellation now flow through existing owner-scoped runtime/API paths; Docker-backed CLI confirmed tool events and an interrupted exit. Restart reattachment and interruption-during-side-effect safety remain unverified.

## Pi Durable production wiring plan

Active directive for this test branch: all canonical HTTP prompt execution uses Pi Durable, with no legacy prompt-execution fallback; when Durable composition is unavailable, the route fails closed. `PiSdkSession` remains only for compatibility RPC, WebSocket, and legacy history/session paths. This forced test cutover is not a production-readiness claim: restart reattachment, legacy transcript migration/compaction parity, shutdown/restart cancellation, and approval continuation remain incomplete. Pi Durable SQLite is single-server/single-storage-owner only. Never claim distributed safety or exactly-once external effects.

### Phase 1 — Confirm dependency and storage contracts
- [x] Read the pinned Pi Durable 1.1.0 docs/API and verify the current `Harness`, submission, task, and SQLite adapter calls against the installed package.
- [ ] Fully align server (`pi-ai`/`pi-coding-agent` 1.0.2) and Durable (`pi-ai` 1.1.x / Durable 1.1.0) runtime instances. A single cast remains at the adapter Harness boundary because duplicated workspace packages brand `TranscriptContext`; deterministic owner-scoped inference, thinking forwarding, server typechecks, and build pass. A broad override was reverted after introducing unrelated provider type errors; do not widen the cast without a verified dependency alignment.
- [ ] Specify durable DB location, backup/restore, permissions, retention, and container persistence. Mount/persist the DB outside replaceable container layers; do not reset PocketBase data or existing volumes.
- [ ] Decide and document a single-server storage ownership model. Reject a second process/owner of the same SQLite database or require explicit external coordination before multi-process deployment.
- **Exit gate:** provider account runtime implements the exact Pi Durable `Models` contract in the running application; credentials remain outside Durable documents/database; storage survives supported container/server restarts.

### Phase 2 — Owner-scoped engine lifecycle and session configuration
- [x] Add Durable submission identity validation for owner, session, request, and run before submit/binding.
- [x] Initial owner/session-scoped engine composition exists at server runtime: each run uses a provider runtime resolved for the authenticated owner and a SQLite path derived from owner/session; no process-global engine captures one user's provider runtime. This is a per-run manager, not an optimized pooled lifecycle.
- [ ] Complete and stress-test isolation/lifecycle: current single-process design hashes owner/session into SQLite paths and serializes runs by owner/session; define/test failed-init cleanup, shutdown, storage eviction/retention and reject/coordinate a second server process.
- [x] Validate model selection from trusted persisted session/agent configuration; resolve provider account ownership, selected model, thinking level, profile/system prompt/skills, cwd and permission context before configuring the Durable conversation. The model suffix takes precedence over the agent thinking level; thinking is passed through Pi Durable `thinkingLevel` and faux inference coverage verifies provider reasoning options.
- [ ] Keep provider tokens and account credentials in the existing owner-bound provider service. Never serialize credentials, auth headers, provider runtime objects, or secrets into Durable state/logs.
- [ ] Add multi-user tests where identical provider/account/model IDs resolve to different credentials and cannot cross-route; include missing/revoked account and model errors.
- **Exit gate:** two owners can execute concurrently with identical provider/model IDs and remain isolated; one owner's session cannot configure or recover another owner's Durable conversation.

### Phase 3 — Tool and approval gateway parity
- [ ] Convert the authorized Subpolar tool catalog and JSON schemas to Pi Durable tool definitions without installing unrestricted Pi built-ins or bypassing the central gateway.
- [ ] Preserve current effective agent/profile/project tool visibility, schema validation, current-policy checks, deny/allow/approval decisions, auditing, redaction, and idempotency keys.
- [ ] Replace the adapter's in-memory conversation-to-invoker binding with a restart-safe resolver using trusted owner/session/request/run identifiers. Resolve the gateway from current server records at invocation time; do not persist executable capabilities or trust model-supplied identity fields.
- [ ] After recovery, fail closed if owner, session, run, tool policy, or request cannot be revalidated. Keep tools `replay: "unsafe"` unless a tool-specific test proves safe retry/idempotency; record interrupted side effects for operator inspection rather than re-running blindly.
- [ ] Complete restart-safe approval continuation. Same-process Durable pause/resume now uses the existing authenticated approval decision route and stable `tool-call:${callId}` idempotency key; deterministic tests cover approval and the decision-before-wait race, and a Docker CLI session completed after authenticated approval decisions. After restart, no Durable request/tool binding is restored, so the original invocation cannot currently resume safely. A multi-approval CLI send exceeded its request timeout before all pending approvals were decided.
- [ ] Complete the tool-policy/recovery matrix for revoked permissions, invalid schemas, tool failures, duplicate requests, process interruption before/during/after side effects, and restart behavior. Deterministic adapter tests now cover allowed round-trip, denied/unregistered tools, approval approved/rejected/expired, notification-before-wait race, abort during approval, stable call identity, and unsafe replay classification.
- **Exit gate:** every Durable tool invocation crosses the same Subpolar gateway as legacy execution; recovered work never invokes a tool without current authorization.

### Phase 4 — Canonical transcript and existing-session migration
- [ ] Define one canonical Subpolar transcript projection and reconcile it with Durable conversation history. Preserve assistant tool calls and arguments, tool results/errors, ordering, IDs, usage/thinking metadata, and compaction/branch markers.
- [ ] Implement an idempotent migration/import path for existing `session_transcripts`; keep the original records readable and preserve all existing sessions. Do not silently replace or truncate history.
- [ ] Prevent duplicate user/assistant messages when a stable request ID is retried or a submission is recovered. Define which system/profile prompt versions are stored in Durable versus rebuilt from current trusted configuration.
- [ ] Verify existing sessions can be inspected and continued after migration, including complex transcripts with tool calls and compacted history; document rollback and migration versioning.
- **Exit gate:** fixture-based legacy-to-Durable transcript tests pass for plain, tool, error, compaction and retry cases, with byte/semantic assertions and no lost old-session access.

### Phase 5 — Runs, committed events, cancellation and recovery
- [ ] Reconcile `runtime_runs`, `subpolar_runs`, `subpolar_run_events`, `durable_events`, and Durable submission/task IDs. Define a single mapping and legal status transitions for queued/running/approval/interrupted/completed/failed/cancelled.
- [ ] Complete projection of Durable committed text/thinking/tool/status/error events into existing owner/session-scoped HTTP/SSE/WebSocket contracts with replay cursors, redaction, stable correlation IDs, and no cross-session leakage. Current live SSE now receives committed progress/tool events after mapping `sessionId` to the legacy `sessionID` filter. Replay after restart, transcript parity, and sensitive-field review remain open; the adapter omits snapshots and system-message entries.
- [ ] Implement server startup reconciliation and run reattachment: identify active Subpolar runs, resolve their Durable submissions, restore trusted runtime/gateway context, and settle/report runs that cannot safely resume.
- [ ] Complete cancellation and shutdown through the server lifecycle; the existing authenticated session abort route now aborts active in-process Durable runs, and a Docker-backed CLI test produced an interrupted delivery with a nonzero CLI exit. Cancellation races, interrupted model/tool side effects, and restart-time cancellation/reconciliation remain open. Ensure observers can reconnect and replay without duplicate or missing committed events.
- [ ] Test duplicate POSTs/stable request IDs, process restart during model work, restart during tool execution/approval, unknown submissions, terminal results, and persistence failure handling.
- **Exit gate:** an external harness can restart the Docker development server and the CLI can inspect/reconnect to the same run with correct status, transcript, events, errors and safe side-effect semantics.

### Phase 6 — Real-server test CLI and parity matrix
- [ ] Use `subpolar-test-cli` and `@subpolar/client` only through public authenticated API/SSE operations; do not add a CLI-specific execution path or public lifecycle/admin endpoint.
- [ ] Exercise create/send/inspect/messages/events/errors/abort, agents/models/projects/settings, tools and approvals against a running Compose stack using isolated normal user accounts and temporary projects.
- [ ] Add deterministic mock-model integration via a real server/provider interface for repeatable tests; keep optional real-provider smoke tests separate and secret-safe.
- [ ] Verify agent/model/thinking/profile/skills/worktree selection, web-search authorization, owner/session isolation, SSE reconnect/replay, idempotency, denial/approval continuation, model/tool failures, cancellation, container restart recovery and legacy-session access.
- [ ] Keep test data isolated; never print tokens or secret logs, use PocketBase superuser credentials as client auth, or reset/delete existing volumes/data.
- **Exit gate:** repeatable Docker-backed integration suite and manual CLI parity checklist pass; test CLI provides enough diagnostics to distinguish server, model, tool, approval and recovery failures.

### Phase 7 — Modular composition and WebUI/client parity
- [ ] Extract provider/engine lifecycle, run/status projection, transcript mapping, and transport composition from `bridge-runtime.ts` into appropriate application/server/adapter packages; keep the bridge as HTTP/WebSocket composition and transport.
- [ ] Ensure core/contracts remain free of React, Hono, PocketBase and Pi implementation imports; use the existing `@subpolar/*` scope and preserve compatible package names.
- [ ] Move WebUI session/model/project/tool/approval/history/event operations to `@subpolar/client` over the same authenticated HTTP/stream interfaces used by the test CLI. Remove direct or alternate execution pathways only after route/client parity tests pass.
- **Exit gate:** dependency-boundary checks, server/client tests, WebUI tests and API parity tests pass; both WebUI and CLI reach agent execution only through the server.

### Phase 8 — Controlled cutover and legacy retirement
- [ ] Add a server-side development/test feature switch for Durable composition. The switch selects an executor behind the existing `/sessions/:id/runs` API; it must not bypass auth, policy, approvals, or run persistence.
- [ ] Run legacy and Durable parity fixtures against identical deterministic scenarios; compare response shape, transcript, tools/audits, event order, cancellation, errors and recovery.
- [ ] Enable Durable by default only after all prior exit gates pass and a rollback procedure is verified. Keep legacy Pi execution available during the rollout; do not dual-execute prompts or side effects.
- [ ] Remove `PiSdkSession` and redundant transient execution code only after production-style Docker restart/recovery and live CLI acceptance tests pass. Update architecture docs and this TODO with verified limitations and deployment requirements.
- **Final acceptance:** Pi Durable executes real Subpolar agent sessions through the public server API; owner-scoped providers/tools, existing session history, approvals, event replay, cancellation and supported restart recovery all pass. No distributed or exactly-once guarantees are claimed beyond tested coordination/idempotency.

Validation checkpoint (2026-10-08): root typechecks passed; `test:server` passed 474 tests across 48 files; `test:core` passed 139 tests; production build passed with existing Zod annotation/chunk-size warnings; focused client, CLI, Durable-adapter, session-route, SSE-route, and WebUI repository-read tests passed. The live Compose-backed test used the legacy Pi runtime and confirmed `web.search` execution; it does **not** prove Durable production execution or restart recovery.

Known migration constraints from the Durable documentation: SQLite storage is single-server and single-owner; no multi-process safety is claimed. Tool replay is unsafe by default and only repeats explicitly safe tools; effects may have occurred before a crash checkpoint. Durable APIs are experimental and storage/projection compatibility must be pinned and tested. Do not route around the Subpolar tool gateway or expose administrator credentials.

## Orchestration Status

Current phase: Phase 0-16 implementation checkpoint
Current milestone: Milestone E - Tool Gateway Clients and Operations
Current branch: feature/session-worktree-review
Last completed commit: feature-scoped integration commits on `feature/session-worktree-review`
Last verified commit: committed feature work plus current documentation follow-up; see docs/feature-progress.md for validation and remaining gates
Current blockers: authenticated live E2E is unavailable; legacy bridge execution ownership and durable active-run recovery remain; atomic skill/automation persistence, policy-aware remote Git fetch, MCP lifecycle endpoints, notification delivery/navigation, and actual SSH/Jev execution remain follow-up work
Next recommended action: finish the request-scoped bridge runtime/approval binding and atomic persistence gates, then run authenticated disposable E2E; see docs/feature-progress.md for per-feature handoffs

## Architecture Decisions

- Pi remains the only execution engine; Subpolar owns identity, policy, approvals, audit, sessions, and events.
- Core contracts and policy services must not import PocketBase, Hono routes, React, or CLI modules.
- The first extraction slice is the tool policy/approval/audit decision path because it is already centralized and is shared by Pi routing and HTTP callers.
- `subpolar-cli` will use the same core in-process with an ephemeral local adapter by default; explicit local persistence is opt-in.
- The tools CLI will remain a remote authenticated gateway client and will not embed Pi or the core runtime.
- Security fixes precede new capability work: ownership, path boundaries, SSRF controls, redaction, approval state transitions, and XSS safety are release gates.
- Existing Subpolar Agent behavior is preserved unless it conflicts with the revised roadmap; compatibility routes remain adapters, not new authorities.

## Phase Progress

### Phase 0A - Core Extraction and Persistence Adapter Architecture

Status: IMPLEMENTED WITH INTEGRATION FOLLOW-UPS

Requirements:
- [x] P0A-001 Define persistence-neutral contracts for identity, tool calls, policy, approvals, audit, events, and adapter capabilities (bounded initial contract set).
- [x] P0A-002 Implement shared policy/approval decision primitives without PocketBase imports.
- [x] P0A-003 Add local/ephemeral adapter and explicit unsupported-durability errors.
- [x] P0A-004 Add minimal `subpolar-cli run` using the shared core in-process.
- [x] P0A-005 Define PocketBase composition seam and parity fixtures (package-level fake-client parity; Subpolar Agent wiring remains open).
- [x] P0A-006 Add an injected run/executor seam with explicit non-recoverable cancellation semantics; durable Subpolar Agent run recovery remains open.

Implementation tasks:
- [ ] P0A-001 Create `packages/subpolar-contracts` package and tests.
- [ ] P0A-002 Create `packages/subpolar-core` policy gateway and tests.
- [ ] P0A-003 Create `packages/subpolar-persistance-local` ephemeral store.
- [ ] P0A-004 Create `packages/subpolar-cli` command surface and JSON output.
- [x] P0A-005 Add root test/typecheck scripts and package documentation.

Verification:
- [ ] Unit tests for policy precedence, approval decisions, redaction, and unsupported capabilities.
- [x] Identical fixture decisions through local and PocketBase compositions (package/fake-client scope).
- [x] CLI starts with PocketBase, Subpolar Agent, HTTP, and Docker unavailable (fixture executor scope).
- [x] Independent architecture verification for the bounded slice.

Commits:
- bfe4ee5 — feat(core): add shared foundation and security contracts (bounded checkpoint)
- f2c19bc — feat(core): add run seam and PocketBase adapter foundation

Remaining problems:
- Current bridge still owns Pi lifecycle and process-global state.
- Current tool implementation is PocketBase-bound and remains the Subpolar Agent authority until migrated.
- Pi-backed executor composition and a concrete PocketBase adapter are still required for the Phase 0A exit criteria.
- Package-level run seam and PocketBase adapter now exist, but Subpolar Agent still uses its legacy bridge lifecycle and the CLI still uses the explicit fixture executor.

### Phase 0 - Contracts, Runtime, Security, and Recovery

Status: IMPLEMENTED WITH RUNTIME RECOVERY FOLLOW-UP

Requirements:
- [x] P0-001 Stable versioned Subpolar error/capability/health contracts (initial v1 discovery/health slice).
- [x] P0-002 Request IDs and bounded request bodies/rate limits (initial bridge security slice).
- [x] P0-003 Session ownership isolation for SSE/status/search/extension routes (covered paths).
- [x] P0-004 Realpath/symlink-safe project filesystem boundaries.
- [x] P0-005 SSRF, redirect, timeout, response-size, and credential-leak protections (DNS-pinned outbound path and trusted host policy).
- [x] P0-006 Approval routes use validated, leased, fail-closed transitions and idempotent continuation.
- [x] P0-007 Redact sensitive tool inputs/results from audits, history, SSE, and errors.
- [x] P0-008 XSS-safe Markdown, HTML, Mermaid, diff, and tool rendering (focused tests).
- [ ] P0-009 Durable run/queue/event/recovery model (queue/event portions implemented; cross-restart Pi run recovery remains).

Implementation tasks:
- [ ] P0-010 Add request security/network policy modules and tests.
- [ ] P0-011 Harden bridge ownership and origin checks.
- [ ] P0-012 Wire approval service into HTTP routes.
- [ ] P0-013 Add security regression tests.

Verification:
- [ ] Server security/unit tests.
- [ ] Cross-user and symlink/SSRF regression tests.
- [ ] Independent security review.

Commits:
- bfe4ee5 — feat(core): add shared foundation and security contracts (security/contract slice)

### Phase 1-3 - Subpolar Agent, Personalization, Git, and Review

Status: IMPLEMENTED WITH LIVE UI FOLLOW-UPS

Requirements:
- [ ] P1-001 Reliable runtime/session states, cursor replay, lifecycle, routing, queue, attachments, commands, handoff, suggestions (pagination and command routing implemented; runtime restart recovery and assistant suggestions remain).
- [ ] P2-001 Theme tokens, reduced motion, command palette, shortcuts, recent/pinned state, density and mobile behavior.
- [ ] P3-001 Repository/worktree service, Changes surface, checkpoints, anchored conversation branching.

Implementation tasks:
- [x] Fix canonical `/new` routes and immediate first-send semantics (focused route/delivery verification).
- [x] Implement durable first-send delivery/idempotency and interrupted retry/discard state; queue/steering remains open.
- [ ] Connect project workspace and repository service to routed UI.
- [ ] Add Changes/review/checkpoint flows.

Verification:
- [ ] Component/contract tests.
- [ ] Browser E2E against isolated deployment.

### Phase 4-6 - Tasks, Agents, and Capability Context

Status: IMPLEMENTED WITH PRODUCT-SURFACE FOLLOW-UPS

Requirements:
- [ ] P4-001 Durable tasks, `subagent/run`, isolated worktrees, review inbox, non-escalation.
- [ ] P5-001 Validated agent CRUD, templates, effective configuration, Plan (Coding), Reviewer.
- [ ] P6-001 Independent tool and skill context modes with discovery/audit.

### Phase 7-9 - Memory, Browser, and Voice

Status: IMPLEMENTED WITH LIVE-RUNTIME FOLLOW-UPS

Requirements:
- [ ] P7-001 Memory off by default, scoped authorized audited tools.
- [ ] P8-001 Owned browser sessions/tools, policy, approvals, limits, audit.
- [ ] P9-001 Local STT/TTS backend abstractions using normal sessions and approvals.

### Phase 10-13 - Integrations, Skills, Automations, Notifications

Status: IMPLEMENTED WITH SUBPOLAR_AGENT CONTEXT FOLLOW-UPS

Requirements:
- [ ] P10-001 Secure MCP/OpenAPI/tool registry operations and context modes.
- [ ] P11-001 Durable scoped/versioned skill management.
- [ ] P12-001 Durable normal-runtime automation scheduling and task integration.
- [ ] P13-001 Authoritative inbox-backed notifications and remote-use hardening.

### Phase 14 - Two Distinct CLIs

Status: IMPLEMENTED WITH LIVE REMOTE VERIFICATION FOLLOW-UP

Requirements:
- [ ] P14-001 `subpolar-cli` standalone headless local composition.
- [ ] P14-002 Stateless-by-default and explicit local session persistence semantics.
- [x] P14-003 Remote-only tools CLI client and command surface (scoped server credential integration remains open).
- [ ] P14-004 Stable human/JSON/JSONL output, approvals, cancellation, and exit codes.

### Phase 15-16 - Operations and E2E Verification

Status: IMPLEMENTED WITH LIVE DEPLOYMENT FOLLOW-UPS

Requirements:
- [ ] P15-001 Versioned migrations, backup/restore, retention, resources, structured diagnostics.
- [x] P16-001 Disposable PocketBase/Subpolar Agent E2E harness and adapter parity suite (contract/parity and opt-in live gate implemented; authenticated live run pending).
- [ ] P16-002 Browser, runtime, CLI, security, subagent/worktree, memory, browser-tool, voice, and container gates (focused gates implemented; full authenticated deployment gate pending).

## Active Subagents

| Agent | Assignment | Branch/Worktree | Status | Expected output |
|---|---|---|---|---|
| audit-core | Phase 0A/0 architecture audit | main read-only | COMPLETE | Evidence-based gap report |
| audit-subpolar-agent | Phase 1-3 Subpolar Agent audit | main read-only | COMPLETE | Lifecycle/UI gap report |
| audit-capabilities | Phase 4-13/security audit | main read-only | COMPLETE | Security and capability gap report |
| audit-cli | Phase 14-16 audit | main read-only | COMPLETE | CLI/verification gap report |
| impl-core | P0A contracts/core/local adapter/CLI smoke path | main isolated file scope | COMPLETE - VERIFIED WITH NOTES | Implemented packages, tests, and limitations |
| impl-security | P0 request/network security primitives and bridge hardening | main serialized bridge/server scope | COMPLETE - VERIFIED WITH NOTES | Security modules, ownership fixes, and regression tests |
| verify-core | Independent P0A/CLI review | main read-only | COMPLETE - FAIL FINDINGS CORRECTED | Initial 17-test review and correction requirements |
| verify-security | Independent P0 security review | main read-only | COMPLETE - FAIL FINDINGS CORRECTED | Initial security review and correction requirements |
| impl-security-followup | DNS, custom-provider, approval, internal ownership fixes | main serialized server scope | COMPLETE - VERIFIED WITH NOTES | Focused security corrections |
| verify-foundation | Reverify corrected core/security slices | main read-only | COMPLETE - VERIFIED WITH NOTES | Focused tests/builds pass; full Subpolar Agent suite remains environment-blocked |
| impl-tools-cli | P14 remote-only tools gateway CLI | main new-package scope | COMPLETE - VERIFIED WITH NOTES | 19 CLI tests/build; server registration credentials remain open |
| impl-contracts | P0 versioned capability/health/error contract | main server-contract scope | COMPLETE - VERIFIED WITH NOTES | v1 contract/health tests; full dependency suite unavailable |
| impl-run-seam | P0A shared run/executor contract and core service | main package scope | COMPLETE - VERIFIED WITH NOTES | 54 aggregate package tests; Pi executor wiring remains open |
| impl-pocketbase-adapter | P0A PocketBase adapter contract/parity fixture | main new-package scope | COMPLETE - VERIFIED WITH NOTES | Owner-scoped adapter/parity tests; Subpolar Agent wiring remains open |
| impl-new-routes | P1 canonical new-session route resolution | main Subpolar Agent routing scope | COMPLETE - VERIFIED WITH NOTES | Focused route/type/build verification |
| impl-first-send | P1 immediate first-send composer flow | main Subpolar Agent composer scope | COMPLETE - VERIFIED WITH NOTES | Immediate send, permission/profile/model persistence |
| fix-delivery-bridge | P1 delivery replay/profile/idempotency corrections | main bridge scope | COMPLETE - VERIFIED WITH NOTES | 81+ server tests, ownership/idempotency/replay checks |
| fix-delivery-ux | P1 interrupted handoff retry UX | main SessionDetail scope | COMPLETE - VERIFIED WITH NOTES | Retry/discard/in-flight tests |
| fix-session-agent-tests | P1 persisted session-agent test/runtime boundary | main session-agent scope | COMPLETE - VERIFIED WITH NOTES | 18 focused hook tests |
| impl-queue | P1 durable steering/follow-up queue controls | main composer/bridge scope | COMPLETE - VERIFIED WITH NOTES | Atomic claims, legal transitions, UI/API tests |
| impl-pi-executor | P0A Pi-backed executor composition | main package scope | COMPLETE - VERIFIED WITH NOTES | 40 package tests; host Pi integration remains open |
| impl-e2e-harness | P16 disposable Subpolar Agent/PocketBase harness | main test-infra scope | COMPLETE - VERIFIED WITH NOTES | Contract smoke/harness scaffolding; live E2E not run |
| impl-cursor-replay | P0 durable event cursor replay/reconnect | main bridge/event scope | COMPLETE - VERIFIED WITH NOTES | Cursor/replay tests; live reconnect E2E not run |
| impl-gateway-credentials | P14 scoped remote gateway credentials | main auth/tools scope | COMPLETE - VERIFIED WITH NOTES | 96 server + 19 CLI tests; live remote auth not run |
| impl-attachments | P1 chat context attachments | main composer/attachment scope | COMPLETE - VERIFIED WITH NOTES | Attachment helper tests, type/build checks; live uploads unverified |
| impl-appearance | P2 themes and productivity foundation | main appearance/navigation scope | COMPLETE - VERIFIED WITH NOTES | Theme/reduced-motion/command palette tests; full dependency suite limited |
| audit-next-roadmap | Re-audit remaining P1/P2/P4-P13 gaps | main read-only | IN PROGRESS | Prioritized next implementation batch |
| impl-agent-context | P5/P6 authoritative profiles and capability context modes | main agent/tools scope | COMPLETE - VERIFIED WITH NOTES | 9 focused server tests; full build limited by unrelated settings errors |
| design-git-service | P3 repository/worktree service design audit | main read-only | COMPLETE | Contracts, dependencies, bounded implementation proposal |
| impl-git-read | P3 read-only Git repository/worktree service | main git server scope | COMPLETE - VERIFIED WITH NOTES | Safe executor, path policy, status/branches/diff/worktrees routes and tests |
| verify-git-read | Independent Git security verification | main read-only | COMPLETE - FINDINGS CORRECTED | Ownership/path/argv/output/parser findings corrected |
| impl-tasks-subagents | P4 durable Tasks/subagent/run/worktree metadata | main task/agent scope | COMPLETE - VERIFIED WITH NOTES | 20 focused tests, ownership/ceiling/approval/worktree checks |
| impl-memory | P7 explicit scoped memory capability | main memory/tool scope | COMPLETE - VERIFIED WITH NOTES | 119 server + 63 package tests; live persistence service unverified |
| impl-browser | P8 owned browser session/read tools foundation | main browser scope | COMPLETE - VERIFIED WITH NOTES | 32 focused tests; live browser engine unavailable |
| impl-voice | P9 local-first STT/TTS backend seam | main voice scope | COMPLETE - VERIFIED WITH NOTES | 12 server + 32 UI voice tests; cloud/voice discovery page scope remains limited |
| impl-automation-inbox | P12/P13 durable automations, inbox, notifications | main automation/control scope | IN PROGRESS | Durable records, leases/retries, inbox source of truth, notification projection/tests |
| audit-integrations-skills | P10/P11 MCP/OpenAPI/skills convergence audit | main read-only | IN PROGRESS | Prioritized secure convergence slices |
| audit-general-capabilities | P7-P13 memory/browser/voice/automation audit | main read-only | IN PROGRESS | Dependency map and independent implementation slices |

## Completed Work

- Initial revised-roadmap audit completed 2026-09-19.
- Existing tool gateway, approval flow, agent runtime, session context, transcript projection, and provider flow tests identified as characterization coverage.
- Added and corrected the dependency-free shared core/local adapter/CLI foundation and the first Subpolar Agent security hardening slice; independent verification is pending.
- Verified bounded checkpoint after independent review: 37 focused server/transcript tests, 36 package tests, 8 Bun-native server tests, 2 frontend security tests, and successful Bun bridge/package builds.
- Checkpoint committed as bfe4ee5 and independently verified with notes.
- Run/adapter checkpoint independently verified: 54 package tests, all entrypoint builds, recovery/ownership/atomicity/redaction probes pass; Subpolar Agent production build remains blocked by existing settings-component type errors.
- f2c19bc committed and verified as the run/adapter checkpoint.
- 8b40180 committed and independently verified as the canonical routing/first-send checkpoint.
- Phase 1 focused checkpoint independently verified: 87 Vitest tests, 81 Bun server tests, bridge/app typechecks, and direct Vite build passed; full build remains blocked by unrelated settings errors.
- Queue/Pi/E2E checkpoint independently verified: 40 package tests, 9 queue/bridge/E2E contract tests, atomic queue corrections, and source/build checks pass; live services unavailable.
- 1b4019a committed and verified as the queue/Pi/E2E checkpoint.
- Cursor/gateway checkpoint independently verified: 27 focused cursor/credential/CLI tests and 37 package tests pass; live service/E2E unavailable.
- Attachment/appearance checkpoint verified: 6 focused tests, bridge build, and diff checks pass; live upload/vision/website and full Subpolar Agent typecheck remain environment-limited.
- df1fd00 committed and verified as the attachment/appearance checkpoint.
- Agent profile/context checkpoint verified: 9 focused server tests and bridge typecheck pass; full Subpolar Agent build remains blocked by unrelated settings errors.
- Git read checkpoint verified: focused Git tests and 101 native server tests pass; bridge/Subpolar Agent typechecks and bridge build pass; mutations intentionally excluded.
- e66da09 committed and verified as the Git read checkpoint.
- Tasks/subagent/worktree checkpoint independently verified: 20 focused tests, bridge typecheck/build, fail-closed capability ceiling, approval resume, ownership, atomic transitions, and custom-root worktree checks pass; live PocketBase unavailable.
- 61f32e1 committed and verified as the Tasks/subagent/worktree checkpoint.
- Memory checkpoint independently verified: 5 focused memory tests, 119 server tests, 63 package tests, typechecks, atomic idempotency/ownership, persistence validation, redaction, and no-injection checks pass.
- Browser checkpoint independently verified: 32 browser/network/gateway/server tests, bridge typecheck, bidirectional scope, byte limits, URL redaction, approval, and unavailable-runtime checks pass; live engine unavailable.
- Voice checkpoint independently verified: 12 server + 32 UI voice tests, UI/bridge typechecks, isolated Vite build, discovery scope, limits/cancellation/redaction pass; cloud runtime remains optional/unwired.
- 8046550 committed and verified as the voice checkpoint.
- 5283da9 committed and verified as the browser checkpoint.
- 9ac0462 committed and verified as the memory checkpoint.
- 1671cb3 committed and verified as the agent profile/context checkpoint.

## Known Bugs

- Subpolar Agent still has legacy process-global session metadata and Pi lifecycle outside the new package run seam; durable cross-process run recovery is not implemented.
- Cursor replay, attachments, and session pagination have focused implementations; assistant suggestions and live reconnect remain incomplete/unverified.
- Live cursor reconnect and scoped gateway credential deployment remain unverified without PocketBase/Subpolar Agent services.
- Git API/UI and several hooks/tests are orphaned.
- The disposable harness and opt-in live gate exist, but authenticated PocketBase/Subpolar Agent/Pi execution has not run in this environment.
- `subpolar-cli` preserves the explicit local fixture default; complete Pi-backed standalone composition remains open.
- Full application test execution must use the configured Vitest/jsdom environment; raw Bun execution of all frontend tests is not a valid substitute.

## Technical Debt

- Session metadata is split between PocketBase, SQLite, Pi JSONL, and process-global maps.
- Existing OpenAPI document describes a compatibility API rather than versioned Subpolar contracts.
- Dynamic PocketBase schema setup is not a migration/rollback system.
- Root and Subpolar Agent manifests lack a normal test script; dependencies are not installed in the current environment.
- Legacy filesystem profile/background extensions remain potential competing authorities.

## Integration Conflicts

- Shared edits to `@subpolar-agent/bridge.ts`, `server/tools.ts`, and `server/pocketbase.ts` must be serialized.
- Core package work must not import current Subpolar Agent server modules; use explicit contracts and composition adapters.
- Security hardening must preserve existing local development startup behavior while making deployment exposure explicit.

## Verification Evidence

- Repository audit subagents completed inspection-only reports on 2026-09-19.
- Git worktree was clean at audit start.
- Automated tests/typechecks could not be executed during audit because installed JS/Bun dependencies were unavailable (`tsc`/Vitest modules missing).
- No roadmap requirement is currently independently verified against a disposable deployment.
- Bounded checkpoint verification after implementation: dependency-free tests/builds pass; full Subpolar Agent Vitest/typecheck/build remains unavailable or has unrelated existing failures.
- Run/adapter checkpoint verification: 54 package tests, all package entrypoint builds, and independent recovery/ownership/atomicity/redaction probes pass.

## Next Actions

1. Centralize Subpolar Agent Pi lifecycle and durable cross-restart run recovery through the extracted run seam.
2. Migrate Subpolar Agent skill routes/context assembly from filesystem authority to the durable skill repository.
3. Run authenticated disposable PocketBase/Subpolar Agent/Pi/browser/voice E2E and close deployment-only findings.
