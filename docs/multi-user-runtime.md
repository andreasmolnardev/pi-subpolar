# Multi-user runtime isolation audit

## Status and scope

This is a targeted runtime/credential hardening pass, **not a certification of full multi-user deployment safety**. Changes are limited to `@subpolar-agent/bridge-runtime.ts`, `@subpolar-agent/server/application/runtime/` (excluding the existing provider catalog/login-flow modules), `@subpolar-agent/server/bridge-request-handler.ts`, and new runtime tests. Data, frontend, workspace migration, and dependency files are not changed.

Pi remains pinned by the existing manifests to 1.0.2. Native OpenAI direct ChatGPT OAuth and the separate OpenAI Codex provider remain native implementations, not compatibility shims.

## Findings and fixes

| Path | Evidence / previous risk | Boundary now enforced |
| --- | --- | --- |
| Shared `modelRuntimePromise` | Default `ModelRuntime.create()` loads local auth and models configuration; shared providers can close over keys, headers and mutable catalog state. | An in-memory, `modelsPath: null`, non-network catalog; API-key resolution requires a credential and receives an empty environment/filesystem auth context. The shared catalog is metadata/login discovery only. |
| `createProviderRuntime()` | Delegation previously sourced implementations from the shared runtime, including composed local custom providers. Empty auth context alone cannot remove literal keys/headers closed over by a provider. | Fresh native implementations per runtime; shared `baseRuntime` is no longer an inference source. Account-qualified providers read credentials only through owner-bound `ProviderAccountService` operations. Unknown/custom implementations fail closed. |
| Proxy `/v1/models` and `/v1/chat/completions` | Token authentication returned an owner, but inference used the shared runtime and could select its first available model. | Resolve runtime from the token's persisted owner; qualified owned `provider~account/model` selections only. No host runtime, unqualified model, or implicit first-model fallback. Invalid tokens never construct a user runtime. |
| Active Pi session map / RPC services | Already owner/session keyed, but delimiter encoding could collide for service-supplied ids, and supplied record id was not checked before the cache hit. | JSON tuple key; owner/id check before cache reuse; `sendRpc` rechecks owned durable session existence; stateless prompt input must match its record's owner/id. Permission comparison also detects a return to default permissions instead of treating undefined as a wildcard. |
| `PiSdkSession` | Caller could mutate the supplied record after construction; default SDK resource/settings discovery could load host Pi context. | Local record snapshot with immutable owner/id; in-memory session manager and settings; no automatic extensions, skills, prompts, themes or context files; no appended host system prompt. Closing during initialization disposes the resulting session. |
| HTTP internal-token boundary | Installation token bypassed tenant auth on general routes; session handlers could infer owner from any session id. | Installation token restricted to the existing tool/approval/voice/event gateway route allowlist. General session/RPC/provider/settings routes require tenant credentials, not an installation token. The gateway-credential allowlist itself is unchanged. |
| Stateless service caller | `input.ownerId` was ignored; core context validation did not compare resolved principal/session to the request. | Reject input owner mismatch, empty session id, and resolved principal/session/request/run mismatch before execution/persistence. |
| Legacy migration | `ensureUserMetadata()` attempted migration of the same host files for each user. | No automatic host-file claim by arbitrary users. Migration requires an explicit `SUBPOLAR_LEGACY_METADATA_OWNER_ID` matching the authenticated user. |
| Suggestions | `SUBPOLAR_SUGGESTION_PROVIDER_MODULE` was loaded once; its contract lacks owner or credential context and service deduplication uses global assistant ids. | Legacy external suggestion integration is disabled: return a fresh unavailable service and empty suggestions. No conversation content is sent to that module. |

### Already owner-scoped paths inspected

- First-session title and agent routing select models from user preferences and call `userProviderRuntime(userId)`. Missing/unavailable selections do not fall back to the host runtime. These calls do not receive agent tools.
- Main Pi sessions get their provider runtime from the resolved owner, load/save transcripts under owner/session, and publish events with that owner. `saveState()` checks the owned durable session before updating it.
- Automation execution constructs session metadata using `automation.owner_id`, resolves projects with that owner, and uses the owner/session cache. Subagent execution creates a distinct session using `input.ownerId` and the existing worktree/controller path. Their provider credentials now pass through the hardened owner runtime. Worktree ownership logic and the gateway tool allowlist were not replaced.
- Credential reads recheck current account status/type and use owner-qualified service calls. Logout/refresh mutation queues are runtime-local; they are not distributed locks.

## Intentional behavior changes

1. Server `~/.pi` auth, `models.json` credentials/configured providers, and host provider environment keys are not available to arbitrary Subpolar Agent/proxy users. Users need owned provider accounts.
2. Proxy clients must obtain an owner proxy token and use a model id from that owner's `/v1/models` response, including the account qualifier.
3. `baseRuntime` remains a source-compatible option, but is deprecated and ignored for inference. Local/shared custom providers cannot be used as an account implementation.
4. Owned custom-provider CRUD remains untouched, but **owned custom-provider inference is not wired up**. The persistence service exposes public definitions but no owner-bound secret-loading inference API. Unknown provider types fail explicitly rather than borrowing host configuration. A future integration must retrieve the authenticated owner's definition/secrets, create a fresh provider implementation, prohibit ambient/command key resolution and apply outbound network policy. Do not mark custom-provider inference complete based on CRUD/discovery alone.
5. Host suggestion modules no longer run. Re-enable suggestions only via an explicit owner-bound model/credential contract with owner/session-scoped deduplication and no ambient auth.
6. Set `SUBPOLAR_LEGACY_METADATA_OWNER_ID` only for an operator-reviewed one-user migration, then remove it. Existing already-migrated records are not purged or reassigned by this patch; audit them separately.
7. Host Pi resource discovery is disabled. Skills/system prompts must come from the application-owned agent runtime. Projects no longer implicitly inject local Pi prompts/context through the resource loader.

## Device ID is not a tenant credential

The native OpenAI login flow continues to use `SettingsManager.getOrCreateDeviceId()`. This is a persistent UUID identifying the **installation**, not a bearer credential, user identity, or provider account. Sharing this host identifier is intentional and supported by the native flow. OAuth tokens/client ids/account selections are still saved through the owner-bound credential sink. Do not replace the device id with a provider key, tenant token or arbitrary non-UUID value.

## Remaining deployment blockers and obligations

- **Filesystem isolation is not established.** The bridge still has a shared workspace root and General Chat root. Path containment and owned database records do not create OS isolation. Users with filesystem-capable tools must not share an unsandboxed host; provision tenant-specific roots and enforce them in every filesystem/git/browser/subagent path, or execute tools in tenant containers/workers. Review existing session directories before enabling multiple untrusted users. No claim of full tenant-safe filesystem execution is made here.
- **Tool subprocess environments are not certified tenant-safe.** Provider auth no longer uses ambient host secrets through the audited runtime path, but shell/network tools can still inherit process environment or read host files. Strip environment secrets, restrict mounts/network, and keep `SUBPOLAR_INTERNAL_TOKEN`, PocketBase admin credentials and encryption keys inaccessible to tenant-executable code. The installation token is still a trusted service credential on its narrowly allowed routes, not an untrusted tenant credential.
- **One process's cache is not distributed synchronization.** Separate concurrent sessions are tested, but same-session prompt serialization, overlapping model/policy changes, concurrent OAuth refresh across runtimes, automation leases, crash recovery and multi-replica ownership need durable execution/refresh coordination. Sticky routing alone is not a tenant security boundary. Cached agent/tool policy freshness after edits needs a broader invalidation design.
- **Database security remains essential.** Keep encrypted credential collections server-only, verify owner indexes/queries and collection rules, protect/rotate `SUBPOLAR_PROVIDER_SECRET_KEY`, and audit historic records copied by legacy migration. These requirements are not replaced by the runtime adapter.
- **Custom provider endpoints need policy enforcement.** Before adding inference, apply SSRF/DNS/redirect/egress constraints and ensure credentials are never redirected to a foreign endpoint. Native-provider behavior beyond the stubbed OpenAI paths is not exhaustively verified here; ambient IAM/file-based auth providers require additional adapter-specific review.
- **Other routes and services are not certified.** Frontend/data work, voice/browser/remote execution/integration resources and every public/service caller require end-to-end review. This audit does not claim all paths verified.
- **Bun-only workspace migration is external to this patch.** All commands used for this task invoke Bun, without installs or dependency/lockfile writes. Existing root scripts/launchers that invoke npm were deliberately left to the parent migration; this patch alone does not make the entire repository Bun-only.

## Validation

New tests:

- `@subpolar-agent/server/tests/multi-user-runtime.test.ts`: host-env catalog isolation; hostile shared configuration; concurrent account-identical inference with distinct owner keys; proxy token ownership/qualified selection; collision-free session keys; record mismatch; internal-token route rejection; stateless input/context mismatch.
- `@subpolar-agent/server/tests/multi-user-runtime-sessions.test.ts`: dependency-stubbed Pi SDK, concurrent identical session ids across owners and separate sessions for one owner, independent histories/events/transcript writes, immutable session identity, resource isolation, close-during-initialization disposal.

Tests use fabricated credentials and stubbed inference/SDK/storage. They do not require live accounts or secrets. Native OpenAI auth regressions also use stubbed network responses.

Run the Vitest suites with the existing installed runner (via Bun):

```sh
bun x --no-install vitest run server/tests/multi-user-runtime.test.ts server/tests/multi-user-runtime-sessions.test.ts server/tests/provider-auth.test.ts server/tests/gateway-bridge-scoped.test.ts server/tests/session-title.test.ts server/tests/session-routing.test.ts --maxWorkers=2
bun x --no-install tsc --noEmit -p tsconfig.bridge.json
```

Run Bun-native recovery/runtime tests separately:

```sh
bun test server/tests/stateless-subpolar-agent-runtime.test.ts server/tests/runtime-recovery.test.ts server/tests/chat-recovery-run.test.ts
```

All commands above run from `@subpolar-agent/` and should be bounded by the invoking CI/agent. The final focused Vitest run additionally included provider model-state/login-flow-store and worktree integration regressions: **97 tests passed across 9 files**. The Bun-native run passed **4 tests across 3 files**. Bridge typechecking passed after the initial runtime edits; the final rerun was blocked by a concurrent, out-of-scope `server/tests/multi-user-boundaries.test.ts:42` Request/URL type error (TS2769), with no scoped errors reported. That test was not modified by this pass.

These are focused tests, not a live multi-user deployment, whole-repository test run, or an OS sandbox/security certification.
