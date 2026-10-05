# Parallel feature integration checkpoint

Branch: `feature/session-worktree-review`. Implementation is organized into feature-scoped commits; the remaining status/docs follow-up is being committed separately. This is a bounded implementation and verification pass across the requested workstreams, not a claim that all 19 features are production-complete.

## Feature map

| Requested features | Implemented / verified in this pass | Remaining gate | Detailed evidence |
| --- | --- | --- | --- |
| 1. Permissions, approvals, audit | Shared authority retained; persisted scope/owner checks, gateway route allowlist, session-filtered SSE, discovery/execution policy alignment, redaction and approval identity regressions | Durable multi-process continuation and exact input/session approval binding; live acceptance | [Permissions and tools CLI](progress-permissions-tools-cli.md) |
| 2. Chat, streaming, history | Message retry typing/identity fixed; tool-output loading/retry fixed; optimistic status cannot erase confirmed activity; reconnect/cursor and restart-uncertainty tests | Transparent active-model resumption is not implemented; live restart/reconnect testing | [Chat recovery](progress-chat-recovery.md) |
| 3. Local voice | Bounded process/input/output execution; cancellation escalation; response-body deadlines; unconfigured TTS returns 503 rather than false timeout | Real speech models, recordings, playback and authenticated deployment | [Voice](progress-voice.md) |
| 4. Tools CLI | Session-scoped discovery, structured auth errors and core approval-required responses | Live gateway credentials, durable continuation and wait semantics | [Permissions and tools CLI](progress-permissions-tools-cli.md) |
| 5. Agent profiles | Validated CRUD/context identity; project policy ceilings cannot enable agent-denied capabilities | Full effective-settings provenance and runtime policy parity | [Profiles, memory, skills](progress-profiles-memory-skills.md) |
| 6. Projects/Git, 7. Subagents/worktrees, 15. Parallel review | Session changes pill, diff review, named snapshot staging areas, independent commits, editor/quick-open; HEAD/local/cached-remote base picker, SHA-pinned clean checkout and owned new session; safe cleanup tests | Authenticated policy-aware remote fetch, result integration/merging and atomic concurrent attachment | [Worktrees](progress-worktrees.md), [workspace UI](../@webui/src/components/workspace/README.md) |
| 8. Registry/OpenAPI | Owner/shared registry isolation, effective discovery policy, explicit on-demand inspection, fail-closed selective OpenAPI drafts | Complete shared compiler, source refresh and integration configuration | [Integrations and routing](progress-integrations-routing.md) |
| 9. Automations | Scheduling/concurrency/retry corrections, owner-bound completion, cancellation projection, correct partial updates/history filtering | Distributed leases, active Pi recovery and terminal outbox reconciliation | [Automations/inbox](progress-automations-inbox.md) |
| 10. Notifications/inbox | Preference persistence fixed; client-forged authoritative inbox records denied; owner-scoped cancellation delivery | Standards-compliant Web Push/email, preference enforcement and functional inbox/run navigation | [Automations/inbox](progress-automations-inbox.md) |
| 11. Memory | Opt-in defaults and scope/owner/version/tombstone behavior tested; no silent prompt hydration | Live persistence/concurrency and complete audit/approval acceptance | [Profiles, memory, skills](progress-profiles-memory-skills.md) |
| 12. Models/providers | Pi packages pinned to 1.0.2; genuine normal-OpenAI Sign in with ChatGPT; native loginLabel/device identity; account isolation/refresh; inference alias and thinking forwarding | Live consent/inference and full consumption of all model defaults | [Providers](progress-providers.md), [ChatGPT sign-in](chatgpt-sign-in.md) |
| 13. Skills | Durable store integration verified; strict scope/mode/reference validation; cross-scope update fallback removed; scoped history/deletion checks | Atomic history/CAS and concurrent mutation handling | [Profiles, memory, skills](progress-profiles-memory-skills.md) |
| 14. Shared runtime, 17. Standalone CLI | Pi executor selected by default, fixture mode explicit, stateless runtime composition, cancellation/recoverability honesty, resume without duplicate prompt | Full legacy bridge migration; host-installed SDK/trusted tool factory; live provider execution | [Runtime/CLI](progress-runtime-cli.md) |
| 16. MCP | Initialization/shutdown races fixed; frontend saves selected config, validates argv/duplicates and awaits lifecycle completion | Matching durable lifecycle/OAuth server routes, credential references and scoped cache identity | [Integrations and routing](progress-integrations-routing.md) |
| 18. SSH/remote | Owner-bound profile/host-key security foundation and hard refusal of unverified trust; no unsafe remote execution added | Actual transport, credential custody and verified enrollment/rotation | [SSH](progress-ssh.md) |
| 19. Jev/tool comparison | Pure authorized-registry dry-run comparison seam; no operations executed | Define actual Jev backend/API and safe optional routing; no comparison endpoint/UI yet | [Integrations and routing](progress-integrations-routing.md) |

The Browser tab is still a placeholder. Interactive browsing and persistent website profiles remain the target described in [the browser integration plan](agent-browser-integration.md), not an installed browser capability.

## ChatGPT correction

Normal `openai` ChatGPT token sharing is distinct from `openai-codex` subscription auth. The new entry drives Pi's native `openai-chatgpt` implementation and inference at `api.openai.com/v1/responses`; OpenAI API keys remain an alternative. Codex retains its own browser/device-code choices. No custom OAuth protocol was added.

Native normal-OpenAI login requires callback port 1455 to be free on the bridge even when using the manual full redirect URL. Persist global Pi settings for a stable installation identity, and configure the existing provider encryption key for owner-scoped credential storage. Tokens never belong in browser storage, public catalogs, logs, or committed files.

## Bun and multi-user follow-up

The repository now uses Bun 1.3.14 with one hoisted root workspace installation and `bun.lock`. See [Bun and multi-user operations](bun-and-multi-user.md) for commands and deployment boundaries; the npm commands below are historical evidence, not current instructions.

The follow-up added owner-bound runtime/provider/persistence checks, guarded shared-host file tools, account-generation cache invalidation, and cross-tab auth invalidation. Detailed evidence: [runtime](multi-user-runtime.md), [resource boundaries](multi-user-boundaries.md), [providers](multi-user-providers.md), [client](multi-user-client.md), and [execution](multi-user-execution.md). Owner/config-scoped MCP cache identity is implemented; complete lifecycle/OAuth management remains outstanding.

Current follow-up validation:

- `bun install --frozen-lockfile`: passed with no changes.
- `bun run typecheck`: frontend and bridge passed.
- `bun run build`: passed; large-chunk and Zod annotation warnings remain.
- `bun run test:ui`: **942 tests passed across 105 files**.
- `bun run test:core`: **120 tests passed across 16 files**.
- `bun run test:server`: passed with the server script's Bun-native and Node-backed Vitest groups. Stale owner/policy fixtures were corrected without weakening implementation checks; the earlier Git access assertions and event-cursor runner mismatch are resolved.
- `bun run test:voice`: **44 tests passed across 2 files**.
- `git diff --check`: passed.
- Root and WebUI resolve Pi AI to the same root `node_modules` package.

Vitest is invoked through Bun but uses its supported Node runtime; no npm is needed. Docker build validation timed out during provisioning after 120 seconds. No live two-user deployment or real provider sign-in/inference was tested. Application ownership fences are not OS isolation: hostile-tenant coding execution and multi-replica guarantees remain unimplemented, and custom-provider inference fails closed.

## Historical combined validation

The earlier parent integration pass ran:

- `npm --prefix @webui run build`: passed, including frontend TypeScript and production Vite build. Vite reports large-bundle warnings; no bundle optimization was attempted.
- `npm --prefix @webui run bridge:typecheck`: passed after correcting new test typing and moving browser-only tests into the frontend tree.
- `npx tsc --noEmit -p tsconfig.app.json`: passed.
- `npx vitest run src --maxWorkers=4`: **927 tests passed across 102 files**. The initial full run exposed an incomplete SessionDetail mobile-hook mock after adding the worktree dialog; using a partial mock corrected it without disabling feature coverage.
- `npm run test:core`: **120 tests passed across 16 files**.
- Bun-native server suites: **83 tests passed across 18 files**.
- `npx vitest run --config server/voice/vitest.config.ts`: **44 tests passed across 2 files**, using synthetic executables and disconnected/mocked backends.
- Server Vitest suites were also run broadly. Two existing Git checkpoint assertions in `server/tests/service.test.ts` expect `fs.access()` success to equal `null`, but Node returns `undefined`. Those unrelated assertions were left unchanged. An existing `event-cursor.test.ts` imports `bun:sqlite` while selecting Vitest; the Node/Vite runner cannot load that runtime module. It needs its appropriate Bun runner configuration and is not counted as passed.
- Final integration rerun: **123 Vitest tests passed across 5 gateway/registry/provider suites**; **14 Bun tests passed across 3 profile/skill suites**. Updated related route fixtures to resolve the persisted agent and policy rather than relying on request hints. These counts overlap broader runs and should not be added together.
- `git diff --check`: passed.

Focused agent reports contain additional verification details. Their earlier typecheck/install-blocker observations are historical snapshots; the parent build/typechecks above supersede those observations. No live PocketBase/bridge/browser login, real model request, remote Git fetch, public MCP/SSH connection, voice-quality test, or external notification delivery was performed.

## Behavior changes to account for

- Normal CLI execution no longer silently echoes fixture output. Install/provide a host-owned Pi SDK or executor; use `--fixture` explicitly for deterministic tests. The default SDK composition is prompt-only, with tools/extensions disabled; tool-enabled factories must use the gateway.
- Gateway bearer credentials can access only explicitly supported scoped tool/approval/event/voice paths, not unrelated management APIs. Cookies cannot expand a gateway credential's authority.
- Tool discovery uses the owned session's resolved profile/project and stored override, not caller-supplied policy hints.
- Invalid profile/skill scope and mode values now fail instead of silently defaulting. Project policy denies cannot be overridden to enable capabilities.
- Arbitrary browser-authored inbox projection writes now return 403; use the owning domain operation. Inbox acknowledgment does not approve a tool call.
- SSH trust approval fails closed while there is no verified transport/enrollment flow.
- Worktree removal no longer forces away dirty changes. Worktrees are registered as separate owned checkout projects; source refs choose a base commit, not an upstream push destination. Remote fetch is explicitly unsupported rather than bypassing network policy.
- Review areas store snapshots separate from ordinary Git staging. Area commits update clean selected index entries while preserving pre-existing staging and later worktree edits. Panel commits do not run hooks/signing; configure local Git author identity.

## Next integration gates

1. Finish request-scoped bridge execution/cancellation migration with durable approval input binding and multi-process claiming. Do not equate persisted outcome replay with active model continuation or exactly-once effects.
2. Supply atomic/CAS adapters and terminal outbox reconciliation before enabling multiple automation workers or claiming delivery recovery.
3. Implement policy-aware remote Git transport and owner/config-scoped MCP lifecycle/OAuth routes.
4. Complete owner-checked inbox/run navigation and notification payload contracts, then real Web Push/email transport.
5. Choose SSH transport/credential custody and a concrete optional Jev API before implementing those external execution capabilities.
6. Run disposable, authenticated two-user deployment tests covering OAuth, workspace ownership, approvals, restart/cancellation, voice, and notification links.
