# `@subpolar/adapter-pi-durable`

Experimental single-process execution adapter using `@earendil-works/pi-durable@1.1.0` and its portable SQLite storage. Under Bun it provides a serialized async facade over `bun:sqlite`; Node runtimes use Pi Durable's Node SQLite adapter. It implements the current Subpolar `StatelessExecutor` boundary and exposes a small internal `AgentEngine` lifecycle (`initialize`, `configure`, `submit`, `wait`, `abort`, `recover`, `close`). Existing `@subpolar/adapter-pi` and bridge code are untouched.

## Authority and isolation

- Only enabled `ToolDefinition`s passed to this adapter are registered with Pi Durable. Durable's coding tools and any other tool extension are not installed.
- Each registered tool calls the corresponding Subpolar `RuntimeToolInvoker`; Pi Durable has no direct authority to invoke arbitrary Subpolar tools.
- Tool declarations are marked `replay: "unsafe"` so Pi Durable is not instructed to replay the tool automatically. The adapter does not yet prove an end-to-end Subpolar interrupted state or recovery outcome for a crash during a side effect.
- A single SQLite session document maps the JSON tuple `[ownerId, sessionId]` to a Durable conversation ID. The mapping write and new conversation creation share one Harness commit. Submission request IDs come from Subpolar's stable `RunContext.requestId`; retries therefore find the same Durable submission.
- The adapter is for one process owning a given SQLite database. It does not provide cross-process locking, distributed ownership enforcement, or a remote storage service.

The internal request binding is per conversation. A host must not dispatch multiple concurrent Subpolar executor calls against the same owner/session conversation; serialize those calls at its composition boundary. Pi Durable queues submissions on a busy conversation, but the gateway invoker binding is deliberately not a durable per-submission capability.

## Host/provider integration is intentionally unresolved

The host supplies `Models` (provider catalog, credentials, transforms) and selects a model using `provider/modelId` in `RunContext.model`. This package does not select providers, load credentials, infer a model from ambient state, or integrate Subpolar Agent's provider/account services. The host also supplies the SQLite path and the authoritative gateway tool definitions. No PocketBase, server, React, or provider-account integration is imported here.

Typical composition:

```ts
const engine = await PiDurableAgentEngine.initialize({
  databasePath: "/var/lib/subpolar/pi-durable.sqlite",
  models: hostModels,
  tools: gatewayTools,
});
const execute = createPiDurableStatelessExecutor(engine);
// Inject execute as the existing StatelessExecutor at the host composition boundary.
```

`PiDurableAgentEngine.initialize()` opens SQLite storage for the active runtime, opens the Harness, and resumes recovered tasks. Bun uses one `bun:sqlite` connection with queued operations and explicit `BEGIN IMMEDIATE`/`COMMIT`/`ROLLBACK` around the async portable transaction callback; Node uses Pi Durable's built-in Node adapter. Both use the portable `SqliteStorage` API. Call `close()` during orderly shutdown. Applications that need another SQLite implementation can construct the engine with an already opened Durable `Storage` via its constructor.

## Experimental API limits

Pi Durable documents itself as experimental and warns its API may change without notice. This adapter pins `1.1.0` and relies on its documented `Harness`, tool registration, conversation submission, SQLite storage, and typed document APIs. Recheck compatibility before upgrading. SQLite uses WAL with `synchronous=NORMAL`, has one process owner, and may lose the newest acknowledged commit on power/host failure. Durable task recovery does not make external model or gateway effects exactly-once; unsafe tools deliberately settle as interrupted after a crash. The adapter returns final assistant text and forwards JSON-serializable projections of committed Pi Durable agent events through the active `RuntimeExecution.emit`. It does not forward the attachment snapshot (including a snapshot used for watch overflow), or committed system-message entries that can contain private agent instructions; consumers begin with subsequent committed, non-system event batches. The watch is attached and started before each new submission and is stopped/drained when `wait` finishes or the engine closes. On restart, the adapter resumes Durable tasks, but its in-memory Subpolar request-to-tool-invoker bindings are not restored; recovered gateway-backed tool execution is therefore not production-safe. `recover()` is currently lookup plumbing, not a server run reattachment path. Tests cover deterministic faux-model event ordering/snapshot handling and watcher cleanup, a tool round trip through the injected Subpolar invoker (including stable call/run/request identity), disabled/unregistered tool filtering, completed no-tool work, Bun SQLite transaction rollback, and abort scoping. This validates the isolated adapter boundary only; it does not establish production provider integration, host tool-policy enforcement, restart-safe invocation bindings, transcript parity, or server event projection.
