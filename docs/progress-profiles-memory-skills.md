# Features 5 / 11 / 13: profiles, memory, skills progress

## Scope and changes

Owned changes only:

- `@webui/server/application/session-context.ts`: reject a returned project's explicit `userId` when it differs from the authenticated identity; verify every resolved agent matches the selected name/ID, including new sessions and default selection. Preserve `SESSION_AGENT_MISMATCH` for stored profile mismatches. Default session permission remains `ask`.
- `@webui/server/routes/agents.ts`: validate create/update names, profile enums, policy booleans, object shapes, tool/skill context modes, and project override shapes before writing. Malformed values now return 400 rather than being ignored or persisted for later fallback. Valid primary/subagent modes and explicit model/template/context settings are preserved. No new browser, memory, registered-tool, or subagent privileges are added.
- `@webui/server/tests/profiles-memory-skills-progress.test.ts`: new focused route/context, owner/scope, privilege-default, and four-mode skill tests.

No changes to settings, runtime, persistence, core, auth, shared, bridges, dependencies, or unrelated concurrent work. No memory content has been added to any prompt. No new operations abstraction was needed.

## Inspection findings (not a claim of full feature completion)

### Profiles and effective configuration

- Durable application profiles live in the PocketBase `agents` collection. `listAgents()` and `loadAgentRuntime()` normalize model, thinking, approval mode, template, tool/skill modes and policies; `effectiveAgentConfiguration()` applies project overrides.
- General defaults use `ask`; coding/plan/reviewer currently use `auto` with write/edit/bash disabled. Memory, browser, and subagent booleans default to false, registered policies to an empty map. Legacy/non-template profiles and the master agent retain existing special-case tool behavior; this work does **not** assert every default tool is denied.
- Project overrides reduce tool and skill mode exposure. **Remaining gap:** `@webui/server/application/tools/tools.ts:effectiveAgentConfiguration()` spreads project policy booleans and builtin/registered maps over agent policies. A project can therefore set `memory`, `browser`, `subagent`, or a denied map entry to true even when false at agent level. Tools/runtime owner must implement policy intersection/deny precedence and test all opt-in capabilities; route shape validation does not solve that ceiling violation.
- Effective-source metadata is normalized separately in `toAgent()` / `toAgentDefinition()`. It is not consistently derived from which explicit record fields were present. Runtime owner should test explicit model/thinking/approval provenance versus template/default, not merely values round-tripped by CRUD. Project mode overrides mark both tools and skills as project-sourced even if only one changed.
- `loadAgentRuntime():buildToolPolicyRuntime()` and execution's `evaluateAgentToolPolicy()` use different checks. The former does not apply all memory/browser opt-in, `none`, and approval-deny checks that execution applies. Runtime owner should align visible/active tools with executable permissions and test plan/reviewer and disabled capabilities. No claim of corrected runtime exposure here.
- The shared session-context resolver accepts owned enabled agents independent of primary/subagent mode; this is not changed because execution callers can legitimately resolve subagents. Primary routing already filters subagents in `bridge-runtime.ts:sessionRoutingCandidates()`. `src/components/agent/AgentQuickSelect.tsx` filters primary/all and hidden entries but does not independently filter disabled agents; UI/hook contract work remains if disabled profiles reach this component.
- Subagent composition in `bridge-runtime.ts` checks owned enabled target, target `subagent` mode, owned project, project target allowlist and target policy; parent/target capability ceilings are intersected downstream. The generic `SubagentController` target authorizer defaults to allowing targets. This inspection is not an end-to-end verification of delegation or approval resume.

### Memory

- `@webui/server/persistence/memory.ts:PocketBaseMemoryService` persists `memory_records`, with authenticated owner, user/agent/project scopes, bounded queries, versions and tombstones. It independently rejects cross-owner and wrong agent/project mutation access, even if storage returns unfiltered rows.
- `memoryPolicyAllows()` requires explicit opt-in and makes plan/reviewer mutation tools unavailable. This is distinct from storage visibility: the repository itself is not the opt-in enforcement layer.
- Memory is a tool capability, not implicit prompt hydration. Inspected `loadAgentRuntime()` composes agent prompt plus rendered skills, not fetched memory. No live PocketBase, concurrency/CAS, or prompt end-to-end guarantee was established by this task.

### Skills and settings integration handoff

- Durable routes are **already** in `@webui/server/routes/settings.ts` at `/api/settings/skills`, using `createOwnerBoundSkillStore()`. No additional route migration was performed or is required just to connect the durable repository.
- Owner-bound store delegates to `packages/subpolar-persistance-pocketbase/src/index.ts` for head/history CRUD and effective resolution. Tests exercise that adapter with a fake PocketBase transport, not an in-memory skill repository and not a live server. Owner/scope filters and four exposure modes work in the executed repository tests.
- `resolveSkillRuntimeContext()` restricts repository exposure with agent modes. Always-loaded bodies are included; discoverable skills expose metadata unless explicitly selected; explicit-only skills require selection; disabled skills stay excluded. Explicit IDs cannot select another agent/project's skills. Runtime integration tests are present but dependency-blocked (below).
- **Settings integration owner:** reject invalid supplied `scope`/`mode` rather than silently defaulting to global/discoverable; validate `agentId` / `projectId` / `repoId` against authenticated-owner durable agent/project repositories before scoped CRUD. `createOwnerBoundSkillStore()` binds record ownership, but does not prove referenced agent/project IDs belong to that owner. Coordinate route changes with persistence owner and existing UI clients; this task did not edit `settings.ts`.
- **Persistence owner:** `skills.update()` uses an exact-scope candidate then falls back to any same-owner/same-ID head; assess and remove unintended fallback for scoped updates. `get()` historical lookup and owner-bound `delete()` need explicit tests for duplicate IDs across scopes. `createOwnerBoundSkillStore().delete()` removes filtered history rows without independently rechecking ownership/head identity; scoped deletion selection is ambiguous when selectors are omitted. Do not infer safety from a transport honoring filters alone.
- Durable skill head/history creation and updates are multi-write operations; the adapter's conditional update is optional. This task does not certify atomic version history, optimistic concurrency, migration safety, or all settings behavior.

## Validation evidence

Executed:

1. From repository root:
   ```sh
   bun test @webui/server/tests/profiles-memory-skills-progress.test.ts --test-name-pattern 'context defaults|stored permissions|profile writes|malformed profile|durable memory excludes|durable skill repository'
   ```
   **6 passed, 2 filtered out, 0 failed, 54 expectations.** Covers explicit project-owner rejection, agent/session ownership and selection, stored permission immutability across ask/none/allow_all, both profile modes, cross-owner update/delete refusal, malformed settings rejection before writes, memory scope read/update/tombstone isolation, durable skill scope/owner isolation and all four modes.

2. From `@webui`:
   ```sh
   ./node_modules/.bin/vitest run server/tests/session-context.test.ts
   ```
   **15 passed.** Includes existing symlink/containment, identity, request alias, SQLite compatibility, and permission tests. An earlier attempt with `--environment node` failed in the repository's browser setup (`window is not defined`); rerun with configured environment passed.

3. Full new progress file plus owner-bound skill-store tests:
   ```sh
   bun test @webui/server/tests/profiles-memory-skills-progress.test.ts @webui/server/tests/subpolar-skill-store.test.ts
   ```
   **8 passed, 2 failed.** Both runtime-facing progress tests fail to import the installed Pi SDK because `proper-lockfile` is missing. They are not marked skipped or claimed as passing. The existing owner-bound skill-store tests both passed. An initial run also including `memory.test.ts` had the same dependency import blocker.

After the integration/dependency owner repairs the installation, rerun the full command and the existing agent-runtime, memory, skill-context, and subagent-control suites. No broad settings suite, build/typecheck, live PocketBase, live model, or end-to-end subagent execution was run.

## Security handoff completion (subsequent bounded pass)

This pass edited only `@webui/server/application/tools/tools.ts`, the skills section of `@webui/server/routes/settings.ts`, `@webui/server/persistence/subpolar-skill-store.ts`, skill functions in `packages/subpolar-persistance-pocketbase/src/index.ts`, two new focused tests, and this document. Existing concurrent changes, including MCP/registered-tool owner filtering in `accessibleToolRecords()`, were preserved. No bridge, provider, frontend, runtime-core, or dependency edits were made.

### Exact fixes

- Project policy booleans now intersect the agent ceiling: project true cannot elevate agent false; project false restricts agent true. Builtin/registered maps preserve agent false and project false, and ignore project-only true grants. Missing entries retain existing legacy semantics rather than becoming blanket denies. Project override normalization preserves omitted policy fields and tool/skill categories; a tool-only override no longer synthesizes false opt-in booleans.
- `agentProfileToolEffect()`, consumed by both runtime exposure and execution, checks capability ceilings before legacy toolAccess/permission grants or stored wildcard grants. It enforces explicit builtin/registered denies, memory/browser/subagent opt-in, query-only plan/reviewer memory, disabled context modes, and approval-deny. Explicit policy map grants are recognized after legacy permissions. Execution `allow_all` cannot bypass these denies. Project source metadata now marks only the affected tool/skill category.
- Scoped skill updates no longer fall back to another same-owner ID in another scope. Unqualified get/update/delete consistently select global heads; scoped selectors matching multiple heads fail with `SKILL_CONFLICT`, rather than selecting an arbitrary row.
- Historical reads first select the same head as current reads, then require history to match owner, head ID, logical ID, version, scope and agent/project identity. Duplicate matching history fails closed. History cannot be read through a missing head.
- Deletion uses repository head-selection semantics, rejects duplicate heads, and independently checks every historical row's owner/head/logical scope identity before deleting. It does not trust transport filters to enforce ownership.
- Settings reject invalid supplied scope/mode values rather than silently broadening to defaults. Omitted create fields still default to global/discoverable. Agent references must resolve to the requested durable ID and authenticated owner; project references are checked against the durable project repository and independently rechecked for owner. Numeric legacy `repoId` aliases resolve through the owner's one-based project list to durable IDs; zero/unowned/missing references fail. Update body scope references must agree with query selectors rather than being silently ignored. Get/update/delete additionally validate the selected record's stored references, not just supplied selectors.

### Proof / final validation

All commands bounded to 120 seconds. The previously blocked Pi SDK imports now succeed with the repaired installation; this pass did not modify dependencies.

From repository root:
```sh
bun test @webui/server/tests/security-handoffs.test.ts @webui/server/tests/profiles-memory-skills-progress.test.ts @webui/server/tests/memory.test.ts @webui/server/tests/skill-context.test.ts @webui/server/tests/subpolar-skill-store.test.ts @webui/server/tests/subagent-control.test.ts @webui/server/tests/tools-registry.test.ts packages/subpolar-contracts/test/skills.test.ts packages/subpolar-persistance-pocketbase/test/pocketbase-adapter.test.ts
```
**57 passed, 0 failed, 316 expectations, 9 files.** New regressions cover all five capability ceilings, wildcard/legacy/allow_all bypass attempts, unchanged legacy defaults, scope fallback removal, duplicate scoped selection, global historical selection, unfiltered cross-owner history deletion, invalid route enums and foreign/missing agent/project/repo references. An initial new plan-memory fixture omitted explicit context exposure and failed one assertion; the fixture was corrected to enable query/write context modes, and the complete command passed. Existing tests were not edited.

From `@webui` using its configured Vitest environment:
```sh
./node_modules/.bin/vitest run server/tests/security-handoffs-runtime.test.ts server/tests/agent-runtime.test.ts server/tests/session-context.test.ts server/tests/tool-routing.test.ts
```
**26 passed, 0 failed, 4 files.** New runtime regression proves that project escalation plus stored wildcard grants cannot expose capabilities denied by the agent ceiling, and compares runtime exposure to discovery with `allow_all`; approval-deny exposure and preserved opt-ins under a tool-only project override are also tested. Both full commands were rerun successfully after the final normalization fix.

### Remaining limits / follow-up boundaries

- Skill create/update head + immutable-history writes remain nontransactional. Conditional updates are optional; the owner-bound PocketBase composition does not supply atomic CAS. Concurrent writers can race, overwrite a head, or create inconsistent/duplicate history; selector conflicts now fail closed but are not a concurrency solution. Create uniqueness still depends on database enforcement. Delete enumerates history and performs multiple deletes: concurrent history insertion, partial deletion, and reference deletion between validation and mutation are not prevented. No live PocketBase/CAS/concurrency guarantee is claimed.
- Numeric `repoId` compatibility relies on the owner's current ordered project list, which can change between requests. Durable `projectId` is the stable selector. Existing records keyed by historical numeric aliases are not migrated by this pass.
- Runtime exposure now shares profile-level ceilings, but full execution parity is **not** claimed: runtime's `buildToolPolicyRuntime()` still separately computes approvals, cannot apply a per-session `none` permission from this helper, and lacks tool-metadata-dependent browser mutation checks and non-master management-tool checks. Execution remains authoritative for these. Those runtime changes are outside this ownership boundary.
- Explicit model/thinking/approval provenance normalization remains a separate runtime handoff. No memory prompt hydration was introduced. No broad settings suite, typecheck/build, live database/model, or end-to-end delegation run was performed.
