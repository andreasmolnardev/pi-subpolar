# Subpolar Automations Implementation Plan

## Status

- [x] Create `automations` branch from `main`.
- [x] Complete the read-only runtime, persistence, API/client, UI, and security audits.
- [x] Confirm the canonical execution seam before implementation.
- [x] Implement the domain package and persistence contracts.
- [x] Integrate the execution adapter, API, CLI, triggers, output actions, and UI.
- [x] Run package tests, Docker-backed public API checks, browser verification, and parallel review.
- [x] Commit coherent phases.

## Architecture decision

`@subpolar/automations` is an orchestration package. It owns automation definitions, trigger occurrences, execution/action lifecycle, safe prompt templates, and action/condition registries. It depends on persistence-neutral ports and an injected `AgentExecutionPort`; it does not import React, Hono, PocketBase, Pi, or Pi Durable.

The application adapter will use the existing canonical stateless Subpolar execution path: `runStatelessPrompt` in `@subpolar-agent/bridge-runtime.ts`, composed by `createStatelessSubpolarAgentRuntime` in `@subpolar-agent/server/application/runtime/stateless-subpolar-agent-runtime.ts`. That path persists `subpolar_runs` and run events, resolves the configured agent from an owner-scoped session, and routes tools through `createCoreToolGateway` and normal agent policy/approval enforcement. Automation configuration cannot widen those permissions. Each execution receives an isolated, persistent session with the selected agent profile and a stable canonical run ID; the automation execution stores that run ID rather than duplicating the transcript.

The existing `@subpolar-agent/server/application/automations/automation.ts` and `/api/automations` implement legacy scheduled jobs. They are not the new domain model. The first-class API will use separate routes and persistence collections/adapters so the old API remains compatible. The UI will add a global Automations surface using the shared client and preserve the legacy project routes.

Target flow:

```text
trigger registry -> stable occurrence claim -> automation execution
  -> injected AgentExecutionPort -> canonical Subpolar run
  -> restricted output context -> ordered, persisted actions -> history
```

Triggers are manual, schedule, authenticated webhook, and internal event. Occurrences are at-least-once detected and idempotently claimed; external side effects are never claimed exactly-once. Uncertain action completion is persisted as `unknown` and is not blindly replayed. Templates use bounded substitution and conditions use a restricted path/comparison parser. Webhook actions must use the existing SSRF/network policy.

## Ownership and phase plan

1. **Domain package** — `packages/subpolar-automations/**`: domain types, registries, safe template/condition processing, lifecycle services, and domain tests.
2. **Persistence** — new owner-scoped PocketBase adapter/migration under `@subpolar-agent/server/persistence/**` and `packages/subpolar-persistance-pocketbase/migrations/**`; stable occurrence/action idempotency, canonical run reference, recovery state. Keep legacy automation collections/API intact.
3. **Execution/API/client/CLI** — app composition adapter and authenticated routes; public `@subpolar/client` and `subpolar-test-cli` commands use the same API. Resolve/validate agent ownership at create and execution time; use normal runtime policies.
4. **Triggers/actions** — manual, timezone-aware schedule, secret-authenticated bounded webhook, filtered internal events with causal depth guard; store, notification, secured webhook, and normal tool gateway actions.
5. **WebUI** — global list/editor/history and run/enable controls via typed shared client; required agent selection and canonical run navigation.
6. **Verification/review** — domain, persistence/recovery, runtime, security, and UI/API checks; Docker Compose stack only; use `subpolar-test-cli` against `http://localhost:4173` and verify WebUI in Codex browser without resetting persisted data. Run final architecture/security/reliability reviews and fix substantive findings.

## Audit findings to preserve

- Owner identity always comes from authenticated server context. Repository operations and agent/project resolution are owner-scoped and repeated at execution time.
- Agent tools, approvals, audit, and capability restrictions stay authoritative; no automation override may auto-approve or elevate permissions.
- Webhook payloads are bounded JSON treated as untrusted prompt data. Webhook actions are HTTPS-only and use `fetchWithNetworkPolicy`; secrets are references to existing credential storage and are redacted.
- Existing legacy automation claims use process-local locks and startup recovery that is unsafe across multiple workers. New claims must be atomic/durable where the adapter supports it; otherwise expose/document a single-worker constraint and never claim exactly-once behavior.
- Persist cancellation intent and propagate `AbortSignal`; a cancelled request does not undo external effects.
- Event triggers carry automation/parent execution IDs and bounded recursion depth, and suppress self-trigger loops.
- No `eval`, `new Function`, shell evaluation, arbitrary DAGs, or direct model/provider/Pi calls from the package.

## Verification record

### Implemented

- `packages/subpolar-automations` provides typed definitions/executions, validation, safe prompt rendering, restricted conditions, trigger/action registries, cancellation, timeout, idempotent lifecycle transitions, and output processing.
- `packages/subpolar-persistance-pocketbase` persists definitions, occurrence claims, executions, action results, schedules, and hashed webhook secrets. Optional blank fields are normalized for PocketBase's empty-string representation. The schema allows `{}` execution config and zero-based action ordinals.
- The bridge runs agent work through `runStatelessPrompt`, with owner-scoped agent resolution, isolated persisted session, canonical run ID, standard tool gateway/policy/approval, output actions, event recursion guard, schedule recovery, and webhook ingress. App restart recovery marks uncertain active work `unknown` rather than replaying it.
- Authenticated API routes, typed `@subpolar/client`, and `subpolar-test-cli` cover definition CRUD, enable/disable, run-now, execution history/cancel, and secret-authenticated webhooks.
- The global Automations WebUI has list, create/edit, trigger/action configuration, run/enable controls, execution history, and canonical-run links.
- Ordinary `/api/sessions` listing excludes sessions tagged `automation`, keeping canonical automation sessions available through execution history links only.
- Migrations `1791510000`–`1791510004` cover automation records, webhook hashes, and PocketBase-compatible optional empty execution config, zero-based action ordinal, and false-enabled values. Startup schema reconciliation supports existing dev databases.

### Commands and observed outcomes

- `bun run typecheck` — passed (application and bridge TypeScript projects).
- `bun run build` — passed; Vite reports dependency annotation and large-chunk warnings.
- `bun test packages/subpolar-automations packages/subpolar-persistance-pocketbase/test/automation-persistence.test.ts packages/subpolar-client packages/subpolar-test-cli @subpolar-agent/server/routes/automation-webhooks-v1.test.ts @subpolar-agent/server/routes/automations-v1.test.ts @subpolar-agent/server/tests/sessions-route.test.ts @subpolar-agent/src/components/navigation/moreDrawerItems.test.ts` — 31 passed, 0 failed, 119 expectations.
- `bun run test:core` — 129 passed, 0 failed, 444 expectations.
- `bun run --cwd @subpolar-agent test:server` — 460 passed, 3 failed. All three failures are macOS `/var` versus `/private/var` canonical-path expectations in `server/tests/service.test.ts` and `server/tests/task-control-plane.test.ts`; automation route tests passed.
- `bun run --cwd @subpolar-agent test:ui` — 941 passed, 18 failed in existing UI suites; the changed navigation test passed. Failures were in `SessionWorkspaceChanges` and another unrelated UI suite.
- Docker Compose: started and restarted only `subpolar-agent`; the existing PocketBase container/data volume remained intact. An image rebuild was blocked by Docker Hub's token endpoint returning HTTP 500; bind-mounted source allowed the updated bridge to run in the dev container.
- Through `subpolar-test-cli` with a normal authenticated Subpolar user token at `http://localhost:4173`: created and read an owner-scoped manual automation; run-now produced canonical run ID `automation-run-automation-execution:94a03f0c-eec7-494e-abc5-863aa85efa09`, completed the execution and `store` action, and returned persistent history. A minute schedule produced one record per stable timestamp (for example `schedule:f7c4aec5-6ead-411c-8c9f-d81e7508a166:2026-10-09T21:32:00.000Z`); schedule state/history persisted after restarting only the app container, and later occurrences continued. The scheduled smoke-test automation was disabled through the public CLI after verification.
- The Codex in-app browser at `/automations` displayed the scheduled/manual definitions, selected Research agent, trigger state, run controls, configured action, completed status, execution history, and canonical-run links. The normal Sessions sidebar no longer showed any automation sessions, while execution history retained canonical run links.

### Limitations and unresolved verification

- `/api/v1/health` reports 0 of 42 model providers configured in this dev environment. The live agent runtime completed and persisted a structured response/action, but returned `data: null`; meaningful model-generated text and tool invocation could not be verified until an owner configures a provider. No credentials were entered or changed.
- Approval-required runs remain `waiting_approval`; the system does not auto-approve them. A continuation mechanism to resume the automation output pipeline after approval remains future work.
- Occurrence claiming uses a process-local conditional update in this bridge and reports `multiProcessSafe: false`. Keep one bridge worker until a database-backed atomic claim adapter is supplied.
- Webhook ingress size limits, authentication, credential rotation/revocation, and duplicate idempotency keys are covered by focused tests. A live external webhook or outbound action was not sent.
- Internal event dispatch uses canonical run lifecycle events with causal metadata and depth protection; a live event-triggered cascade was not exercised.
- The restart check restarted the Subpolar app container and verified persistent schedule/history state; PocketBase itself was not restarted to preserve the existing database service/data.
- Read-only runtime, persistence, security, and UI audit subagents completed final reviews. No unresolved critical/high findings were reported; single-worker scheduling and approval continuation remain the documented constraints.
