# Features 9 / 10 — automations, notifications, and inbox

## Scope

Changes are confined to `@subpolar-agent/server/application/automations/**`, the automations/notifications/inbox routes, automation/notification client APIs, their tests, and this report. No bridge-runtime, shared core, persistence implementation, router, service-worker, or other agents' work was changed. This is a focused gap-fix and verification pass, **not a claim of full feature completion**.

## Notifications follow-up

The notifications path now stores the full browser push subscription, signs VAPID requests, encrypts Web Push payloads, applies the user's global and per-event preferences, and supports test delivery. SSE approval, question, and session idle/error events project owner-scoped inbox items; task and automation outcomes use their domain repositories. The notification popover displays unresolved inbox items, marks them acknowledged, and navigates to their internal destinations. Retryable deliveries are rescheduled at their recorded backoff and recovered using the bridge's single-process serialization.

Live browser push still requires `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` in the bridge environment. The current Docker development UI reports that these keys are not configured, so actual push delivery could not be exercised in this environment. This follow-up does not claim multi-process delivery coordination or an atomic outbox; a crash between domain state changes and inbox projection can still leave a missing notification.

## Implemented in this pass

- Scheduling uses the same concurrency policy as manual triggering while another run is retrying. `skip` consumes the due occurrence without adding work; `queue` adds work behind the earlier retry; `allow` admits independent work. Retries retain their own backoff and trigger identity.
- Manual completion/retry no longer consumes a due one-shot or recurring schedule. Only scheduled triggering advances `next_run_at`; successful completion still updates `last_run_at`.
- Completion rejects a definition whose owner or automation ID does not match the leased run before storing output or projecting links.
- Cancellation projects one authoritative cancellation inbox result and attempts owner-only notification delivery. Repeated cancellation does not reproject, and late executor completion cannot replace cancellation with success. Abort signaling remains process-local.
- Run-list filters and ownership checks now precede offset/limit, so filtered results and slices crossing the old 100-record page boundary are correct. UI `completed` filters translate to persisted `succeeded`. Tradeoff: this route currently materializes all owner history before returning a bounded slice; database-side filtered pagination is a scaling follow-up.
- Disabled creation returns the persisted paused definition instead of the stale active response.
- Notification preference PATCH uses `deps.object` correctly, preserving unrelated preferences and existing event flags.
- Browser requests cannot synthesize/overwrite authoritative inbox projections, including approvals or arbitrary foreign resource links. Domain repositories remain the projection producers. Existing clients using POST inbox upsert must migrate to the owning domain operation; this now returns 403. Inbox resolve is acknowledgment, **not approval or task acceptance**.
- Partial automation API updates send only supplied canonical fields, rather than resetting the schedule, project, timezone, or agent. Explicit schedule changes are preserved.
- Clock-aligned interval translation is correct for representable values (including 60 and 120 minutes). Nonrepresentable elapsed intervals, e.g. 90 minutes, are rejected with an explicit cron guidance error, not silently changed to 59-minute/daily schedules. This is not a true elapsed-interval scheduler.
- Direct automation validation rejects missing/blank timezone, malformed schedule containers, and unsupported concurrency policy values. Notification delivery status types include `pending`.
- Corrected the existing automation foundation document's overstatements about durable compare-and-set and approval/inbox coverage.

## Existing behavior verified

Targeted tests cover:

- Manual trigger idempotency, retry attempt/backoff metadata, schedule timezone calculation, active/paused/disabled execution checks, queue ordering, cancellation, lease renewal/expiry, and two claims of the same run on one client.
- Cross-user history/detail/manual-run/cancel denial, scheduler isolation, completion owner matching, and task handoff owner/project/agent/run binding.
- Authoritative inbox identity/deduplication, resolved-state preservation, bounded/redacted metadata, internal link syntax, review/success/failure/interruption/cancellation projections, and adapter failure preserving inbox state.
- Notification subscription/delivery isolation, owner-only cancellation delivery, durable delivery-key deduplication, fresh reservation suppression, stale recovery with an injected durable capability, and fail-closed recovery without that capability.
- Inbox acknowledgment does not resolve a pending underlying approval; foreign inbox acknowledgment and client-forged projections are rejected.
- Existing common session-context, tool-routing, and approval tests verify owned context, gateway routing and waiting for approved execution. Inspection shows both manual and scheduled workers use `executeAutomationHost`, which creates the same `PiSdkSession`/host/session-context/runtime/tool-routing gateway rather than a privileged automation-specific executor. This is common-path unit coverage plus code inspection, **not live end-to-end proof** of every agent/project permission configuration.

## Restart guarantees and remaining blockers

1. **No active Pi replay/resume guarantee.** The bridge's first scheduler tick calls `markInterruptedRuns`: persisted leased/running automation records become `unknown` and project an interrupted inbox outcome. The test reconstructs a repository on the fake persisted store and verifies pending/retrying work remains executable while active work is not replayed. It does not kill/restart a live bridge/Pi process. Approval execution payloads/waiters are process-local; durable approval records do not make their active execution resumable.
2. **Single-process coordination only.** `automationWorkerFor` opts into process-local serialization with one database client. No durable CAS/transaction provider is attached by the inspected bridge. Multiple workers/processes or database clients are not proven safe. The maintenance sweep is not a distributed worker ownership mechanism. Bridge/persistence owner must provide durable conditional transitions/leases and worker identity before claiming multi-process/restart durability.
3. **Delivery recovery is blocked in the current runtime wiring.** `NotificationRepository.acquireStaleLease` requires `scope: 'durable'` and a serialized/transactional capability. The bridge calls `sweepDue` without attaching that capability; stale/retryable pending deliveries therefore fail closed. The implementation also imposes a five-minute stale threshold despite shorter `next_attempt_at` backoffs. Persistence/runtime follow-up must implement safe recovery and effective backoff scheduling. A retry after ambiguous external success can duplicate an external notification; database delivery-key uniqueness is not exactly-once provider delivery.
4. **Terminal projection is not an atomic outbox.** Run state is persisted before inbox upsert/delivery. A database error or crash in that gap can leave a terminal run without its inbox item/delivery reservation, and current maintenance does not reconcile those terminal projections. An atomic outbox or idempotent reconciliation worker is needed. Inbox resolve cannot cure this.
5. **Web Push is not complete.** The current adapter performs a network-policy-constrained plain JSON HTTPS POST. Subscription persistence/API retains the endpoint, not Web Push `p256dh`/`auth` keys; the adapter does not implement encrypted payloads or VAPID signing. `VAPID_PUBLIC_KEY` only controls the public-key endpoint; setting it does not fix delivery. Email deliberately reports `EMAIL_DELIVERY_UNAVAILABLE`; notification test delivery returns 501. Adapter/service/persistence owners must complete the transport and key contract.
6. **Preferences are saved, not proven to gate delivery.** The inspected `NotificationRepository.deliver` filters enabled subscriptions but does not consult global/event preferences. Runtime/delivery owner must apply preferences consistently to authoritative inbox projections without dropping the inbox record itself.
7. **Approval/question fanout is incomplete.** The Pi host broadcasts approval SSE events; the inspected host does not project these into inbox/delivery. Automation terminal and task review/terminal projections exist, but this does not establish durable offline approval/question notification coverage. Wire domain approval/question producers and their resolution transitions; do not restore client-authored inbox projections as a substitute.
8. **Links/UI need cross-owner implementation work.** Generated automation links use bounded internal `/runs/:id` plus matching `runId`/`automationId`; owned run routes check both IDs. The application router has no `/runs/:id` route and no discovered `Inbox.tsx`. The service worker expects `data.url`, while the adapter emits `deep_link`. Project automation pages also use numeric project IDs whereas durable IDs can be strings. Router/hooks/service-worker owners must supply an owner-checked inbox/run destination and align click payloads. Existing link syntax validation is not functional navigation verification.
9. **Scheduler throughput/configuration remains operationally unverified.** The bridge polls every ten seconds, and `executeDue` awaits runs sequentially. `allow` admits concurrent claims but this scheduler does not launch parallel Pi work; a long run/approval wait can delay other scheduled work. Recurring execution coalesces missed occurrences rather than backfilling all of them. Cron day/month semantics and arbitrary elapsed intervals are not certified as a full cron-service replacement.

## Live configuration requirements

No live PocketBase/bridge/Pi restart or external notification provider was exercised, and no secrets were inspected or changed. A live acceptance run still needs:

- PocketBase configured and reachable, the automation/run/inbox/subscription/delivery migrations and unique identity keys applied, and the bridge's application database credentials/permissions working.
- Bridge scheduler startup enabled; owned enabled agent and owned accessible project; workspace path and provider authentication/model configuration valid. The same agent/session/project permission policies must apply to both manual and scheduled runs.
- A genuine durable automation/delivery serialization provider before enabling more than one bridge worker or claiming delivery recovery.
- A completed Web Push transport plus real browser subscription keys and VAPID configuration, or a configured email adapter. Current endpoint-only subscription/plain POST cannot be claimed as working browser push.
- End-to-end checks for offline approval notification, owner-scoped notification clicks, preference suppression, cancellation during approval, retryable provider failure, and active-process restart without repeated side effects.

## Validation

From `@subpolar-agent`:

```sh
npx vitest run --maxWorkers=2 --testTimeout=15000 server/tests/automation-inbox.test.ts server/tests/automation-task.test.ts server/tests/automations-routes.test.ts src/api/automations.test.ts src/api/notifications.test.ts src/components/automations/AutomationJobDialog.assistant.test.tsx src/components/automations/__tests__/PromptsTab.test.tsx server/tests/approval-execution.test.ts server/tests/approval-flow.test.ts server/tests/tool-routing.test.ts server/tests/session-context.test.ts
```

Result: **11 files, 104 tests passed**. The initial parallel run had two UI timeouts; reducing worker contention and allowing 15 seconds resolved them. One queue fixture was corrected to schedule in the future because manual completion intentionally no longer consumes its schedule.

`npm run bridge:typecheck` was attempted but is blocked by diagnostics in concurrently edited/out-of-scope tools, other progress tests, browser API/event-stream imports, and the tools CLI. This pass fixed the new route test's Bun `Request`/JSON typing issues rather than modifying other owners' files. No claim of a clean project-wide typecheck or production build.
