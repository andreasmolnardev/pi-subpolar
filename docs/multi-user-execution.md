# Multi-user tool execution boundary

This is an **application-level execution restriction, not full OS isolation**. It applies to the Subpolar Agent tool gateway and `invokeExternalTool` in `@subpolar-agent/server/application/tools/tools.ts`. Full hostile-tenant execution requires independently isolated per-tenant workers.

## Supported subset on the shared application host

Existing owner visibility, context/discovery modes, agent policies, approvals and auditing still apply. Execution availability is an additional restriction: unavailable tools are excluded from agent listings and gateway definitions, and rejected again at invocation (including previously approved calls).

| Tool path | Default behavior |
| --- | --- |
| Builtin `read`, `write`, `edit`, `ls` | Allowed only in an explicitly supplied, durable owner/session workspace. Relative paths only. |
| HTTP/OpenAPI registered tools | Retained through `fetchWithNetworkPolicy`, bounded requests/responses and existing server network policy. |
| MCP HTTP/SSE | Retained through the MCP network policy. Connections are scoped by the application owner and closed after the call. |
| Web search/fetch | Retained through their existing network-policy adapters. |
| Browser navigation/read/find/tabs/screenshot/wait | Retained through the existing owner-scoped browser service and network-policy port. |
| Memory, profile/registry management, subagent routing | Existing application policies remain; delegated tool execution must use this gateway boundary. |
| Arbitrary `bash`/shell, stdin programs | Disabled. No isolated execution capability is wired in this host. |
| Builtin `grep` and `find` | Disabled: the installed SDK starts `rg`/`fd` subprocesses, may download helpers, and does not provide the needed execution isolation. |
| Local registered CLI | Disabled unless the operator explicitly opts out below. |
| MCP stdio | Disabled even with the CLI opt-out: the existing adapter merges `process.env` into child environments. |
| Browser upload/download/evaluate or other program/file-transfer operations | Disabled. The current browser port supports none of these file-transfer/program actions. |

### File boundary

The application resolves the owner/session/project using `ProjectSessionRepository`, not a caller-supplied workspace claim. `cwd` must be explicit and exactly match the durable session directory, or the owned project path when no session directory is stored. A session without either has no file capability. General Chat can use its validated, session-specific directory; there is **no global General Chat or `process.cwd()` fallback**.

Paths must be relative to that exact root. Absolute paths (even inside the root), outside/traversal paths, home/SDK at-prefix expansion, symbolic links (including internal and dangling links), hard-linked files and non-regular files are denied. `ls` skips rejected linked entries rather than statting their targets. Write may create missing subdirectories. Guarded SDK filesystem operations revalidate paths at the operation boundary, including paths transformed by SDK normalization. File handles use `O_NOFOLLOW`; regular-file/link checks happen before reading or truncating. The custom read operations currently retain text reading, not SDK image MIME detection/presentation.

These checks do **not** eliminate parent-directory replacement races by another host process, filesystem mounts, or races creating hard links after a check. Do not grant hostile processes access to shared host storage. Application fences cannot replace a kernel isolation boundary.

### Credentials and network

Registered HTTP/OpenAPI and MCP headers cannot resolve `{ "env": "SERVER_SECRET_NAME" }` references. Use owner-scoped, explicitly supplied integration credentials; never register server PB/admin, provider or internal credentials as literal tenant-visible tool metadata. Private-network exemptions are controlled by the existing server network policy, not by tenant tool metadata. Network grants and credentials still need appropriate operator configuration.

Remote HTTP/MCP execution is not sandboxed by this change: the remote service is responsible for its own authentication, tenant isolation and filesystem permissions. Web search uses the existing configured provider adapters and may incur provider costs or transmit queries externally.

## Explicit trusted-host CLI opt-out

For trusted single-user/operator-controlled execution only:

```sh
SUBPOLAR_TRUSTED_HOST_EXECUTION=true bun @subpolar-agent/bridge.ts
```

Only the exact server environment value `true` enables this switch. Caller capabilities, permissions, approval decisions, tool metadata and input cannot enable it. The switch permits registered CLI execution while preserving CLI validation, limits and manual-approval behavior. The application CLI path still verifies the owned session/cwd.

Permitted CLI processes receive an explicit minimal environment (`PATH`, workspace-local `HOME`/`TMPDIR`, and `LANG`), not inherited PB/provider/internal secrets or loader hooks. Bun uses the running server's executable rather than a workspace PATH lookup. Environment minimization is defense in depth, **not a shell sandbox**: a permitted program can still read other host files, execute code, contact networks, inspect processes, and load its own configuration. Executable allowlists and shell-free argument passing do not make interpreters, Git, package managers or build tools safe for hostile tenants.

**Enabling this switch opts out of hostile multi-tenant safety.** It does not enable shell, SDK subprocess search, browser file transfer, or MCP stdio.

Existing CLI compatibility tests can be run explicitly:

```sh
SUBPOLAR_TRUSTED_HOST_EXECUTION=true bun test @subpolar-agent/server/tests/tools-registry.test.ts
```

The default-denial suite resets the switch and also launches real Bun subprocesses to verify denial and lack of inherited secrets:

```sh
bun test @subpolar-agent/server/tests/multi-user-tool-execution.test.ts @subpolar-agent/server/tests/project-filesystem.test.ts
```

## Required deployment for hostile tenants

Deploy separate per-tenant containers/VMs or equivalent trusted workers with:

- Only that tenant's workspace mounted; no application host filesystem, other workspaces, shared HOME, host sockets or container-engine access.
- A separate OS identity and process boundary; no host PID namespace or access to server process environments.
- Only short-lived tenant-scoped credentials, never PB admin/global provider/internal server credentials.
- Enforced network egress, resource/output/time quotas, process-tree termination and worker cleanup.
- Operator-authenticated dispatch binding the principal, session and exact workspace to the worker; no caller-metadata assertion of sandbox availability.
- Tenant-isolated browser storage and remote MCP authorization where those services are used.

No worker dispatch capability is implemented here. Keep unsupported host execution fail-closed until that capability exists. This change does not modify bridge runtime, workspace packages/install behavior, direct MCP discovery/management routes or other subprocess entrypoints outside this tool dispatcher. The underlying stdio adapter still exists for other consumers; they must not be exposed to hostile tenants on a shared application host. Audit those paths or move them into tenant workers before claiming end-to-end multi-user isolation.
