# Feature 12 — model/provider selection progress

## Status

Native normal-OpenAI **Sign in with ChatGPT** is implemented and tested with mocked upstream responses. The separate Codex login and normal OpenAI API-key alternative remain available. Feature 12 is **not declared fully complete**: provider authentication and account-qualified model selection are covered below, while several model/thinking settings still require end-to-end integration verification outside this ownership scope.

No real credentials, live OpenAI authorization, or live model inference were used.

## Upstream verification and installed versions

Verified npm's published `@earendil-works/pi-ai@1.0.2` package and the corresponding repository source at commit [`cd32f7725fdbddbaecdff5b1e68491563394e0ca`](https://github.com/earendil-works/pi/tree/cd32f7725fdbddbaecdff5b1e68491563394e0ca). Compared the published 0.84.4 normal OpenAI provider: it had API-key authentication only, and its package did not contain `auth/oauth/openai-chatgpt`.

Relevant upstream source/API:

- `packages/ai/src/auth/oauth/openai-chatgpt.ts`: new native normal-OpenAI registration, browser/manual callback, token exchange, refresh, issued client ID and direct-token scope handling.
- `packages/ai/src/auth/oauth/load.ts`: native lazy loader used by normal OpenAI.
- `packages/ai/src/providers/openai.ts`: API key plus subscription OAuth, with `oauth.loginLabel: "Sign in with ChatGPT"`.
- `packages/ai/src/auth/types.ts`: `LoginOptions.getDeviceId`, native OAuth selector metadata and login options.
- `packages/ai/src/api/openai-responses.ts`: direct-token request detection and unsupported-field omissions at the normal OpenAI endpoint.
- Coding-agent `SettingsManager.getOrCreateDeviceId()`: native persistent installation UUID, ignoring project device IDs.

Direct dependencies are pinned exactly in `@webui/package.json`; the coordinated lockfile and installed dependency tree contain:

| Package | Installed version |
| --- | --- |
| `@earendil-works/pi-ai` | `1.0.2` |
| `@earendil-works/pi-coding-agent` | `1.0.2` |
| `@earendil-works/pi-tui` | `1.0.2` |
| `@earendil-works/pi-agent-core` | `1.0.2` (transitive) |

The upgrade was installed with scripts disabled; no further dependency installations were performed when finishing this work. npm's interrupted-install staging conflict was repaired before the successful install. Pi AI 1.0.2 requires Node `>=22.19.0`; verification used Node 22.23.2. Deployment/runtime compatibility must be checked against that minimum rather than assuming any Node 22 release is sufficient.

## Fixed

- Corrected the previous Codex-only implementation description and guide. The prominent sign-in entry now selects **normal `openai`**, not `openai-codex`.
- Catalog method labels prefer native `oauth.loginLabel` and fall back to the OAuth name. The dialog consumes those labels; subscription choices still start the native `oauth` flow.
- Kept the normal OpenAI API-key choice alongside ChatGPT login, and preserved a separate Codex provider with native browser/device-code prompts. Corrected method-status classification so offering subscription OAuth does not mislabel an authenticated API-key account as subscription-authenticated.
- Passed native `LoginOptions` through the owner-bound login controller. The bridge reuses one native settings manager for its persistent installation UUID, including overlapping first-use calls; no ad-hoc UUID per login and no copied OAuth implementation.
- Fixed account-alias inference delegation. The native adapter receives the original provider identity (`openai`), activating its direct-token behavior; streamed partial/final messages and completed results retain the account-qualified provider identity used by WebUI selections and transcripts. Deferred delegation uses the same native identity mapping.
- Updated the owned adapter to Pi 1.0.2's provider-facing `TranscriptContext` contract. High-level `ModelRuntime` calls continue to normalize regular `Context` into the native transcript.

## Verified by automated tests

`@webui/server/tests/provider-auth.test.ts`:

- Native normal-OpenAI provider exposes the sign-in label and API-key alternative; Codex remains a separate provider.
- Native authorization URL carries dynamic registration client ID, installation UUID, PKCE, and `chatgpt.tokens.use.direct` scope.
- Full manual callback URL forwards state and the issued client ID into native authorization-code exchange.
- Native token exchange/refresh uses `https://auth.openai.com/api/accounts/oauth/token` and resource `https://api.openai.com/v1`; issued client ID and granted scopes survive encrypted account persistence and refresh.
- Invalid token responses are rejected for missing direct-token scope, missing ID token, invalid expiry, or empty access token.
- Owner-bound flow access, account/model visibility, credential refresh and shared-runtime isolation remain intact. Existing Codex tests also cover two independent accounts.
- Normal OpenAI OAuth and API-key accounts coexist and resolve different credentials.
- Mocked native inference uses `https://api.openai.com/v1/responses`, the chosen model ID, system prompt and requested medium thinking effort. Both `stream` and `completeSimple` preserve account-qualified result identity.
- ChatGPT requests omit native-unsupported temperature/output-token/cache-option fields; API-key requests retain temperature and output-token settings.
- Native installation ID is a UUID, stays stable in one manager, survives settings flush/reload, and does not inherit a committed project's device ID.

`@webui/src/components/settings/ProviderSettings.test.tsx`:

- The prominent action starts normal `openai` OAuth with an optional account label.
- The normal API-key alternative starts `openai` API-key login.
- Codex remains independently selectable; native device-code selection, device authorization display and manual-redirect response forwarding still work.
- Conversation and routing defaults submit account-qualified selections such as `openai~personal/gpt-test`.

`@webui/server/tests/provider-model-state.test.ts` and `provider-login-flow-store.test.ts` cover recent/favorite state persistence, malformed selection rejection, and owner-bound persistent login-flow storage.

## Model/thinking behavior and remaining work

- Account-qualified catalog selection and native model lookup are verified; a different owner cannot resolve another owner's selected model.
- Native supported-thinking metadata includes medium for the tested reasoning model, and native inference receives the requested effort. This does **not** verify every model's supported levels or a complete per-model thinking selector in WebUI.
- In the inspected bridge, conversation defaults are read separately from routing/session-naming defaults, and routing/title generation selects from the owner's provider runtime. The settings UI exposes compaction, summary and tool-summary defaults too; consumption of those three preferences was **not established by this task**. They must not be presented as fully implemented behavior merely because the UI saves them.
- The inspected SDK session supports model/thinking RPC changes and transcript hydration, but full composer → RPC → durable transcript → restart behavior was not exercised here. Confirm per-model level clamping, retained selections after restart, and model-switch behavior in the session/composer owners' scopes.
- The model-state route preserves stored `variant` data, but no variant/thinking update API or complete catalog-to-picker thinking-variant plumbing was implemented here.
- The model-default UI submits settings patches; its test mocks the settings hook. Server persistence/reload and actual new-chat default selection need integration verification with the settings/session owners.
- Catalog models are not proof of account entitlement. Live consent, account/workspace restrictions, quota behavior, real streaming/tool calls, remote callback UX, and deployment persistence remain unverified without credentials.
- Browser-based normal OpenAI login still needs a free server callback port 1455. Device-code login is a separate Codex capability, not a fallback offered by the new normal-OpenAI flow.

## Migration and validation limits

The intentional major-version migration in the owned adapter is `Context` → provider-facing `TranscriptContext`. Calling native provider methods directly elsewhere may require equivalent normalization; calling the higher-level `ModelRuntime` retains its regular-context API. This work did not modify `src/pi.ts`, shared packages, or other owners' runtime adapters. Image/classifier expansion and other new Pi 1.0 model APIs are not part of this change.

Latest targeted validation, from `@webui`:

```sh
npm exec -- vitest run server/tests/provider-auth.test.ts server/tests/provider-login-flow-store.test.ts server/tests/provider-model-state.test.ts src/components/settings/ProviderSettings.test.tsx --reporter=dot --maxWorkers=1 --testTimeout=15000
```

**27 tests passed across four files.** A parallel run hit the default five-second UI-test timeout; the bounded single-worker rerun above passed.

`npm run bridge:typecheck` was run and **does not pass project-wide**: the latest result has 12 errors across six out-of-scope files, with none in the owned provider production files or provider tests:

- `server/tests/gateway-parity-progress.test.ts`
- `server/tests/profiles-memory-skills-progress.test.ts`
- `src/api/fetchWrapper.ts`
- `src/api/ssh.ts`
- `src/lib/runtime-event-stream/browserTransport.ts`
- `src/lib/runtime-event-stream/runtimeEventStream.ts`

These are Request/response typing, browser-global/transport typing and unresolved alias diagnostics; they were left to their owners. An additional frontend TypeScript check earlier reported an out-of-scope `DesktopSidebar.tsx` argument-type error. No clean full-project build, live authentication, or live inference is claimed. Whitespace validation (`git diff --check` on the owned tracked changes) passed.

See [Sign in with ChatGPT](chatgpt-sign-in.md) for user-facing setup, privacy and usage limitations.
