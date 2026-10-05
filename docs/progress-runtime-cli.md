# Features 14 / 17: shared runtime and standalone CLI progress

## Scope and status

Implemented focused integration in `packages/subpolar-core/**`, `packages/subpolar-core-pi/**`, and `packages/subpolar-cli/**`. No bridge-runtime, route, frontend, persistence-package, dependency-manifest, or lockfile changes were made by this work. Existing concurrent edits were preserved. **Full WebUI/bridge migration is not complete.**

### Feature 14: shared request-scoped execution

- CLI now composes `createStatelessSubpolarRuntime`, the same runtime already composed by `@webui/server/application/runtime/stateless-webui-runtime.ts`.
- New `createPiStatelessExecutor` adapts factories to the shared request/context/events/signal contract and exposes the runtime gateway tool invoker. The core has no Pi, WebUI, PocketBase, or HTTP dependency.
- Cancellation rejection is `interrupted`, with a sanitized error. An executor that settles after abort without durable outcome/replay ports is `unknown`/`UNSUPPORTED_RECOVERY`; late approval results cannot override cancellation.
- Typed execution errors retain their code and redacted message; untyped failures remain generic.
- Outcome loading is capability-gated. Cached terminal results do not re-execute, and cannot claim recoverability when the current composition lacks durable replay. Successful durable outcome and terminal event writes are necessary for `recoverable: true`.
- Existing gateway approval/restart regression remains passing: a fresh runtime can use a stored approval decision without an instance-local continuation. Approval-required is not a persisted terminal success or a promise of a resumable model continuation.

### Feature 17: standalone CLI

- Normal `run` lazily selects the optional Pi SDK executor, never echo. `--fixture` is explicit deterministic test mode; a programmatically injected fixture tool executor also explicitly selects test mode. Conflicting fixture/Pi options fail usage validation.
- `--pi-module <specifier>` exposes the existing factory-module seam from the executable. Modules may export a default factory or `createPiExecutor`. Use an absolute file path for local modules. Existing injected factory/config support remains intact.
- SDK installation is host-owned. The standalone package does not reach into WebUI's dependency tree. In the inspected checkout, the SDK was available under `@webui` but not resolvable from the standalone package, so a normal executable run correctly returned `PI_RUNTIME_ERROR` with installation/factory/fixture guidance. No npm install or SDK version upgrade was performed.
- SDK execution uses an in-memory session manager and settings manager; it disables built-in tools, extensions, skills, prompt templates, themes, and context-file discovery. This is a **prompt-only** default. Tool-enabled integrations must provide a trusted factory that delegates through `PiExecutionRequest.tools`; no durable approval decision command is provided by this CLI.
- Provider credentials/models can use the SDK's normal local configuration. This is not an assertion that provider credential files are stateless; inject `modelRuntime` for isolated credentials. Provider calls transmit prompt/history and may incur costs.
- Session persistence is opt-in via `--session-file`. History is captured before appending the current user prompt, avoiding duplicate prompt projection. Canonical text history is SDK custom context, not a fabricated full Pi branch/tool transcript. Every invocation has fresh run/request IDs even when sharing a session ID.
- File history supports conversation resume but does not provide durable run outcomes or event replay. CLI JSON reports `state` and `recoverable: false`; primitive, array, and null outputs are preserved. JSONL retains correlated/redacted lifecycle events.
- Timeout and cancellation exit codes remain 3 and 4. SDK cancellation calls `abort()` and cleans up listeners/subscriptions/session resources. Custom executors must cooperate; there is no claim of forcibly terminating an executor that ignores its signal.

## Verified validation

- `bun test packages/subpolar-core packages/subpolar-core-pi packages/subpolar-cli` (60-second bound): **55 passed, 0 failed**, 170 assertions, 8 test files.
- Targeted strict TypeScript check of the owned runtime sources and new/changed regression tests using the already installed `@webui/node_modules/.bin/tsc`, `--noEmit`, bundler resolution, ES2022, and Bun types (30-second bound): **passed**. No dependencies installed.
- Direct executable checks (10-second bound): `run hello --fixture --json` succeeded; `run hello --json` returned exit 1 with actionable missing-SDK error and `recoverable: false`, as expected for the standalone resolution environment.
- New regression coverage: default SDK selection using a deterministic loader, missing SDK without fallback, CLI factory module loading, session-file resume without duplicate current prompt, unique run correlation, non-object outputs, conflicting modes, gateway policy delegation, SDK abort/disposal, pre-cancellation, cancellation-versus-late-approval precedence, failed persistence/replay writes, terminal outcome reuse with absent replay, and all owned source files' WebUI/PocketBase import boundaries.
- Existing tests still cover context mapping, normalized Pi events, per-run executor disposal, redaction, durable approval restart, idempotency, and run-service behavior.
- **Not verified:** live authenticated SDK/provider calls, WebUI integration/e2e, full SDK transcript branches, or cross-process/in-flight recovery. SDK APIs were inspected in the concurrently updated installed WebUI package, but the default integration tests use a structural fake SDK and do not prove live provider compatibility.

## Remaining bridge adapter callsites (inspection only)

Line references describe the inspected working tree and may shift with concurrent edits.

1. `@webui/bridge-runtime.ts`, `runStatelessPrompt` (~1382–1450): already composes the shared stateless runtime, but its executor calls `rpcSession`, waits for `readyPromise`, then constructs `createPiRunPort` around `session.send({ type: 'prompt' })`. It passes an empty adapter transcript, does not wire the request signal to SDK abort, and `dispose` only unsubscribes the message listener. Follow-up: supply the owner-scoped transcript/runtime/tools projection through a true transient factory (the new `createPiStatelessExecutor` is the shared seam), propagate cancellation, return canonical assistant output, and explicitly define ownership/disposal of an active cached session.
2. `@webui/server/application/runtime/pi-sdk-session.ts`, `initialize` (~158–214), `send` (~260–303), `persistTranscript` (~306–313), and `close` (~322): richer WebUI adapter owns PocketBase hydration, provider runtime, routing extensions, and persistence. `send('prompt')` returns an RPC response envelope rather than assistant text. Follow-up: retain WebUI-specific owner/agent/tool configuration outside core, expose execution/output and cancellation separately from RPC transport, and keep session/transcript persistence caller-owned. The standalone prompt-only SDK factory must not replace these richer features blindly.
3. `@webui/server/application/runtime/stateless-webui-runtime.ts`, `runPrompt` (~100–118): owner-scoped outcome/replay ports and gateway are already injected, but no shared session store is supplied. Transcript persistence still happens in the WebUI SDK adapter. Follow-up: make that split explicit and avoid duplicate persistence if adding a transcript/session port.
4. `@webui/server/routes/sessions.ts`, message-delivery execution (~478–502): optional `runStatelessPrompt` still falls back to direct `sendRpc('prompt')`; non-completed states (including approval-required) are thrown and converted to interrupted delivery. Follow-up: require or deliberately label the shared composition, preserve approval/unknown/failed distinctions, and align delivery claims with durable run outcomes.
5. Same routes file: session creation calls `rpcSession` (~204); generic POST `/rpc` (~507–510), POST `/prompt` (~512–515), and POST `/abort` (~517) still use direct RPC. Follow-up: route executable prompts through shared run semantics, scope abort to the correlated execution, and leave read-only/administrative RPC behavior explicit. These routes were not changed.

Durable run-outcome replay is not automatic model continuation, an atomic execution lease, or exactly-once side-effect execution. Completing bridge migration and in-flight recovery requires the above out-of-scope adapters/routes and explicit concurrency/approval delivery policy. Older external documents describing a silent fixture default (for example `docs/pi-executor.md`) were not edited because they are outside this task's ownership; the owned package READMEs and this progress record reflect the implemented behavior.
