# Multi-user client isolation

## Scope

Frontend auth identity boundaries, session-sensitive stores, workspace files/diffs/drafts/quick-open, and the shared API fetch wrapper. No backend, bridge, provider-settings, dependency, sidebar, or pill redesign is included.

## Identity boundary

The actual auth client exposes `user.id` through `/api/auth/session` and email sign-in/sign-up responses. IDs, not email addresses or session IDs, identify owners. A response without a user ID is treated as unauthenticated.

`src/stores/authIdentityStore.ts` maintains the owner and an in-memory identity generation. Changing owners, including logout, synchronously runs sensitive cleanups before the auth client publishes the next user. Re-authenticating the same ID does not clear its state. Generations also distinguish logout/re-login to the same ID.

`AuthProvider` cancels and clears QueryClient queries and mutations. Pending mutation lifecycle callbacks are disabled before cache removal, since clearing the mutation cache alone does not stop those callbacks. Its children are generation-keyed, resetting account-local React state (composer state, permission/question prompts, dialogs, file selections and diff/staging UI) and invoking existing effect cleanups. Current route-state `pendingPrompt` data is removed on an identity change.

The boundary resets queued/failed send prompts, pending prompt-file/command selections, prompt base paths, editing flags, todos, bash-command history, session status/unread indicators, optimistic-active timers, and persisted session-agent metadata. It does not blanket-clear localStorage, provider secrets, model preferences, or other persisted configuration.

The legacy `subpolar:pending-session-prompt:` storage namespace contains prompt text and is cleared when the persisted owner differs. `subpolar:auth-owner` records the owner so same-owner recovery handoffs survive page reloads. Unattributed legacy handoffs are not migrated into a newly authenticated owner's session.

## Cross-tab identity synchronization

`src/lib/auth-client.ts` listens while it has auth subscribers. Successful local sign-in, sign-up and sign-out send an invalidation signal over BroadcastChannel (`subpolar:auth`) and the storage-event fallback (`subpolar:auth-invalidated`). The signal contains only a fixed type and random event ID, never user details, credentials or tokens. Both transports use the same event ID; bounded deduplication prevents duplicate refreshes. Unrelated storage changes, malformed messages, and locally emitted event IDs are ignored.

Receiving tabs synchronously clear local identity through the existing owner/generation boundary, then fetch the actual cookie-backed `/api/auth/session` with `credentials: 'include'` and `cache: 'no-store'`. A refresh never broadcasts, so peer invalidations cannot echo into a loop. A failed refresh leaves the receiving tab unauthenticated.

Session reads are abortable and latest-request-wins, with checks before and after JSON decoding. New auth mutations and peer invalidations supersede previous session reads; stale responses and stale failures cannot restore/clear a newer identity. A superseded successful mutation signals peers and reconciles its own tab against the server rather than publishing its stale response user. The last auth subscriber removes storage listeners and closes the channel. If both messaging transports are unavailable, cross-tab delivery is best-effort and cannot be guaranteed. Blocking the invalidation storage key is tested with working channel delivery. Full localStorage denial also affects the existing persisted session-agent store, whose write-error handling is outside this synchronization change.

## Workspace isolation

Workspace, explorer and diff query keys include owner and generation, retaining existing session-key prefixes for invalidation. Workspace drafts are memory-only and keyed by owner plus session ID. Identity cleanup clears drafts and removes the before-unload safeguard; a late file response cannot repopulate the draft cache after an identity change. Same-owner session navigation/remounts still retain dirty drafts.

Workspace panels and editors remount on identity changes. Cached account-A diff text, commit messages, open tabs and editor content therefore cannot appear in account-B loading states. Existing staging, pill, polling and quick-open behavior is retained.

Generated open-file events carry owner/generation metadata. A stale stamped event is ignored, even if both accounts use the same session ID. Legacy unstamped events remain supported as local UI intent. Neither event IDs nor session IDs are authorization capabilities: every file/search/save/diff operation still requires server-side ownership checks.

## Requests and events

The shared fetch wrapper uses `cache: 'no-store'`, aborts requests on identity changes, and verifies generation both after the response and after JSON/blob decoding. Late results are rejected with `AbortError` rather than delivered to the next account. An already-aborted caller signal is respected.

Logout clears local identity before its HTTP request finishes. Server sign-out failures are rejected rather than treated as successful server logout. A stale session refresh cannot restore a previous account after logout or a newer sign-in. Session-fetch failures invalidate local identity.

The global EventProvider disposes its monitor synchronously on an identity change and ignores late old-generation event/status callbacks. The generation-keyed auth subtree also unmounts account-local subscriptions and pending-action state using their existing cleanup paths.

## Service worker audit

`src/sw.ts` has no fetch handler, `cache.put`, or authenticated-response caching. Its activate handler deletes Cache Storage entries; its other handlers deal with push notifications and notification clicks. No service-worker edit was necessary. This audit does not prove reverse-proxy/browser HTTP cache policy or push-subscription authorization.

## Validation and limits

Focused Vitest coverage includes:

- Real auth-client account-A/account-B transitions clearing QueryClient data and pending mutation callbacks, prompt stores, optimistic status, and current route prompts while retaining an unrelated secret/config key.
- Same-owner re-authentication and persisted prompt recovery.
- Two independent auth-client module graphs sharing a simulated server: peer account switches, logout, sign-up, prompt/draft cleanup before refresh, invalidation-only payloads, storage fallback, duplicate/malformed signals, late responses/body decoding/failures/sign-in results, and listener disposal.
- AuthProvider cache and local-draft cleanup while a peer-triggered session refresh is still pending.
- Logout followed by a stale session refresh.
- Account changes during JSON-body decoding.
- Two owners sharing a session ID: drafts/diff previews absent during the next owner's loading state; stale quick-open events rejected.
- Logout removing dirty drafts and unload guards; late file responses discarded; the next owner's editor showing only its own source.
- Monitor disposal, pending-permission reset and stale status callbacks ignored.
- Existing workspace staging, saving/conflict handling, quick-open, polling, send-error, status, and prompt-handoff regressions.

Run using the already-installed hoisted dependencies (no installation):

```sh
bun run --bun vitest run src/lib/auth-client.test.ts src/contexts/AuthContext.test.tsx src/contexts/EventContext.test.tsx src/components/workspace/SessionWorkspaceChanges.test.tsx src/components/workspace/session-workspace-api.test.ts src/stores/sessionStatusStore.test.ts src/stores/sendErrorStore.test.ts src/lib/pending-session-prompt.test.ts
bun run --bun tsc --noEmit -p tsconfig.app.json
```

These are frontend/component tests with mocked API/transport responses, not live two-account browser tests. Browser preview is currently a placeholder; the tested preview is the real workspace diff. Server resource authorization, filesystem ownership, cookie invalidation, push delivery, real-browser cross-tab delivery/concurrent cookie changes, and transport replay cursors require separate live/server validation. Cross-tab synchronization is covered by simulated transport/server and provider tests, not live browser automation. Signals cover mutations made through this auth client; external cookie changes or missed signals while a tab is suspended require a subsequent session refresh. It strips the current history entry's pending prompt, not every historical entry. Pending server mutations cannot be undone by aborting a client request, and custom/raw-fetch callers outside the shared wrapper are not covered by its generation checks. These changes should not be described as proof of complete end-to-end multi-user isolation.
