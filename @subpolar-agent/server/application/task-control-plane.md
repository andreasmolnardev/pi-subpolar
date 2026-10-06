# Task Control Plane

Phase 4 task records are owned by the authenticated PocketBase user. Tasks use
the bounded roadmap state machine in `task-control-plane.ts`; all state changes
and child activity are persisted and audited. Coding subagent work is expected
to use `WorktreeController`, which records the base ref and ownership and never
changes the parent checkout. Merge and cherry-pick orchestration is intentionally
outside this bounded foundation.

Worktrees are stored under the configured projects root in owner/task-specific
directories; canonical path checks reject traversal and symlink escapes.

The subagent runner accepts an injected host executor. It does not start a Pi
process or duplicate the Pi runtime. The `subagent/run` capability is registered
through the existing tool gateway and child capabilities are limited to the
caller's ceiling.
