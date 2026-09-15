# PocketBase agent runtime source of truth

`@webui/server/agent-runtime.ts` is the adapter boundary for agent identity and Pi runtime configuration.

## Contract

`loadAgentRuntime(client, userId, agentSelector)`:

- reads one record from the PocketBase `agents` collection by owned `id` or `name`;
- rejects missing, malformed, foreign, or disabled agents with `AgentRuntimeError`;
- reads the owned agent's `agent_tool_policies` and enabled `tool_registry` records;
- applies the same policy precedence as the tool router: `deny`, then `approval`, then `allow`;
- exposes the original `prompt`, normalized `systemPrompt`, policy records, effective tool decisions, and unresolved policy IDs; and
- returns `pi`, an explicit Pi allowlist containing only routed wrappers (`read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`, `search-tool`, and `subpolar-tools`).

The adapter never reads or writes `.pi/agents.json`, `~/.pi/agent/agents.json`, or any other filesystem profile. External registry tools are represented by the `subpolar-tools` Pi gateway; raw external tool IDs are never placed in the Pi active-tool list. A denied tool is not exposed in the generated profile, and the router remains the final approval/authorization check.

`systemPrompt` uses the PocketBase `systemPrompt`/`system_prompt` field when non-empty and falls back to the PocketBase `prompt` field when the explicit system prompt is empty. Both values remain available on the runtime object so callers do not lose the authored prompt.

## Legacy boundary

`readLegacyPiProfiles(cwd)` and `convertLegacyPiProfile()` are migration/inspection helpers only. Their output is tagged `source: 'legacy-filesystem'` and `authority: 'read-only-fallback'`, filters tools to centrally routed Pi wrappers, and excludes profile-management tools. They do not produce an `AgentRuntime`, do not authorize calls, and do not write files or PocketBase records. Do not use them when a PocketBase runtime can be loaded.

## Exact integration points

The following existing locations are intentionally unchanged by this isolated change and are the follow-up wiring points:

1. **Session creation:** `@webui/bridge.ts:639-668` (`PiSdkSession.initialize`). Load the runtime after `applicationDatabase()` is ready and before creating `DefaultResourceLoader`/`createAgentSession`:
   - pass `runtime.pi.systemPrompt` to `DefaultResourceLoader({ systemPrompt })`;
   - pass `runtime.pi.initialActiveToolNames` as the session's explicit `tools` allowlist; and
   - pass `runtime.agent.name`, not the unvalidated session selector, to `createToolRoutingExtension({ agentName })`.
   The session's `userId` is the authenticated identity required by `loadAgentRuntime`; a missing identity must not be replaced by a filesystem fallback.

2. **Disable the competing profile extension:** remove `agent-profiles.ts` from `@webui/bridge.ts:164-186` (`applicationExtensionPaths` and `applicationExtensionFactories`). Otherwise its `session_start` handler at `@webui/subpolar/extensions/agent-profiles.ts:334-357` will still load filesystem profiles and its `before_agent_start` handler at `:328-332` can replace the PocketBase system prompt. Keep the old extension only if its profile-management UI is changed to write PocketBase agents; it must not remain an independent runtime authority.

3. **Profile listing/activation compatibility routes:** replace the filesystem path in `@webui/bridge.ts:512-528` (`profilesForDirectory`) and the fallback in `:1180-1186` with PocketBase `list()`/`load()`. The compatibility routes at `:1590-1601` should return PocketBase-backed profile projections and persist the selected agent on the session, rather than send `/profile` to the filesystem extension. If an outage requires showing old profiles, call `readLegacyPiProfiles()` only as a read-only, visibly labeled fallback.

4. **Session/request identity validation:** use the already existing `SessionContextResolver` in `@webui/server/session-context.ts:201-221` before loading the runtime. Its resolved `agentName`/`agentId` and authenticated `userId` should be the adapter inputs; request-provided names remain selectors, not ownership evidence.

5. **Tool router convergence:** `@webui/server/tools.ts:177-182`, `:247-267`, and `:391-435` currently repeat agent and policy lookup. Change those call paths to consume the same `AgentRuntime` policy projection (or keep their PocketBase checks as the final defense) so profile exposure and call authorization cannot drift. The existing `createToolRoutingExtension` at `@webui/subpolar/extensions/tool-routing.ts:183-190` should continue to expose only the central wrappers.

6. **Agent/policy API routes:** `@webui/bridge.ts:1044-1089` and `:1354-1382` already scope records to the authenticated user. Keep that ownership check and use the adapter for runtime validation after writes or before session launch; do not derive runtime tools from the frontend's `tools` object or from a filesystem profile.

## Example

```ts
const adapter = createPocketBaseAgentRuntimeAdapter(client, authenticatedUser.id)
const runtime = await adapter.load(session.profile ?? 'master')

const resourceLoader = new DefaultResourceLoader({
  cwd,
  agentDir: getAgentDir(),
  systemPrompt: runtime.pi.systemPrompt,
  extensionFactories: [/* routing and non-profile extensions */],
})

await createAgentSession({
  cwd,
  resourceLoader,
  tools: [...runtime.pi.initialActiveToolNames],
  // The router receives runtime.agent.name and rechecks the policy on calls.
})
```
