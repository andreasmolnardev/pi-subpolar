# Feature 2: Subpolar Agent streaming, history, tool display, and recovery

## Scope and status

Scoped fixes and targeted regression coverage are complete. Live recovery is **not verified**, and this work does not add transparent resumption of interrupted model/tool runs.

Edits are limited to `@subpolar-agent/src/components/message/**`, `@subpolar-agent/src/stores/sessionStatusStore*`, related new chat-recovery tests, and this document. `SessionDetail.tsx`, `bridge-runtime.ts`, auth, route wiring, and approval behavior were not edited. Other work already present or arriving concurrently in the working tree was left alone.

## Fixed

- `MessageThread.tsx`: removed the unused row-level `sessionStartedAt` prop, retaining the thread's existing session-start timestamp. Removed an unreachable assistant-header edit button (its condition required both user and non-user roles); the actual user edit action remains. Explicitly guards the following assistant before retry and uses its `id`, not the nonexistent nested `info.id`. This resolves all four baseline MessageThread TypeScript errors and fixes the retry click's runtime failure.
- `MessagePart.test.tsx`: the failing Thinking fixture had an end timestamp but expected active reasoning. An ended part must remain historical even when the containing assistant continues streaming. The active fixture now has no end timestamp, its name reflects the existing collapsed disclosure behavior, and a separate regression verifies completed timing wins over the active-step flag. No reasoning display behavior was changed to satisfy the test.
- `ToolCallPart.tsx`: native timeline disclosure toggles now drive lazy detail loading. Before this fix, opening a completed history row did not update the state used by the fetch effect. Results are associated with their details URL, preventing a replaced URL from showing stale output. HTTP/network/invalid JSON failures show an explicit retry action instead of an indefinite loading label. Inline output/error remains available as fallback. Loading retries only fetch display details; they do not rerun tools.
- `sessionStatusStore.ts`: optimistic activity no longer replaces authoritative busy/retry/compact status or attaches an expiry timer to an already confirmed busy run. Existing timeout refresh for unconfirmed optimism, snapshot omission grace, and explicit idle cancellation are preserved.

## Verified with targeted tests

- Message retry uses the following assistant ID; a failed retry rolls back its attempt tab; unanswered messages do not offer edit/retry.
- Thinking fixtures distinguish active generation from completed history.
- Opening history tool details loads output, failed loading is explicitly retryable, and a changed URL does not reuse cached output.
- Status confirmation by either an event or a snapshot cancels optimistic expiry; omitted optimistic activity expires; authoritative statuses are not downgraded; idle does not fabricate a completion notification.
- Injected frontend stream transport reconnects with `after=<last cursor>`, suppresses duplicate IDs, and accepts retained events following `cursor.reset`.
- Existing durable-event serialization and suggestion normalization/once-per-assistant tests pass. Suggestions remain optional, process-local, and failure-tolerant; no suggestion recovery guarantee was added.
- SQLite run recovery covers all starting/running/waiting-for-approval states becoming `unknown`, preserving existing terminal outcomes, idempotent reconciliation, duplicate reservation, owner isolation, and refusal to overwrite an uncertain terminal outcome with a late success. Existing delivery/queue/cursor tests also pass. These tests validate the SQLite seam, **not** equivalent transactional guarantees in the live PocketBase adapter.

## Existing recovery seam (reviewed, not rewritten)

The live SSE route uses `PocketBaseRuntimeStore.replayEvents`, with query `after` taking precedence over `Last-Event-ID`. Stored events are owner-filtered and replayed in cursor order; retention gaps emit `cursor.reset`. Frontend `EventStream` keeps its cursor in memory, deduplicates numbered messages, uses bounded reconnect backoff and a stall watchdog, and changes its cursor on reset. `useSSE` invalidates current-session history, pending actions, and queue on connection. That reconciliation currently requires an API URL, current session, and primary directory.

PocketBase startup reconciliation marks running deliveries `interrupted`, in-flight steering `failed` (`QUEUE_INTERRUPTED`), and nonterminal runs `unknown`. It leaves queued follow-ups untouched. This is uncertainty reporting, not model continuation, tool replay, or a guarantee that an external side effect did not happen. The SQLite helpers have stronger transaction/terminal-transition guards than the current PocketBase adapter. Do not infer live exactly-once execution from the SQLite regression tests.

## Remaining / outside edit ownership

- The SSE route awaits replay before registering its live client, leaving a potential replay-to-live race. No atomic handoff guarantee was established.
- Frontend parsing advances the cursor before JSON parsing; malformed numbered data can consume its cursor. `cursor.reset` updates the cursor but does not itself notify query consumers to refetch. Connection reconciliation helps but is not proof that every retention gap restores complete history.
- Cursor state is process-memory only on the frontend. No reload-persistent or owner-bound client cursor guarantee was established. The PocketBase replay parser does not validate safe integers or handle a cursor ahead of the durable log with an explicit reset.
- PocketBase event writes serialize per owner within one store instance, not across bridge processes. Retention is 5,000 rows per owner; the reviewed live pruning code does not implement the SQLite helper's byte/optional-age limits. Do not claim multi-process cursor allocation safety or identical retention policies.
- PocketBase `updateRuntimeRun` currently performs an unconditional update after lookup, unlike SQLite's nonterminal-only guard. Its startup reconciliation is asynchronous, and live request/startup ordering was not exercised. No change to the adapter or bridge wiring was made because those files are outside the explicit `event*`/`run*` module edit scope.
- A historical assistant with no completion timestamp still counts as pending in `MessageThread`; there is no scoped durable run outcome input that can safely distinguish genuine streaming from interrupted history. Guessing completion from an idle status could race event delivery, so this was not patched with a timeout or fabricated success.
- No approval resumption or automatic replay of interrupted/unknown side effects was introduced. A user retry remains an explicit new request; loading tool details is read-only display recovery.

## Validation

Commands run from `@subpolar-agent`:

- `bunx vitest run src/components/message src/stores/sessionStatusStore.test.ts server/tests/chat-recovery-stream.test.ts server/tests/durable-events.test.ts server/tests/suggestions.test.ts src/lib/runtime-event-stream/__tests__/runtimeEventStream.test.ts src/hooks/useSSE.test.tsx --reporter=dot` — **116 passed, 12 files**. Existing `SessionTodoDisplay.test.tsx` emitted a React `act(...)` warning; it did not fail.
- `bun test server/tests/chat-recovery-run.test.ts server/tests/runtime-recovery.test.ts server/tests/event-cursor.test.ts server/tests/message-delivery.test.ts server/tests/message-queue.test.ts` — **26 passed, 5 files**.
- `bunx tsc -b --pretty false` — all four MessageThread errors resolved; only baseline `src/components/navigation/DesktopSidebar.tsx(372,41)` remains (`{}` is not assignable to `string`), outside scope. The full frontend build is therefore not green.
- Scoped `git diff --check` — passed.

Live browser/PocketBase/model recovery was unavailable for this pass: no live service or provider was started, and no credentials or external side effects were exercised. Reconnect transport tests are injected, and restart tests use in-memory SQLite. Browser network interruption, retained-history exhaustion, bridge restart mid-tool, and live PocketBase concurrency remain unverified.
