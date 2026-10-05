# Long-running process capability: safety assessment

## Decision

Do **not** enable a server-side long-running process service or expose start/list/log/stop/restart through the WebUI, agent tools, browser, or gateway in the current shared-host deployment. No process service or API wiring was added.

Owner- and workspace-scoped records would scope application metadata, not the host process. This repository explicitly has no per-tenant OS sandbox or isolated worker dispatch. Its workspace path checks protect selected application file operations; they do not constrain programs started by a child process from reading host files, using inherited host capabilities, consuming host resources, or creating descendants.

## Existing enforcement boundary

- The central tool gateway loads current definitions and policy, and handles approval/audit decisions. This is an application authorization boundary, not an execution sandbox.
- Arbitrary `bash`, `grep`/`find` subprocesses, and MCP stdio are denied by the shared-host execution gateway.
- Registered CLI is disabled unless the operator sets `SUBPOLAR_TRUSTED_HOST_EXECUTION=true`. That switch explicitly opts out of hostile multi-tenant safety; allowed executables include interpreters and package/build tools, so shell-free argv and a minimal environment do not make them safe.
- `executeCliTool` executes synchronously through `execFile` with an application timeout and output buffer. This does not provide process-tree containment, OS CPU/memory/PID limits, durable long-running lifecycle management, or an isolated owner-only filesystem/network view.
- The existing active-session map is process-local and reconstructable for streaming/cancellation. It is not an authoritative process supervisor and cannot ensure cleanup or ownership after bridge restart or across replicas.

Consequently, binding an in-memory child-process handle or a PocketBase row to `ownerId`, `workspaceId`, and `sessionId` would not establish tenant isolation. Approval for an executable action would also not supply the missing containment.

## Requirements before reconsideration

A safe implementation needs an execution boundary outside the shared trusted host process, such as a dedicated worker/container/VM per isolated execution (or a comparably enforced trusted worker). At minimum that boundary must provide:

1. Authenticated dispatch carrying owner, workspace/project, session, and process IDs; the worker independently verifies the assignment and never trusts IDs supplied by an agent/browser.
2. A server-owned executable/argv policy (no shell, no user-selected executable, fixed argument schema, validated inputs), with an explicit gateway capability and current policy/approval check before starting and on sensitive lifecycle actions. Gateway approval and auditing must be the only route to the worker; there must be no direct agent/browser endpoint bypass.
3. An OS-enforced owner-only workspace mount and cwd, no host/home/secret mounts, restricted identity, and enforced egress policy. Application cwd validation alone is insufficient.
4. Enforced wall-clock, CPU, memory, process-count, disk, and output quotas. Output must be byte-bounded, redacted as appropriate, and retrieved through owner-authorized APIs; logs must not grow without limit.
5. Process-group/container-level termination and cleanup on stop, timeout, workspace/session deletion, owner revocation, worker shutdown, and expiry. Killing only the direct child is insufficient if descendants can survive.
6. Durable lifecycle state plus reconciliation after service/worker restarts, atomic ownership checks for list/log/stop/restart, bounded concurrency/quotas per owner, and explicit restart semantics that cannot duplicate unsafe work.
7. Tests for cross-owner/project/session denial (including guessed IDs and unfiltered persistence), argv/executable/cwd rejection, approval/policy denial, output/resource/time limits, process-tree cleanup, worker/service restart reconciliation, and gateway-only reachability. Tests should use an injectable worker boundary; they must not claim host-level tenant isolation based on mocks or owner tags.

Until those controls exist and are independently verified, keep execution disabled and document this capability as unsupported on a shared host. The existing `SUBPOLAR_TRUSTED_HOST_EXECUTION` opt-out must not be treated as satisfying these requirements.

See also [Bun and multi-user operations](bun-and-multi-user.md#no-os-sandbox) for the current shared-host constraints.
