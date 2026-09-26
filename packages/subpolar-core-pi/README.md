# `@subpolar/adapter-pi`

This package is the dependency-free execution boundary between Subpolar and Pi.
It exposes `createPiRunPort`, which creates one executor through an injected
factory for each run, passes the runtime context and a structured
`PiTranscriptProjection`, forwards JSON-safe normalized progress events, and
calls the executor's optional `dispose()` method before the run is released.

## No-persistence invariant

The adapter is intentionally transient. It does **not**:

- import or start the Pi SDK;
- create, read, search, or write Pi JSONL session files or session directories;
- look up a session from `context.sessionId`;
- persist transcripts, run outcomes, or replay events; or
- decide tool policy, approvals, permissions, or audit outcomes.

A `sessionId` is only descriptive runtime context. Any prior conversation must
be supplied explicitly as the in-memory `transcript` projection on the run
request. Durable session and policy services belong to the composition layer,
not this adapter. `piAdapterCapabilities` advertises these limits as
`ephemeral` with persistence, replay, and durable-approval support disabled.

The adapter calls the injected executor exactly for the current run and
supports an optional async `dispose()` hook. It does not assume a particular
Pi SDK API. `InMemoryPiExecutor` and `InMemoryPiSession` provide a small
in-process implementation for tests and for environments where the Pi SDK is
not installed; they retain the supplied projection only until disposal.

## SDK integration seam

The installed WebUI currently uses `@earendil-works/pi-coding-agent` directly,
but that package is deliberately not a dependency here. A composition root can
adapt a compatible SDK session to `PiExecutor` and inject it through
`createPiRunPort`. The adapter does not currently claim a stable SDK method for
constructing a session from a projected transcript: SDK versions may differ in
session-manager, message-import, event, and disposal APIs. Those version-
specific details must remain in the injected factory, while this package keeps
the transient and authorization boundaries enforceable.
