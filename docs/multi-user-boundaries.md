# Multi-user application boundaries

## Scope and threat model

This is an audit and hardening of the application data/integration boundaries, **not a certification of complete host-level tenant isolation**. An authenticated application request must not select another owner's records, secrets, workspace, browser state, or cached MCP connection. PocketBase is accessed through a privileged server transport; filters alone are not ownership checks. Returned records are checked before projection or mutation.

The existing runtime/tool permission system remains the policy authority. These checks are tenant fences, not a second capability/approval policy. They do not introduce SSH authentication, MCP OAuth, or new execution capabilities.

This threat model does **not** isolate mutually hostile arbitrary shell commands, MCP stdio executables, Git hooks, direct database administrators, or processes sharing the server's OS account. Those can read/change host files, environment variables, or other processes independently of these routes. Hostile-shell tenants require separate OS/container identities, filesystem mounts, secret injection, and network/process isolation. Trusted browser/transport implementations must obey their isolation contracts.

## Enforced boundaries

| Surface | Fence |
| --- | --- |
| Project repository | Returned `user_id` and requested selector are checked. Listings use the full claim set internally, but return only owned, nonconflicting workspace roots. Canonical paths reject foreign ancestor/descendant overlap, symlink aliases, missing-owner claims, protected names, workspace parent claims, and snapshot storage. |
| Default directories | New defaults are `projects/<sha256(owner)>/<slug>`. Other owners' hash namespaces are reserved even before a project is registered. `projects` and `worktrees` shared parents cannot be claimed. `worktrees/<owner>/...` is owner-specific. Existing safe custom/legacy project roots are retained; existing directories are not moved. |
| Linked worktrees | `.git` pointers/symlinks and `commondir` targets must resolve to registered projects belonging to the same owner and not overlap a foreign claim. The Git controller/policy remains responsible for Git-specific validation and authorization. |
| Session directories | Explicit project directories must be within an owned, nonconflicting project. Changing a session's project revalidates its existing directory. Read/list projections do not expose invalid directories. General Chat retains the bridge's `general-chat/<session-id>` layout: only the exact session root is accepted, never its parent/another session, and foreign durable sessions cannot reuse it. |
| Owner-free session lookup | A session ID with multiple durable owners is ambiguous and returns no principal. The method remains a trusted server composition helper, not an authenticated user lookup. |
| Directory picker | Literal `directories`/`default-directory` routes precede the numeric project selector. The shared parent is a virtual list of owned project roots (`currentPath: ""`), not `readdir` of host storage. Child listings require an owned root and recheck path availability. |
| Attachments | Project/Markdown attachments require an owned, currently nonconflicting root, canonical containment, and protected-path rejection. Existing extension/size limits are retained. Website attachment fetching retains the existing network policy. |
| Workspace review | Snapshot/lock identities use JSON tuples, not ambiguous `owner:session` concatenation. Storage roots and their canonical aliases cannot be reviewed, searched, or read. Existing secret-name, symlink, size, root/session lock, snapshot-only commit, and index-preservation protections remain. |
| Transcript/preferences | Foreign results from first-item/list queries are rejected before projection/update. Transcript updates recheck the second lookup rather than trusting a different returned record. Preferences cannot update another owner's returned record. |
| PocketBase recovery data | Delivery, queue and runtime reads check owner/session/message, client, or run tuples; event replay/pruning checks owner. Foreign records cannot be relabeled as the caller's events or cancelled through `clearQueue`. Startup reconciliation remains intentionally server-global maintenance. |
| Gateway/proxy credentials | Lists filter returned owners. Revocation checks owner and selector. Secret authentication checks the actual returned prefix/hash and a nonempty owner. Public credential projections whitelist fields and do not serialize stored hashes or arbitrary extra secret properties. Authentication by a valid bearer token intentionally derives that credential's owner. |
| Agent/task/browser routes | Agent listings and project override references are fenced. Task list/activity/audit/worktree responses check owner and relevant task selector. Browser audit checks owner/browser ID. Existing runtime approval/capability rules are unchanged. |
| Settings integrations | Tool-list records/policies are postfiltered. Public tool metadata exposes only `contextMode`, `transport`, and `toolName`; arbitrary execution env/header/argument material is not a UI projection. Extensions enumerate shipped builtins and contained owned-project extension directories, not host-global `.pi` or server-checkout project configuration; symlink entries are omitted. |
| Skills/memory/inbox/notifications | Existing owner/scope-aware repositories and recent skill selector/reference, historical-version, deletion and mode fixes are preserved. No package or runtime policy code is replaced. Adjacent skill/memory/security-handoff tests were run. |

### MCP connection identity and lifecycle

`serverKey` is a label, not an authentication or tenant identity. A trusted `McpServerConfig.ownerId` (or top-level owner on a trusted tool reference) permits reuse only for the same canonical, hashed effective configuration. Metadata cannot choose the owner. The configuration is cloned; env/header references are resolved before fingerprinting; stdio cwd and inherited environment are included. Changed owner, credentials, cwd, policy, limits, protocol or other configuration creates a separate client. Secrets are not embedded in the cache key.

The existing global tool invocation composition does not pass a trusted owner on its MCP reference. That path therefore uses a **fresh connection** and closes it after discovery/invocation. It does not reuse another invocation's authenticated transport. Direct ownerless `connect()` calls are also fresh, but their clients remain caller-managed until adapter `close()`.

Trusted-owner cached clients have no idle TTL or per-owner revocation API in this change. Rotation prevents reuse of old credentials but does not forcibly cancel old in-flight operations; cached clients are retained until adapter shutdown/close. Transport factories must return independent transport state for independent configs. The existing network policy and protocol behavior are retained.

### Browser leases and lifecycle

A `BrowserPort` receives an opaque JSON tuple `[owner, project, piSession, task, browserSession]`, never just a durable browser ID. Reusing a durable ID under another owner cannot attach to the old fake-page store. Operations require durable owner/exact-scope/open-lifecycle checks and revalidate referenced project/session/task ownership. Returned list rows and session-scope query results are checked independently of storage filtering.

Port implementations **must isolate cookies, local/session storage, credentials, tabs and browser profiles per lease**, even when one engine instance is configured globally. The network-backed fake stores pages per lease and does not implement authenticated browser automation/cookie persistence. The default unavailable port remains fail-closed. An injected engine that ignores its lease parameter and shares one authenticated context violates the contract; this layer cannot prove isolation of an arbitrary injected engine.

`BrowserPort.close` is optional for compatibility; the fake implements it and discards its pages after durable close. Closed durable sessions cannot start further operations. A close racing an already-running operation is not a cancellation barrier. There is no distributed operation lock, idle expiration, crash-time engine cleanup, or exactly-once close guarantee. Real-engine adapters must provide those lifecycle mechanisms before claiming them.

## Storage and migration

Workspace snapshot files are private-mode application storage (directory creation `0700`, file creation `0600`), not encrypted storage. Snapshots preserve source bytes; secret-name denial is not content-based secret detection. Existing permissive OS directory modes are not retroactively tightened here. Keep review storage server-controlled and outside tenant-mounted workspaces.

New review keys hash `[owner, session]`. Old delimiter-key snapshots remain readable **only when neither identity component contains `:`**, making the legacy encoding unambiguous; subsequent saves use the new key. Ambiguous legacy files are not imported. No old files, projects, transcripts, prior feature code, or user changes are deleted. Existing unsafe project metadata is hidden/denied, not automatically repaired: an administrator must migrate it to an owned safe root. Old default project paths are not moved.

Project overlap checks and General Chat reuse checks are read-before-write checks. They do not make path allocation atomic across independently running servers. Server-generated random session IDs and owner-specific default project namespaces reduce accidental collisions but are not a distributed claim transaction. Workspace filesystem locks serialize cooperating review processes; a process crash can leave a lock directory, and retry times out rather than stealing it. Descriptor-relative filesystem operations are not provided against hostile concurrent host filesystem mutation.

## Remaining composition guarantees / release blockers

These files deliberately were not changed outside the assigned boundary:

1. **Provider/login persistence is read-only for this task.** `ProviderAccountService.findOwnedAccount` and `listAccounts` still rely on query filtering rather than checking returned `user_id`/instance selectors. Under an unfiltered privileged transport, foreign account/status metadata can be projected, and account update/delete paths need returned-record fences. Credential loading rejects a foreign encrypted envelope because AES-GCM AAD binds the requested owner; that does not make metadata CRUD tenant-safe. The new test verifies the decryption fence and non-secret status projection, not cross-owner status/list isolation. Provider credential-row selectors and existing-collection rules also require their module owner's review.
2. **Bridge/runtime General Chat composition remains shared-root configuration.** Durable explicit session roots are now fenced in this repository, but the global General Chat project descriptor and automation/runtime fallbacks are defined outside this change. Shipped builtin extension paths remain shared application metadata. Complete per-owner runtime cwd/config/secret isolation requires the composition owner to review those paths and enforce tenant-scoped storage for every execution entry point.
3. **Other runtime/route consumers are not covered by these route projection fixes.** For example, task/tool/agent helpers outside this scope can still trust filtered lists. Route checks here do not certify all tool-dispatch consumers, gateway/runtime caches, or executor policy. Owner identity must come from authenticated composition, never user-selected MCP metadata or arbitrary request input.
4. **No distributed cancellation/revocation claim.** Browser/MCP in-flight operations, cached authenticated transports, project ownership changes, external-engine leases, and notification/runtime delivery leases are not made transactionally revocable by this patch. Existing persistence/runtime lifecycle implementations remain authoritative.
5. **No arbitrary-host-shell sandbox.** MCP stdio retains the server process environment; approved local tools/hooks can access the host under the server OS account. Separate host identities are required for hostile tenants.

These remaining items prevent calling the whole deployment “fully multi-user isolated.”

## Regression coverage and validation

`@subpolar-agent/server/tests/multi-user-boundaries.test.ts` intentionally uses an **unfiltered transport** for first-item and list queries, with foreign rows first. Its ten tests cover:

- project/session lookup/list/mutation fences, protected/default/foreign namespaces;
- exact General Chat roots, foreign reuse, wrong-session/parent rejection, ambiguous owner-free lookup;
- transcript, preferences, delivery, queue, runtime and durable-event projections/mutations;
- proxy secret retrieval/revocation and gateway owner/public-secret projections;
- foreign provider-envelope decryption rejection and status secret exclusion (read-only module);
- same-owner linked Git storage, foreign `commondir`, and symlink aliases;
- virtual parent listings, foreign-path denial and literal route dispatch;
- snapshot tuple-collision isolation and storage-root alias denial;
- browser lease separation, list/scope fences and fake-context cleanup;
- route-level task-worktree, browser-audit, agent and tool projections, including arbitrary-named integration secrets.

`@subpolar-agent/server/tests/multi-user-boundaries-mcp.test.ts` covers effective config/owner separation, unscoped concurrent connections, temporary-client cleanup, frozen env credential rotation, and ignoring metadata owner hints. These are deterministic fake-transport tests, not live MCP/browser/PocketBase integration tests.

Use Bun for commands; dependencies are not installed by validation. Runner selection follows each file's imports during the Bun migration:

```sh
# Native Bun suites: new boundaries plus migrated adjacent regressions
bun test server/tests/multi-user-boundaries.test.ts server/tests/multi-user-boundaries-mcp.test.ts server/tests/mcp-adapter.test.ts server/tests/mcp-registry.test.ts server/tests/subpolar-skill-store.test.ts server/tests/message-delivery.test.ts server/tests/message-queue.test.ts server/tests/runtime-recovery.test.ts server/tests/gateway-credentials.test.ts server/tests/security-handoffs.test.ts server/tests/profiles-memory-skills-progress.test.ts

# Remaining Vitest suites, invoked through Bun without installing dependencies
bun x --no-install vitest run --reporter=dot server/tests/project-store.test.ts server/tests/session-transcript.test.ts server/tests/pocketbase.test.ts server/tests/browser.test.ts server/tests/session-workspace.test.ts server/tests/durable-events.test.ts

bun run bridge:typecheck
```

Commands run from `@subpolar-agent`, with bounded terminal timeouts. Review tests intentionally exercise existing Git index locks and may print an expected Git lock error while passing. No live database, real-browser authentication, live SSH/MCP OAuth, production multi-process tenancy, frontend build, or full application suite is validated here.
