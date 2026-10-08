# Subpolar Architecture

This document defines the target architecture for the Subpolar monorepo.

## Core invariant

PocketBase (or the selected persistence adapter) is the source of truth for all durable Subpolar state.

The Subpolar core runtime is stateless. A runtime instance may hold transient data while one execution is active, but it must not cache or persist user/application state in process-global memory. Pi is an execution engine; Pi Durable may persist execution checkpoints, but not authoritative Subpolar application records.

PocketBase (or the selected Subpolar persistence adapter) remains authoritative for application identity and records: sessions, canonical transcripts, agents, projects, tool policies, approvals, audits, and public run/event projections. Pi Durable may persist only the execution engine's conversations, submissions, tasks, and checkpoints in its own supported storage (initially SQLite in single-server mode). That storage is not a replacement for application records or ownership checks.

At each execution and tool boundary, the server must obtain trusted owner/session context and current policy through injected Subpolar persistence and gateway ports. Durable checkpoints may support execution recovery, but do not by themselves provide transcript parity, event projection, exactly-once side effects, or multi-process coordination. A process restart is supported only after the server can reattach the Subpolar run to its Durable submission and safely reconstruct the owner-bound provider and tool gateway context.

## Monorepo packages

```text
packages/
├── subpolar-shared (`@subpolar/shared`)
│   ├── domain records and DTOs
│   ├── runtime, run, tool, approval, audit, and event contracts
│   └── persistence and executor ports
├── subpolar-runtime (`@subpolar/runtime`)
│   ├── StatelessSubpolarRuntime
│   ├── context loading and validation
│   ├── run orchestration
│   ├── policy evaluation
│   ├── approval state transitions
│   └── central tool gateway
├── subpolar-db (`@subpolar/db`)
│   ├── owner-scoped repositories
│   ├── sessions and canonical transcripts
│   ├── agents, projects, tools, and policies
│   ├── approvals, runs, audits, events, and idempotency
│   └── PocketBase-specific transactions and capabilities
├── subpolar-core-pi (`@subpolar/runtime-pi`)
│   └── legacy transient Pi SDK adapter (retained until Durable parity gates pass)
├── subpolar-adapter-pi-durable (`@subpolar/adapter-pi-durable`)
│   └── Pi Durable engine adapter and single-owner SQLite execution state
├── subpolar-tools (`@subpolar/tools`)
│   ├── internal tools
│   ├── HTTP/OpenAPI/MCP tools
│   ├── browser, memory, and subagent tools
│   ├── execution adapters
│   └── remote `subpolar-tools` CLI (`@subpolar/tools/cli`)
├── subpolar-runtime-cli (`@subpolar/runtime-cli`)
├── subpolar-agent-server
└── subpolar-agent (`@subpolar/subpolar-agent`)
```

`@subpolar/shared` and `@subpolar/runtime` must not import PocketBase, Hono, React, filesystem-specific Subpolar Agent modules, or Pi implementation modules. The adapters depend on the contracts and are composed by an application boundary.

## Runtime composition

```text
Subpolar Subpolar Agent
    |
    v
HTTP/WebSocket bridge and authentication
    |
    v
Stateless Subpolar Core Runtime
    |                         |
    |                         +--> Pi Durable execution adapter
    |                              (SQLite, single server/storage owner)
    |
    +--> persistence adapter (PocketBase)
    |
    +--> tool registry and central policy gateway
                                  |
                                  +--> approval repository
                                  +--> audit/event repository
                                  +--> tool execution adapters
```

The Subpolar Agent is a transport and presentation layer. It authenticates requests, supplies trusted identity, streams events, and composes adapters. The target canonical prompt path uses the shared stateless runtime, PocketBase application/run/event ports, and the Pi Durable execution adapter. The direct core tool gateway owns canonical definitions, validation, policy, approvals, idempotency, and audit decisions; Subpolar Agent supplies owner-scoped provider implementations, gateway execution implementations, and transport behavior. The existing transient Pi path remains in production until Durable passes provider, tool, transcript, event, cancellation, and recovery parity gates.

## Runtime lifecycle

For every run or resumable continuation:

1. Authenticate the principal at the transport boundary.
2. Construct the core runtime from injected ports.
3. Load the session, project, agent, model configuration, skills, and current policy context from persistence.
4. Load the canonical transcript and construct an in-memory Pi context.
5. Resolve the owner's provider runtime and exact configured model without persisting credentials in Durable storage.
6. Configure or reattach the Pi Durable conversation using a stable Subpolar session ID and submission request ID.
7. Route every model tool call through the central Subpolar tool gateway; re-read or validate current policy at the execution boundary before a tool runs.
8. Persist application transcripts, tool calls, results, approvals, run state, and public events through Subpolar persistence. Persist only execution checkpoints in Pi Durable storage.
9. On restart, reattach the active Subpolar run to its Durable submission and restore the owner-bound provider/gateway context; if safe restoration is impossible, fail closed and report an interrupted run rather than repeating an external side effect.
10. Close the engine cleanly at process shutdown. SQLite remains single-server/single-storage-owner; no distributed safety or exactly-once external effects are implied.

A later request reconstructs its trusted application context from Subpolar persistence and may reattach to Pi Durable execution state. It must not depend on an in-memory-only Pi session or tool-invoker binding.

## Persistence model

The persistence adapter owns the following durable state:

- users and identity references;
- projects and workspace metadata;
- agent definitions and project overrides;
- sessions and canonical structured transcripts;
- runs, run state, and event cursors;
- tool definitions and agent tool policies;
- approvals and encrypted continuation payloads;
- tool-call audit records;
- queues, tasks, subagents, memories, skills, and browser state.

The canonical transcript must preserve enough structure to reconstruct model context, including message IDs, assistant tool calls, tool arguments, tool results, errors, usage metadata, run IDs, and ordering. A plain `role/content` projection is not sufficient as the only durable representation.

## Tool execution flow

```text
Pi emits tool call
    |
    v
Subpolar tool gateway
    |
    +--> canonicalize tool ID
    +--> validate input schema
    +--> load current agent/project/tool policy
    +--> deny
    +--> create durable approval
    +--> allow
              |
              v
       execute through tool adapter
              |
              v
       persist result and audit event
```

All tool callers use the same gateway: Pi, HTTP clients, the tools CLI, automations, and subagents. No adapter may bypass policy checks by calling an execution implementation directly.

## Approval and continuation

Approval is a durable state transition, not a process-local callback.

When approval is required:

1. Persist a pending approval and continuation record.
2. Persist the run as `waiting_for_approval`.
3. Publish an approval event.
4. End or suspend only the transient execution; do not rely on a live Pi process.

When the user approves:

1. Start a new stateless runtime.
2. Claim the approval atomically using its ID and call ID.
3. Reload the session, project, agent, and current policy.
3. Verify that the approved request is still valid and revalidate current tool policy.
4. Execute through the gateway with stable idempotency identity. Tools without their own idempotency guarantee must be treated conservatively after interruption; do not claim exactly-once external effects.
5. Persist the result and continue the run from durable state.

Executable approval input must be recoverable after a process restart without exposing secrets in the UI or audit log. Store a redacted display projection and an encrypted, short-lived continuation payload, together with a request hash and policy/context identifiers.

## Pi adapter rules

The Pi adapter may own transient model execution state, and the Pi Durable adapter may persist execution checkpoints. Neither adapter may:

- call PocketBase directly;
- create or open Pi JSONL session files;
- own session history or application metadata;
- decide tool authorization;
- create approvals independently of the core gateway.

The Pi Durable adapter receives a trusted runtime context, stable conversation/submission identifiers, an owner-scoped provider runtime, and only authorized gateway tool definitions. It emits/project events through the Subpolar run/event contract. Pi Durable's SQLite state is execution state only; the Subpolar transcript and application records remain authoritative. Never register unrestricted built-in tools or persist provider credentials in the Durable database.

## Statelessness and process boundaries

The following are not authoritative and must not be required for recovery:

- process-global active-session maps;
- in-memory pending approval input;
- native Pi session directories;
- bridge-local transcript caches;
- adapter-local completed-result maps for cross-process idempotency.

In-memory maps may be used as optional fast paths for cancellation or active streaming, but durable state and idempotency must be implemented by the selected persistence adapter.

## Acceptance criteria

The architecture is considered implemented when:

1. `@subpolar/core` can run without PocketBase, Subpolar Agent, or Pi implementation imports.
2. The Subpolar Agent composes core with the PocketBase and Pi Durable adapters instead of owning duplicate policy logic.
3. Pi Durable stores execution checkpoints only; canonical sessions and transcripts remain in Subpolar persistence, with a tested migration for existing sessions.
4. A server restart can reattach an owned Subpolar run to its Durable submission and reconstruct owner-scoped provider and gateway context.
5. A process restart during or after approval resumes only after current authorization and approval state are revalidated.
6. Duplicate request IDs are idempotent in Subpolar and Durable records; external side effects are not claimed exactly-once unless each tool implementation independently provides that guarantee.
7. Tool policy changes are enforced at the execution boundary, including after recovery.
8. Session history, usage, search, archive, and event replay operate on Subpolar persistence rather than treating Pi files as application records.
9. Unit, contract, isolated HTTP integration, and manual Docker-backed CLI tests cover execution, cancellation, restart and recovery flows.

## Current implementation status

The current repository has a durable **Subpolar run/event record layer** backed by PocketBase and an experimental `@subpolar/adapter-pi-durable` package backed by SQLite. Production execution still uses the legacy transient `PiSdkSession` / Pi SDK pathway. The adapter is not composed into `/sessions/:id/runs`, has no server-side run reattachment or Subpolar event/transcript projection, and its request-to-tool-invoker binding is in memory only. Therefore Durable execution recovery and production Pi Durable execution are not yet established; retain the legacy path until those parity gates pass.

The `@subpolar/client` and interactive `@subpolar/test-cli` packages provide user-authenticated HTTP/SSE operations for a growing portion of the application. The CLI is a development/debugging client, not a scenario runner. The client includes an owner-scoped run-inspection route, and ordinary WebUI project list/get reads now use the shared client through the existing identity-fenced authenticated transport. The WebUI still has many direct API and WebSocket interactions and has not been converted to use only the shared client. CLI authentication currently requires an existing user token or cookie; it does not persist credentials through an interactive login flow.

An experimental `@subpolar/adapter-pi-durable` package now exercises Pi Durable 1.1.0 with SQLite and a gateway-wrapped tool-definition seam. It is not imported by the production server composition. Recovered tool execution cannot currently restore Subpolar's in-memory invocation bindings, and progress/event projection, approval continuation, provider-account integration, transcript import, and production restart recovery are not implemented. Do not infer recovery parity from the isolated adapter tests.

The production Subpolar Agent composition has completed the PocketBase run-record lifecycle cutover:

- `POST /api/sessions/:id/runs` constructs a fresh runtime with an authenticated owner-bound PocketBase adapter.
- `subpolar_runs` and `subpolar_run_events` are durable sources for run outcomes and replay.
- Pi execution still uses the legacy `PiSdkSession` and an in-memory session manager; it is not yet backed by Pi Durable storage/tasks.
- PocketBase run/event records support application-level status and replay, but do not imply restart recovery of the underlying model/tool execution.
- The active-session map remains part of the legacy Pi execution/streaming path.
- Existing routes for projects, history, usage, tools, agents, approvals, voice, automations, subagents, and CLI compatibility remain in place.

The direct core gateway cutover is complete. Subpolar Agent constructs owner-scoped core gateways for Pi and HTTP tool calls, resolves current PocketBase-backed policy before execution, persists approval/audit/idempotency state, and retains only the execution adapters and transport concerns. Legacy migration code and compatibility data projections remain where needed for existing records and clients; they are not active tool authority.
