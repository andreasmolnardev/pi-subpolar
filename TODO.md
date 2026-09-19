# Subpolar Implementation TODO

## Orchestration Status

Current phase: Phase 0A / Phase 0 foundation
Current milestone: Milestone A - Dependable Subpolar
Current branch: main
Last completed commit: pending checkpoint commit
Last verified commit: working tree checkpoint, pending commit
Current blockers: full WebUI dependencies are unavailable; the local CLI is still a fixture executor rather than Pi-backed; no PocketBase parity or disposable E2E harness exists; scoped remote gateway credentials are not implemented
Next recommended action: complete P0A-001/P0A-004 and P0-010/P0-013, then independently verify both slices

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
- [ ] P0A-005 Define PocketBase composition seam and parity fixtures.
- [ ] P0A-006 Extract session/run/task/event persistence boundaries incrementally.

Implementation tasks:
- [ ] P0A-001 Create `packages/subpolar-contracts` package and tests.
- [ ] P0A-002 Create `packages/subpolar-core` policy gateway and tests.
- [ ] P0A-003 Create `packages/subpolar-adapter-local` ephemeral store.
- [ ] P0A-004 Create `packages/subpolar-cli` command surface and JSON output.
- [ ] P0A-005 Add root test/typecheck scripts and package documentation.

Verification:
- [ ] Unit tests for policy precedence, approval decisions, redaction, and unsupported capabilities.
- [ ] Identical fixture decisions through local and PocketBase compositions.
- [ ] CLI starts with PocketBase, WebUI, HTTP, and Docker unavailable.
- [ ] Independent architecture verification.

Commits:
- none yet

Remaining problems:
- Current bridge still owns Pi lifecycle and process-global state.
- Current tool implementation is PocketBase-bound and remains the WebUI authority until migrated.

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
- none yet

### Phase 1-3 - WebUI, Personalization, Git, and Review

Status: NOT STARTED (existing functionality is partial and unverified)

Requirements:
- [ ] P1-001 Reliable runtime/session states, cursor replay, lifecycle, routing, queue, attachments, commands, handoff, suggestions.
- [ ] P2-001 Theme tokens, reduced motion, command palette, shortcuts, recent/pinned state, density and mobile behavior.
- [ ] P3-001 Repository/worktree service, Changes surface, checkpoints, anchored conversation branching.

Implementation tasks:
- [ ] Fix canonical `/new` routes and immediate first-send semantics.
- [ ] Implement durable delivery/idempotency and queue controls.
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
| impl-core | P0A contracts/core/local adapter/CLI smoke path | main isolated file scope | COMPLETE - VERIFYING | Implemented packages, tests, and limitations |
| impl-security | P0 request/network security primitives and bridge hardening | main serialized bridge/server scope | COMPLETE - VERIFYING | Security modules, ownership fixes, and regression tests |
| verify-core | Independent P0A/CLI review | main read-only | COMPLETE - FAIL FINDINGS CORRECTED | Initial 17-test review and correction requirements |
| verify-security | Independent P0 security review | main read-only | COMPLETE - FAIL FINDINGS CORRECTED | Initial security review and correction requirements |
| impl-security-followup | DNS, custom-provider, approval, internal ownership fixes | main serialized server scope | COMPLETE - VERIFIED WITH NOTES | Focused security corrections |
| verify-foundation | Reverify corrected core/security slices | main read-only | COMPLETE - VERIFIED WITH NOTES | Focused tests/builds pass; full WebUI suite remains environment-blocked |
| impl-tools-cli | P14 remote-only tools gateway CLI | main new-package scope | COMPLETE - VERIFIED WITH NOTES | 19 CLI tests/build; server registration credentials remain open |
| impl-contracts | P0 versioned capability/health/error contract | main server-contract scope | COMPLETE - VERIFIED WITH NOTES | v1 contract/health tests; full dependency suite unavailable |

## Completed Work

- Initial revised-roadmap audit completed 2026-09-19.
- Existing tool gateway, approval flow, agent runtime, session context, transcript projection, and provider flow tests identified as characterization coverage.
- Added and corrected the dependency-free shared core/local adapter/CLI foundation and the first WebUI security hardening slice; independent verification is pending.
- Verified bounded checkpoint after independent review: 37 focused server/transcript tests, 36 package tests, 8 Bun-native server tests, 2 frontend security tests, and successful Bun bridge/package builds.

## Known Bugs

- Global SSE/session status/search and several extension routes can expose cross-user state.
- Project and filesystem routes are vulnerable to symlink/path-boundary escapes.
- External HTTP/MCP/provider requests lack complete SSRF, redirect, timeout, and response-size controls.
- Approval HTTP routes bypass the stronger approval service and lack atomic/idempotent resolution.
- Tool audit/approval records can contain raw sensitive inputs/results.
- Markdown raw HTML and Mermaid loose rendering are not XSS-safe.
- Canonical `/new` routes, durable queues, first-send semantics, and session pagination are incomplete.
- Git API/UI and several hooks/tests are orphaned.
- No standalone CLI, tools CLI, extracted core, local adapter, contract suite, or E2E harness exists.
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

## Next Actions

1. Commit this verified bounded checkpoint and record its SHA.
2. Extract a Pi-backed execution seam into the shared core and compose it from WebUI and `subpolar-cli` without PocketBase imports.
3. Add a concrete PocketBase adapter/parity fixture suite and disposable isolated deployment harness.
4. Implement scoped remote gateway credentials and server-side `subpolar-tools add` authorization.
5. Continue with durable run/queue/event recovery and canonical WebUI session lifecycle before P1 capabilities.
