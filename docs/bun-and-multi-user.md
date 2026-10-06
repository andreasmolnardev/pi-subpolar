# Bun workspace and multi-user operations

## Workspace installation

The repository pins **Bun 1.3.14** in `package.json` and Docker. The root workspace
contains `@subpolar-agent` and `packages/*`; `bunfig.toml` selects `linker = "hoisted"`.
Run installs from the repository root:

```sh
bun --version
bun install --frozen-lockfile
```

Use `bun install` at the root only when intentionally updating dependencies and
`bun.lock`; review those changes together. Do not create separate workspace
installs or npm lockfiles. Hoisting shares compatible package versions where
resolution permits, including the Pi SDK used by Subpolar Agent and the standalone CLI.
It does **not** guarantee a single copy across incompatible version requirements;
nested dependencies can still be necessary. The standalone CLI must resolve the
SDK through its own package resolution, not by reaching into `@subpolar-agent/node_modules`.

`start-subpolar-agent.sh` checks for root Vite dependencies and runs a frozen root install
if they are missing. It starts both the bridge and frontend with Bun. Configure
`.env` and start PocketBase before starting the application:

```sh
cp .env.example .env
# Set POCKETBASE_URL, POCKETBASE_EMAIL, and POCKETBASE_PASSWORD in .env.
bun run dev
```

The PocketBase superuser credentials are server infrastructure secrets, not user
provider credentials. Do not expose them through integration metadata or tools.

## Validation runtimes

Bun manages dependencies and runs the application, TypeScript/build commands, and
Bun-native tests. Vitest requires a supported **Node** runtime on `PATH`: use Node
22.12+ on the 22.x line or a supported newer LTS compatible with the locked
Vite/jsdom/Vitest dependencies. Launch the installed Vitest runner with
`bun x --no-install`, without `--bun`. npm is not required.

From the repository root:

```sh
bun run typecheck
bun run build
bun run test:core
bun run test:ui
bun run test:server
bun run test:voice
bun run test:e2e:contract
```

Focused checks, from `@subpolar-agent`:

```sh
bun x --no-install vitest run server/tests/multi-user-runtime.test.ts server/tests/multi-user-runtime-sessions.test.ts server/tests/multi-user-providers.test.ts --maxWorkers=2
bun test server/tests/multi-user-tool-execution.test.ts server/tests/project-filesystem.test.ts
```

These commands are validation instructions, not a claim that every suite passed.
Earlier progress/audit documents retain their historical npm commands and results;
they describe past validation, not the current installation/run procedure.

### Docker

```sh
docker compose -f docker-compose.dev.yaml up --build
```

The Dockerfile installs the hoisted root workspace with Bun 1.3.14 and the frozen
lockfile. It copies only the Node executable from the Node 22 Debian image for
Vitest; it does not install npm. Tests can be run in the Subpolar Agent service container
using the same Bun commands above. A shared Compose container does not provide
per-user OS isolation, and a successful image build is not a security review.

### MCP command examples

The UI uses Bun argv examples such as:

```sh
bun x @modelcontextprotocol/server-filesystem /tmp
```

For the JSON-array input supported by `AddMcpServerDialog`:

```json
["bun", "x", "@modelcontextprotocol/server-filesystem", "/path with spaces"]
```

These examples describe direct executable/argument syntax, not shell syntax or
shared-host execution authorization. `bun x` without `--no-install` can download
and execute external code; review and pin external packages in trusted execution
environments. MCP stdio is disabled in the shared-host tool gateway. Prefer
policy-controlled remote HTTP MCP with owner-scoped credentials. Direct
management/discovery consumers of the stdio adapter require separate review.

## Multi-user boundaries

### Owned credentials and fail-closed inference

- Subpolar Agent inference constructs an owner-bound provider runtime. Account credential
  reads verify the owner, account instance, and provider binding. Host environment
  keys, `~/.pi` auth, and local `models.json` configuration are not tenant fallbacks.
- The shared provider catalog supplies metadata/login discovery, not inference
  credentials or an implementation borrowed from host custom configuration.
- Custom-provider CRUD/discovery is implemented, but owned custom-provider
  **inference is not wired up**. Unknown/custom provider implementations fail
  closed. Adding inference requires owner-bound secret loading, fresh provider
  implementations, and outbound network policy; CRUD alone is not completion.
- OpenAI-compatible proxy callers need a persisted owner token and an
  account-qualified `provider~account/model` ID from that owner's model list.
  There is no implicit first-model or host-runtime fallback.
- Keep encrypted credential collections server-only, protect/rotate
  `SUBPOLAR_PROVIDER_SECRET_KEY`, and protect PocketBase superuser credentials and
  installation/internal tokens. An internal service token is not tenant identity.
- The standalone CLI is a trusted local host application: its default SDK may use
  normal local Pi credentials. This is distinct from Subpolar Agent's owner-bound runtime;
  multi-user embedders must inject an isolated `modelRuntime` or trusted factory.

### No OS sandbox

Owner checks, workspace path validation, policies, approvals, and redaction are
application-level controls. They are **not an OS sandbox**, and no per-tenant
worker dispatch is implemented. A long-running process
service is therefore not enabled; see the [process capability safety
assessment](long-running-process-assessment.md) before proposing one.

The shared-host tool gateway supports guarded `read`, `write`, `edit`, and `ls`
only for an explicitly validated durable owner/session workspace. Paths must be
relative and satisfy link/type checks; no ambient working-directory fallback is
allowed. These checks do not eliminate hostile host filesystem races.

Arbitrary shell/`bash`, SDK subprocess `grep`/`find`, and MCP stdio are disabled.
Registered CLI execution is disabled by default. The exact operator environment
value `SUBPOLAR_TRUSTED_HOST_EXECUTION=true` enables registered CLI only, with a
minimal environment and existing workspace/policy checks. It does not enable
shell or MCP stdio and **opts out of hostile multi-tenant safety**. Interpreters,
package managers, Git, and build programs are not safe merely because argv is
shell-free or environment variables are minimized.

Remote HTTP/OpenAPI/MCP tools still need network policy and owner-scoped explicit
credentials; tenant metadata cannot resolve host-secret environment references.
Remote services remain responsible for their own tenant isolation. Tool calls
and inference can send data externally and incur provider costs.

These dispatcher restrictions do not certify every direct MCP management, git,
browser, voice, automation, subagent, or other subprocess path. Review all such
paths before exposing a shared host. Hostile tenants require independently
isolated containers/VMs or trusted workers with tenant-only mounts, OS/process
isolation, short-lived scoped credentials, enforced egress/quotas, process-tree
termination, and authenticated owner/session/workspace dispatch. The development
Compose stack is not that architecture. Process-local caches and refresh queues
also do not provide distributed synchronization or multi-replica guarantees.

### Verification still outstanding

Focused tests use fabricated credentials and stubbed inference/storage/SDK paths.
**Live two-user verification remains outstanding**; neither those tests nor a
build establish end-to-end deployment safety. Before claiming live support:

1. Provision two real application users with separate provider credentials and
   accounts, including matching account instance IDs where possible. Verify
   inference, title/routing, proxy model selection, refresh, and logout use only
   the intended owner's credentials; missing credentials must fail closed.
2. Run concurrent sessions and verify transcripts, events, cancellation,
   approvals, projects, integration resources, browser/voice state, and delegated
   execution cannot cross owners, including guessed/foreign record IDs.
3. Verify shell, subprocess search, registered CLI, and MCP stdio denial with the
   trusted-host opt-out unset. Audit management/discovery and other subprocess
   paths separately; successful gateway denial alone is insufficient.
4. Review database collection rules/indexes, existing workspace/session paths,
   legacy-migrated records, server-secret exposure, and deployment ingress/egress.
5. Exercise restarts, concurrent refresh/policy changes, and any multi-replica
   topology. Record failures and limitations; do not infer durable coordination
   from a single-process test.

For the detailed component audits, see [runtime](multi-user-runtime.md),
[providers](multi-user-providers.md), [execution](multi-user-execution.md),
[boundaries](multi-user-boundaries.md), and [client](multi-user-client.md).
