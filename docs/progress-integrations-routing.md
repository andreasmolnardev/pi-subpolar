# Integrations and routing progress — features 8, 16, 19

## Scope and authority

This slice changes only application tool modules, `server/routes/extensions.ts`, MCP settings components and `src/api/mcp.ts`, plus isolated `integrations-routing-progress.test.ts` suites. No edits to bridge/runtime composition, tools/gateway/settings routes, `packages/subpolar-tools`, or the root README.

The central registry and its execution gateway remain authoritative. Discovery, inspection, and comparison do not register tools, grant access, or invoke advertised provider operations. Settings drafts still require explicit registration through the existing registry path.

## Feature 8 — registry / OpenAPI

Implemented:

- One `accessibleToolRecords` owner/shared visibility boundary for agent discovery, search, and gateway definition loading. Queries select enabled records with empty/shared `owner_id` or the authenticated owner's ID; a defensive in-memory owner check also rejects foreign records. Explicit inspection applies the same query and owner check. Legacy records without an owner remain shared.
- One `evaluateAgentToolPolicy` decision shared by discovery and execution, rather than a second discovery permission authority. Wildcard allow/approval/deny, explicit denials, disabled context modes, agent-wide deny, session overrides, master-only management, memory/browser restrictions, and existing manual approval rules are consistently projected. Existing master `web.search` approval behavior is preserved, not redesigned here.
- Returned context modes reflect the effective agent/project configuration, not a registry mode that could misrepresent restricted exposure. Explicit inspection can retrieve a permitted on-demand schema. Default model search still excludes on-demand tools.
- `/api/extensions/tools?sessionId=…` validates session ownership and passes resolved agent, project ID and durable permission override to listing. The resolver's default permission is not treated as a session override. Explicit extension browsing includes permitted on-demand entries.
- `/api/extensions/openapi-tools` now rejects unauthenticated requests locally as well as relying on the outer auth boundary.
- Owned OpenAPI Teach Tools draft generation accepts optional `openapi.operations: string[]`. Unknown IDs fail closed; an empty array produces no drafts. Operation parameters override path parameters by `(in, name)` consistently in schema and request mapping; cookie/unsupported/secret parameters are not presented as usable inputs. JSON request-body schemas and required body state remain supported.

Examples of the **draft input**, not a new HTTP API:

```ts
await proposeTools({
  kind: 'openapi',
  goal: 'lookup',
  openapi: { spec, url: 'https://example.test', operations: ['lookup'] },
})
```

Remaining dependencies:

1. **CLOSED locally — gateway discovery context:** CLI gateway list/describe/search now resolve the owned persisted session without caller agent or permission hints, authorize against the actual resolved agent and resolved `project.id` (stored `session.projectId` fallback), and forward only a non-default durable permission override. Explicit list retains `includeOnDemand: true`; describe retains permitted on-demand inspection. `searchToolsForAgent(..., query, projectId?, permissionOverride?, includeOnDemand = false)` obtains the existing effective visibility projection before ranking and the 12-result cap; the route's post-cap intersection is removed. Standard search still excludes on-demand tools. No capability ceiling, policy authority, execution, or approval state was changed. Real-policy regressions and exact validation are recorded below.
2. **OpenAPI extension owner:** `@webui/subpolar/extensions/openapi-tools.ts` remains unchanged. Its configured-file registration path is distinct from disabled settings drafts. Full `$ref`/recursive-schema handling, parameter conflicts across locations, object operation-selection semantics, refresh/removal of stale operations, and response-schema fidelity need a bounded, shared compiler rather than another registry. No claim of complete OpenAPI schema validation is made here.
3. **Settings/integration owner:** provider editing, source refresh, schema preview and credential-reference storage/normalization must converge on the existing registry registration/configuration workflow. No new provider settings store was introduced.
4. **Bridge/context owner:** keep durable project IDs consistent between extension browsing, gateway execution and runtime context. The extension uses resolved `project.id` with stored `session.projectId` fallback; synthetic projects may have neither.

## Feature 16 — MCP

Implemented:

- Adapter shutdown now waits for in-flight initialization, rejects new connections during shutdown and closes a late-initialized transport instead of caching it after shutdown. Concurrent connection requests still share initialization; failed initialization closes its transport and permits retry; reconnect after completed shutdown is supported.
- MCP manager uses `connectAsync` / `disconnectAsync`, not fire-and-forget `mutate` callbacks. Its pending UI and deletion sequencing can now await actual completion; toggle failures are handled by the existing mutation error reporting.
- Add dialog honors its selected configuration, rejects duplicate server IDs instead of overwriting, validates ID/URL/timeout, and saves through one configuration callback or the existing settings API fallback (not both).
- One parsed configuration is used for persistence and connection. JSON argv arrays preserve spaces and empty arguments; ambiguous shell quoting is rejected with instructions. Environment values are not trimmed or dropped merely because they are empty. Persistence-success/connection-failure is reported explicitly so retry does not silently replace an entry.

### Remaining endpoint contracts — server/auth/settings owner

`src/api/mcp.ts` already calls the endpoints below. No matching MCP lifecycle implementation was found in the inspected server routes. This slice **does not implement or certify these endpoints**:

| Endpoint | Required behavior / dependency |
| --- | --- |
| `GET /api/settings/mcp` (optional `directory`) | Owner-scoped durable config/status projection, including failures and auth-required state |
| `POST /api/settings/mcp` | Validate/normalize the existing config, connect/discover as requested; no implicit grant to every advertised tool |
| `POST /api/settings/mcp/:name/connect` | Await initialization/discovery; reuse only correctly owner/config-scoped clients |
| `POST /api/settings/mcp/:name/disconnect` | Drain/close connection and reconcile status/exposure without deleting policy authority |
| `POST /api/settings/mcp/:name/connectdirectory` | Same lifecycle with validated owner/project directory scope |
| `POST /api/settings/mcp/:name/disconnectdirectory` | Scoped shutdown and status refresh |
| `POST /api/mcp-oauth-proxy/start` | Owner-bound OAuth flow; server-side credentials, state/PKCE and URL/network validation |
| `GET /api/mcp-oauth-proxy/status/:flowId` | Owner-bound flow status; no secret disclosure |
| `POST /api/settings/mcp/:name/auth/callback` | Complete only the matching owner/server flow |
| `POST /api/settings/mcp/:name/auth/authenticate` | Start/retry authentication using durable configuration |
| `DELETE /api/settings/mcp/:name/auth` | Revoke/remove stored credentials and reconcile connection state |
| `POST /api/settings/mcp/:name/authdirectedir` | Directory-scoped authentication, matching the current client spelling |
| `DELETE /api/settings/mcp/:name/authdir` | Directory-scoped credential removal |

Additional lifecycle dependencies: reconcile disabled/deleted configs and stale discovered records; distinguish selected config/project names in the currently global name-based status API; persist secrets as credential references; bind client reuse to owner and effective configuration (including credential changes), not a globally reused `serverKey`. The adapter patch addresses initialization/shutdown races, not that larger configuration/cache-identity contract. Live MCP/OAuth/PocketBase lifecycle validation was unavailable and was not attempted against public providers.

## Feature 19 — optional comparison; no Jev backend

`application/tools/registry-comparison.ts` exports typed `compareRegistrySnapshots(left, right)` for **already-authorized registry projections**. Its explicit result mode is `registry-dry-run`; it returns sorted missing IDs and changed field names for description, schema, approval and visibility. Schema object-key order does not create false differences. Duplicate/non-empty-ID validation avoids silently collapsing ambiguous snapshots.

This is a pure, stateless local comparison function: no network, persistence, provider discovery, tool calls, model calls, vendor dependency or execution of mutations. It does not return schema values or execution outcomes and does not authorize either snapshot. Callers must obtain owner/session-filtered projections first. It is **not wired to a comparison HTTP endpoint or UI**.

**No Jev backend exists in this implementation.** A vendor identity/API, compatibility/security contract and authorized snapshot acquisition would be prerequisites for any optional future adapter. Comparing execution outputs is outside this dry-run seam and must not invoke mutation tools just to compare them.

## Tests and validation

Isolated suites:

- `@webui/server/tests/integrations-routing-progress.test.ts`: owner/shared visibility across discovery, inspection, search and execution definition loading; wildcard and effective policy projection; project restrictions; independent plan and reviewer capability regressions; extension ownership/session context; pending/failed MCP initialization shutdown/retry; selective OpenAPI schemas with no HTTP calls; pure deterministic registry comparison.
- `@webui/src/api/integrations-routing-progress.test.ts`: argv and input validation; selected-config single persistence and identical connection config; duplicate rejection; frontend disconnect pending state.

Commands run from `@webui`:

```sh
npx --no-install vitest run server/tests/integrations-routing-progress.test.ts src/api/integrations-routing-progress.test.ts server/tests/agent-runtime.test.ts server/tests/tools-debug-route.test.ts server/tests/tools-teach.test.ts
bun test server/tests/mcp-adapter.test.ts server/tests/mcp-registry.test.ts
```

Latest focused results: **36 Vitest tests passed** (20 new isolated tests and 16 adjacent regressions); **7 Bun MCP tests passed**. Scoped `git diff --check` passed.

App and bridge TypeScript checks were attempted. The last observed failures were outside this slice (`DesktopSidebar`, parent-owned gateway/profile progress tests, and browser transport/fetch/SSH modules imported into the bridge compilation). No outstanding diagnostics were reported in this slice by those runs. Parent is resolving the broad typecheck failures; no edits were made to silence them here. No live integration completeness claim is made.

Gateway discovery handoff #1 closure validation (all commands bounded to 60 seconds, from `@webui`):

```sh
./node_modules/.bin/vitest run server/tests/gateway-parity-progress.test.ts server/tests/integrations-routing-progress.test.ts src/api/integrations-routing-progress.test.ts server/tests/tool-routing.test.ts server/tests/approval-flow.test.ts server/tests/approval-event.test.ts server/tests/approval-execution.test.ts server/tests/security-redaction.test.ts
bun test server/tests/gateway-credentials.test.ts server/tests/mcp-adapter.test.ts server/tests/mcp-registry.test.ts
./node_modules/.bin/tsc --noEmit -p tsconfig.bridge.json
```

Results: **89 Vitest tests across 8 files passed**, including **49 gateway parity tests**; **11 Bun tests across 3 files passed**; full bridge typecheck **passed**. New parity coverage exercises the real application visibility/policy/search functions with in-memory records: durable `none` exposes nothing, resolver defaults do not replace agent defaults, session `allow_all` exposes permitted candidates absent from baseline search without bypassing project/agent ceilings, filtering precedes ranking/capping and fills all 12 slots, and on-demand exclusion/explicit discovery remain intact. Resolved agent/project scope and legacy scoped credential authorization are also covered. Scoped whitespace checks emitted no diagnostics; the untracked test's no-index exit 1 denotes a new-file difference. An additional Node-only targeted strict check failed in imported `server/core/network-policy.ts:299` (`Uint8Array<ArrayBufferLike>` versus `RequestInit.body`); no out-of-scope edit was made, and the full project bridge configuration passed.

A separate bounded broader run including `server/tests/gateway-bridge-scoped.test.ts` returned **112 passed / 1 failed**. Its supported-discovery fixture lacks the now-required `resolveToolSessionContext` dependency (the catch then calls its also-missing `redactedDiagnostic`), and its assertion/credential still use stored `agent-id` rather than the resolved name `worker`. That test owner must supply the resolver and use resolved-agent scope; the production behavior must not fall back to stored IDs to satisfy the old fixture. The file remains unchanged under this handoff's ownership boundary. No live provider or persistence validation is claimed.
