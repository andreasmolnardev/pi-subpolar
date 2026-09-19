# Subpolar Implementation TODO

## Orchestration Status

Current phase: Phase 0A / Phase 0 foundation
Current milestone: Milestone A - Dependable Subpolar
Current branch: main
Last completed commit: pending — cursor replay and scoped gateway credentials checkpoint
Last verified commit: working tree — cursor/gateway checkpoint independently verified with notes
Current blockers: full WebUI dependencies are unavailable; the local CLI is still a fixture executor rather than Pi-backed; no disposable E2E harness exists; scoped remote gateway credentials are not implemented
Next recommended action: commit the authoritative agent profile/context checkpoint, then implement the bounded Git repository/worktree read service

## Architecture Decisions

- Pi remains the only execution engine; Subpolar owns identity, policy, approvals, audit, sessions, and events.
- Core contracts and policy services must not import PocketBase, Hono routes, React, or CLI modules.
- The first extraction slice is the tool policy/approval/audit decision path because it is already centralized and is shared by Pi routing and HTTP callers.
- `subpolar-cli` will use the same core in-process with an ephemeral local adapter by default; explicit local persistence is opt-in.
- The tools CLI will remain a remote authenticated gateway client and will not embed Pi or the core runtime.
- Security fixes precede new capability work: ownership, path boundaries, SSRF controls, redaction, approval state transitions, and XSS safety are release gates.
- Existing WebUI behavior is preserved unless it conflicts with the revised roadmap; compatibility routes remain adapters, not new authorities.

## Phase Progress

### Phase 0A - Core Extraction and Persistence Adapter Architecture

Status: IN PROGRESS (bounded foundation checkpoint verified)

Requirements:
- [x] P0A-001 Define persistence-neutral contracts for identity, tool calls, policy, approvals, audit, events, and adapter capabilities (bounded initial contract set).
- [x] P0A-002 Implement shared policy/approval decision primitives without PocketBase imports.
- [x] P0A-003 Add local/ephemeral adapter and explicit unsupported-durability errors.
- [x] P0A-004 Add minimal `subpolar-cli run` using the shared core in-process.
- [x] P0A-005 Define PocketBase composition seam and parity fixtures (package-level fake-client parity; WebUI wiring remains open).
- [x] P0A-006 Add an injected run/executor seam with explicit non-recoverable cancellation semantics; durable WebUI run recovery remains open.

Implementation tasks:
- [ ] P0A-001 Create `packages/subpolar-contracts` package and tests.
- [ ] P0A-002 Create `packages/subpolar-core` policy gateway and tests.
- [ ] P0A-003 Create `packages/subpolar-adapter-local` ephemeral store.
- [ ] P0A-004 Create `packages/subpolar-cli` command surface and JSON output.
- [x] P0A-005 Add root test/typecheck scripts and package documentation.

Verification:
- [ ] Unit tests for policy precedence, approval decisions, redaction, and unsupported capabilities.
- [x] Identical fixture decisions through local and PocketBase compositions (package/fake-client scope).
- [x] CLI starts with PocketBase, WebUI, HTTP, and Docker unavailable (fixture executor scope).
- [x] Independent architecture verification for the bounded slice.

Commits:
- bfe4ee5 — feat(core): add shared foundation and security contracts (bounded checkpoint)
- f2c19bc — feat(core): add run seam and PocketBase adapter foundation

Remaining problems:
- Current bridge still owns Pi lifecycle and process-global state.
- Current tool implementation is PocketBase-bound and remains the WebUI authority until migrated.
- Pi-backed executor composition and a concrete PocketBase adapter are still required for the Phase 0A exit criteria.
- Package-level run seam and PocketBase adapter now exist, but WebUI still uses its legacy bridge lifecycle and the CLI still uses the explicit fixture executor.

### Phase 0 - Contracts, Runtime, Security, and Recovery

Status: IN PROGRESS

Requirements:
- [x] P0-001 Stable versioned Subpolar error/capability/health contracts (initial v1 discovery/health slice).
- [x] P0-002 Request IDs and bounded request bodies/rate limits (initial bridge security slice).
- [x] P0-003 Session ownership isolation for SSE/status/search/extension routes (covered paths).
- [x] P0-004 Realpath/symlink-safe project filesystem boundaries.
- [x] P0-005 SSRF, redirect, timeout, response-size, and credential-leak protections (DNS-pinned outbound path and trusted host policy).
- [x] P0-006 Approval routes use validated, leased, fail-closed transitions and idempotent continuation.
- [x] P0-007 Redact sensitive tool inputs/results from audits, history, SSE, and errors.
- [x] P0-008 XSS-safe Markdown, HTML, Mermaid, diff, and tool rendering (focused tests).
- [ ] P0-009 Durable run/queue/event/recovery model.

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

### Phase 1-3 - WebUI, Personalization, Git, and Review

Status: IN PROGRESS (canonical routing and first-send checkpoint verified; broader P1 remains)

Requirements:
- [ ] P1-001 Reliable runtime/session states, cursor replay, lifecycle, routing, queue, attachments, commands, handoff, suggestions.
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

Status: NOT STARTED (agent CRUD/tool gateway foundations are partial)

Requirements:
- [ ] P4-001 Durable tasks, `subagent/run`, isolated worktrees, review inbox, non-escalation.
- [ ] P5-001 Validated agent CRUD, templates, effective configuration, Plan (Coding), Reviewer.
- [ ] P6-001 Independent tool and skill context modes with discovery/audit.

### Phase 7-9 - Memory, Browser, and Voice

Status: NOT STARTED

Requirements:
- [ ] P7-001 Memory off by default, scoped authorized audited tools.
- [ ] P8-001 Owned browser sessions/tools, policy, approvals, limits, audit.
- [ ] P9-001 Local STT/TTS backend abstractions using normal sessions and approvals.

### Phase 10-13 - Integrations, Skills, Automations, Notifications

Status: NOT STARTED (partial OpenAPI/MCP/client UI exists)

Requirements:
- [ ] P10-001 Secure MCP/OpenAPI/tool registry operations and context modes.
- [ ] P11-001 Durable scoped/versioned skill management.
- [ ] P12-001 Durable normal-runtime automation scheduling and task integration.
- [ ] P13-001 Authoritative inbox-backed notifications and remote-use hardening.

### Phase 14 - Two Distinct CLIs

Status: IN PROGRESS (remote-only client implemented; server credential integration open)

Requirements:
- [ ] P14-001 `subpolar-cli` standalone headless local composition.
- [ ] P14-002 Stateless-by-default and explicit local session persistence semantics.
- [x] P14-003 Remote-only tools CLI client and command surface (scoped server credential integration remains open).
- [ ] P14-004 Stable human/JSON/JSONL output, approvals, cancellation, and exit codes.

### Phase 15-16 - Operations and E2E Verification

Status: NOT STARTED

Requirements:
- [ ] P15-001 Versioned migrations, backup/restore, retention, resources, structured diagnostics.
- [ ] P16-001 Disposable PocketBase/WebUI E2E harness and adapter parity suite.
- [ ] P16-002 Browser, runtime, CLI, security, subagent/worktree, memory, browser-tool, voice, and container gates.

## Active Subagents

| Agent | Assignment | Branch/Worktree | Status | Expected output |
|---|---|---|---|---|
| audit-core | Phase 0A/0 architecture audit | main read-only | COMPLETE | Evidence-based gap report |
| audit-webui | Phase 1-3 WebUI audit | main read-only | COMPLETE | Lifecycle/UI gap report |
| audit-capabilities | Phase 4-13/security audit | main read-only | COMPLETE | Security and capability gap report |
| audit-cli | Phase 14-16 audit | main read-only | COMPLETE | CLI/verification gap report |
| impl-core | P0A contracts/core/local adapter/CLI smoke path | main isolated file scope | COMPLETE - VERIFIED WITH NOTES | Implemented packages, tests, and limitations |
| impl-security | P0 request/network security primitives and bridge hardening | main serialized bridge/server scope | COMPLETE - VERIFIED WITH NOTES | Security modules, ownership fixes, and regression tests |
| verify-core | Independent P0A/CLI review | main read-only | COMPLETE - FAIL FINDINGS CORRECTED | Initial 17-test review and correction requirements |
| verify-security | Independent P0 security review | main read-only | COMPLETE - FAIL FINDINGS CORRECTED | Initial security review and correction requirements |
| impl-security-followup | DNS, custom-provider, approval, internal ownership fixes | main serialized server scope | COMPLETE - VERIFIED WITH NOTES | Focused security corrections |
| verify-foundation | Reverify corrected core/security slices | main read-only | COMPLETE - VERIFIED WITH NOTES | Focused tests/builds pass; full WebUI suite remains environment-blocked |
| impl-tools-cli | P14 remote-only tools gateway CLI | main new-package scope | COMPLETE - VERIFIED WITH NOTES | 19 CLI tests/build; server registration credentials remain open |
| impl-contracts | P0 versioned capability/health/error contract | main server-contract scope | COMPLETE - VERIFIED WITH NOTES | v1 contract/health tests; full dependency suite unavailable |
| impl-run-seam | P0A shared run/executor contract and core service | main package scope | COMPLETE - VERIFIED WITH NOTES | 54 aggregate package tests; Pi executor wiring remains open |
| impl-pocketbase-adapter | P0A PocketBase adapter contract/parity fixture | main new-package scope | COMPLETE - VERIFIED WITH NOTES | Owner-scoped adapter/parity tests; WebUI wiring remains open |
| impl-new-routes | P1 canonical new-session route resolution | main WebUI routing scope | COMPLETE - VERIFIED WITH NOTES | Focused route/type/build verification |
| impl-first-send | P1 immediate first-send composer flow | main WebUI composer scope | COMPLETE - VERIFIED WITH NOTES | Immediate send, permission/profile/model persistence |
| fix-delivery-bridge | P1 delivery replay/profile/idempotency corrections | main bridge scope | COMPLETE - VERIFIED WITH NOTES | 81+ server tests, ownership/idempotency/replay checks |
| fix-delivery-ux | P1 interrupted handoff retry UX | main SessionDetail scope | COMPLETE - VERIFIED WITH NOTES | Retry/discard/in-flight tests |
| fix-session-agent-tests | P1 persisted session-agent test/runtime boundary | main session-agent scope | COMPLETE - VERIFIED WITH NOTES | 18 focused hook tests |
| impl-queue | P1 durable steering/follow-up queue controls | main composer/bridge scope | COMPLETE - VERIFIED WITH NOTES | Atomic claims, legal transitions, UI/API tests |
| impl-pi-executor | P0A Pi-backed executor composition | main package scope | COMPLETE - VERIFIED WITH NOTES | 40 package tests; host Pi integration remains open |
| impl-e2e-harness | P16 disposable WebUI/PocketBase harness | main test-infra scope | COMPLETE - VERIFIED WITH NOTES | Contract smoke/harness scaffolding; live E2E not run |
| impl-cursor-replay | P0 durable event cursor replay/reconnect | main bridge/event scope | COMPLETE - VERIFIED WITH NOTES | Cursor/replay tests; live reconnect E2E not run |
| impl-gateway-credentials | P14 scoped remote gateway credentials | main auth/tools scope | COMPLETE - VERIFIED WITH NOTES | 96 server + 19 CLI tests; live remote auth not run |
| impl-attachments | P1 chat context attachments | main composer/attachment scope | COMPLETE - VERIFIED WITH NOTES | Attachment helper tests, type/build checks; live uploads unverified |
| impl-appearance | P2 themes and productivity foundation | main appearance/navigation scope | COMPLETE - VERIFIED WITH NOTES | Theme/reduced-motion/command palette tests; full dependency suite limited |
| audit-next-roadmap | Re-audit remaining P1/P2/P4-P13 gaps | main read-only | IN PROGRESS | Prioritized next implementation batch |
| impl-agent-context | P5/P6 authoritative profiles and capability context modes | main agent/tools scope | COMPLETE - VERIFIED WITH NOTES | 9 focused server tests; full build limited by unrelated settings errors |
| design-git-service | P3 repository/worktree service design audit | main read-only | IN PROGRESS | Contracts, dependencies, bounded implementation proposal |

## Completed Work

- Initial revised-roadmap audit completed 2026-09-19.
- Existing tool gateway, approval flow, agent runtime, session context, transcript projection, and provider flow tests identified as characterization coverage.
- Added and corrected the dependency-free shared core/local adapter/CLI foundation and the first WebUI security hardening slice; independent verification is pending.
- Verified bounded checkpoint after independent review: 37 focused server/transcript tests, 36 package tests, 8 Bun-native server tests, 2 frontend security tests, and successful Bun bridge/package builds.
- Checkpoint committed as bfe4ee5 and independently verified with notes.
- Run/adapter checkpoint independently verified: 54 package tests, all entrypoint builds, recovery/ownership/atomicity/redaction probes pass; WebUI production build remains blocked by existing settings-component type errors.
- f2c19bc committed and verified as the run/adapter checkpoint.
- 8b40180 committed and independently verified as the canonical routing/first-send checkpoint.
- Phase 1 focused checkpoint independently verified: 87 Vitest tests, 81 Bun server tests, bridge/app typechecks, and direct Vite build passed; full build remains blocked by unrelated settings errors.
- Queue/Pi/E2E checkpoint independently verified: 40 package tests, 9 queue/bridge/E2E contract tests, atomic queue corrections, and source/build checks pass; live services unavailable.
- 1b4019a committed and verified as the queue/Pi/E2E checkpoint.
- Cursor/gateway checkpoint independently verified: 27 focused cursor/credential/CLI tests and 37 package tests pass; live service/E2E unavailable.
- Attachment/appearance checkpoint verified: 6 focused tests, bridge build, and diff checks pass; live upload/vision/website and full WebUI typecheck remain environment-limited.
- df1fd00 committed and verified as the attachment/appearance checkpoint.
- Agent profile/context checkpoint verified: 9 focused server tests and bridge typecheck pass; full WebUI build remains blocked by unrelated settings errors.

## Known Bugs

- WebUI still has legacy process-global session metadata and Pi lifecycle outside the new package run seam; durable cross-process run recovery is not implemented.
- WebUI production build has existing TypeScript failures in `IntegrationsSettings.tsx`, `STTSettings.tsx`, and `TTSSettings.tsx`.
- Cursor replay, attachments, suggestions, and session pagination remain incomplete.
- Live cursor reconnect and scoped gateway credential deployment remain unverified without PocketBase/WebUI services.
- Git API/UI and several hooks/tests are orphaned.
- No disposable WebUI/PocketBase E2E harness exists.
- `subpolar-cli` currently runs only the explicitly documented local echo fixture; it is not yet a Pi-backed complete headless runtime.
- Full Vitest/WebUI verification remains blocked/red due unavailable dependencies and pre-existing unrelated module/settings failures; this is not represented as product verification.

## Technical Debt

- Session metadata is split between PocketBase, SQLite, Pi JSONL, and process-global maps.
- Existing OpenAPI document describes a compatibility API rather than versioned Subpolar contracts.
- Dynamic PocketBase schema setup is not a migration/rollback system.
- Root and WebUI manifests lack a normal test script; dependencies are not installed in the current environment.
- Legacy filesystem profile/background extensions remain potential competing authorities.

## Integration Conflicts

- Shared edits to `@webui/bridge.ts`, `server/tools.ts`, and `server/pocketbase.ts` must be serialized.
- Core package work must not import current WebUI server modules; use explicit contracts and composition adapters.
- Security hardening must preserve existing local development startup behavior while making deployment exposure explicit.

## Verification Evidence

- Repository audit subagents completed inspection-only reports on 2026-09-19.
- Git worktree was clean at audit start.
- Automated tests/typechecks could not be executed during audit because installed JS/Bun dependencies were unavailable (`tsc`/Vitest modules missing).
- No roadmap requirement is currently independently verified against a disposable deployment.
- Bounded checkpoint verification after implementation: dependency-free tests/builds pass; full WebUI Vitest/typecheck/build remains unavailable or has unrelated existing failures.
- Run/adapter checkpoint verification: 54 package tests, all package entrypoint builds, and independent recovery/ownership/atomicity/redaction probes pass.

## Next Actions

1. Commit the authoritative agent profile/context checkpoint.
2. Implement the bounded Git repository/worktree read service from the design audit.
3. Continue tasks/subagents, memory, browser, voice, and automations in dependency order.
