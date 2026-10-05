# Worktree creation progress

## Implemented

- `SessionDetail` exposes **New worktree** for repository sessions without replacing the session-workspace review/staging UI.
- The dialog selects current `HEAD`, local branches (including their existing upstream label), or cached remote-tracking branches. Sources include full refs and displayed commit SHAs; symbolic remote aliases are excluded from selection. Remote names come from repository configuration, not an assumed `origin`.
- Explicit approval covers creating a new branch, linked checkout, owned repository record and session. Source/branch changes and refresh invalidate approval. Unborn `HEAD` cannot be used without a commit; another branch with a commit can still be selected.
- Local refresh re-reads existing references. **Remote fetch is currently unsupported.** The refresh endpoint returns `UNSUPPORTED` without invoking `git fetch`, remote helpers or arbitrary URLs. A policy-aware authenticated transport is required before enabling network refresh; merely validating a remote name is not sufficient to enforce network/redirect/DNS/credential policy.
- Creation resolves the selected ref to a commit, compares it with the displayed SHA, and passes the resolved SHA to Git. A moved ref is rejected with `CONFLICT`. Creation uses a new branch (`-b`, never `-B`), `--no-track`, and disables checkout hooks. Selecting an upstream/remote branch chooses only the starting commit; the new branch has no upstream.
- The controller persists both `base_ref` and `base_sha`. `ensureTaskCollections` adds the optional `base_sha` field to existing collections; older records need no backfill to remain readable.
- Worktrees live under the configured workspace's `worktrees/<owner>/<task>/<id>` directory. The parent checkout, index, untracked files and current branch are not copied or switched.
- The creation route checks actual owned project records and registers the linked checkout as a separate owned project, preserving explicit project-agent overrides. The returned stable repository ID is used for session creation, including numeric-looking database IDs; numeric UI project indices are not treated as database IDs.
- Session attachment checks the owned repository, configured workspace boundary, active owned worktree, exact canonical checkout path, and task/worktree/original-project linkage before session creation. Its runtime directory is the linked checkout, not the primary checkout. Existing session runtime isolation remains intact.
- Source discovery authorizes the session and its registered project. It reads `HEAD` from that project's checkout. A stored session directory differing from the registered project root fails closed instead of silently inspecting the primary checkout; legacy mismatches must be registered/reconciled first.
- Creation and source discovery deny gateway/internal capability escalation. Creation also rejects requests without an authenticated user.
- If checkout creation succeeds but session creation fails, the open dialog retains the checkout and can retry attachment without creating another worktree. A sequential server retry returns the existing owned session when the task already links it. Failure to persist task/session linkage attempts to delete the newly persisted session.
- Worktree listing exposes the requested project's own root and active worktrees authorized for that owner/project, not arbitrary sibling or foreign-owner checkouts.
- Removal and persistence-failure cleanup use normal `git worktree remove`, never `--force`. Dirty tracked/untracked files are preserved. Failed removals retain active state and error/activity information; successful removals clear stale errors. Cleanup retains the created branch, so recovery/retry never resets or silently deletes a user's branch.
- Removal rejects owner/task path escapes, including symlink redirection to another owner's directory inside the workspace. Filesystem checks are not descriptor-relative and are not a guarantee against a concurrently hostile filesystem writer.

## Validation performed

All commands used existing installed tooling, were bounded, and ran from `@webui`:

```sh
node_modules/.bin/vitest run server/tests/worktree-integration.test.ts server/tests/task-control-plane.test.ts src/components/worktree/CreateWorktreeDialog.test.tsx
```

**28 passed:** 15 real temporary-repository integration tests, 8 task-control tests, and 5 dialog tests. Coverage includes clean SHA-pinned creation from a cached remote ref; parent staged/unstaged/untracked preservation; disabled automatic tracking; moved refs and existing branches; dirty removal; clean and dirty persistence-failure cleanup; ownership/path/symlink rejection; branch metadata and configured remotes; route approval/gateway checks; registration of the actual checkout; linked-session `HEAD` versus primary `HEAD`; unsupported remote refresh; numeric-looking repository IDs; sequential session attachment retry; invalid checkout/task linkage; all three dialog source choices; session-only retry; and unborn `HEAD` handling.

```sh
node_modules/.bin/vitest run server/tests/service.test.ts -t 'passes argv without interpolation and parses status, branches, diff, and worktrees'
bun test server/tests/subagent-control.test.ts
```

The targeted Git read-service test passed (11 other tests skipped); all 5 existing Bun subagent-controller tests passed. Legacy worktree mocks now resolve a commit SHA and assert `--no-track` and removal without `--force`. The Git read-service mock includes the new branch fields and `remote` command.

The broader `service.test.ts` run produced **10 passed / 2 failed**. Both failures are unrelated checkpoint-deletion assertions at `fs.access()` checks expecting `null` instead of Node's `undefined`; they were left unchanged. No claim is made that the broader suite is green.

A scoped `git diff --check` passed for the worktree implementation and related tracked tests. Full parent typechecking/build validation is delegated to the parent agent, not claimed here.

## Unresolved / follow-up

- Policy-aware authenticated remote fetch is not implemented. Cached remote refs can be used safely, but may be stale. No network refresh was tested or advertised as working.
- No live bridge/PocketBase/browser/provider session was exercised. Integration uses real local Git repositories with mocked application persistence/dependencies; dialog tests use mocked HTTP API calls. No package installs, bridge-runtime writes, or provider/MCP/voice changes were made.
- Session attachment retries are sequentially idempotent, not transactionally serialized against concurrent requests. Multi-record project/worktree/task/session persistence is not atomic. Failure recovery/audit writes are best effort if the database itself is unavailable; inspect retained branches, worktree listings and task activity before retrying a partially failed operation. Late project registration/listing failures may require reconciling project metadata with cleanup results.
- A failed session attachment followed by closing/reopening the dialog does not restore its in-memory retry state. The registered checkout remains available as an owned project; no automatic worktree deletion or branch deletion is performed on dialog close.
- This flow does not implement upstream configuration, copying dirty changes, merging worktrees, or a new forced-removal UI. Existing session-workspace/staging/quick-open work was preserved.
