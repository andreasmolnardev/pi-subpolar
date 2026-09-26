# Subpolar Architecture

This document defines the target architecture for the Subpolar monorepo.

## Core invariant

PocketBase (or the selected persistence adapter) is the source of truth for all durable Subpolar state.

The Subpolar core runtime is stateless. A runtime instance may hold transient data while one execution is active, but it must not cache or persist user/application state in process-global memory. Pi is an execution engine, not a persistence engine.

Pi must not persist:

- sessions or transcripts;
- agents, projects, or tool policies;
- approvals or audit records;
- run state, queues, or resumable execution state;
- usage history or application metadata.

At runtime initialization, and whenever a new execution or tool call requires context, the core obtains the authoritative state through injected persistence ports. A process restart must be recoverable from the persistence adapter without reading Pi-owned session files.

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
├── subpolar-runtime-pi (`@subpolar/runtime-pi`)
│   └── transient Pi SDK execution adapter
├── subpolar-tools (`@subpolar/tools`)
│   ├── internal tools
│   ├── HTTP/OpenAPI/MCP tools
│   ├── browser, memory, and subagent tools
│   └── execution adapters
├── subpolar-runtime-cli (`@subpolar/runtime-cli`)
├── subpolar-tools-cli (`@subpolar/tools-cli`)
├── subpolar-webui-server
└── subpolar-webui (`@subpolar/webui`)
```

`@subpolar/shared` and `@subpolar/runtime` must not import PocketBase, Hono, React, filesystem-specific WebUI modules, or Pi implementation modules. The adapters depend on the contracts and are composed by an application boundary.

## Runtime composition

```text
Subpolar WebUI
    |
    v
HTTP/WebSocket bridge and authentication
    |
    v
Stateless Subpolar Core Runtime
    |                         |
    |                         +--> transient Pi SDK adapter
    |
    +--> persistence adapter (PocketBase)
    |
    +--> tool registry and central policy gateway
                                  |
                                  +--> approval repository
                                  +--> audit/event repository
                                  +--> tool execution adapters
```

The WebUI is a transport and presentation layer. It authenticates requests, supplies trusted identity, streams events, and composes adapters. Canonical prompt runs use the shared stateless runtime, PocketBase run/event ports, and transient Pi adapter. The direct core tool gateway owns canonical definitions, validation, policy, approvals, idempotency, and audit decisions; WebUI supplies only execution implementations and transport behavior.

## Runtime lifecycle

For every run or resumable continuation:

1. Authenticate the principal at the transport boundary.
2. Construct the core runtime from injected ports.
3. Load the session, project, agent, model configuration, skills, and current policy context from persistence.
4. Load the canonical transcript and construct an in-memory Pi context.
5. Create a transient Pi execution with no persistent session directory.
6. Route every model tool call through the central Subpolar tool gateway.
7. Re-read or validate current policy at the execution boundary before a tool runs.
8. Persist transcript messages, tool calls, results, approvals, run state, and events through the persistence adapter.
9. Dispose the Pi execution after completion, failure, interruption, or an approval pause.

A later request starts a new runtime and reconstructs its context from persistence. No later request may depend on an in-memory Pi session object.

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
4. Verify that the approved request is still valid.
5. Execute the tool exactly once through the gateway.
6. Persist the result and continue the run from durable state.

Executable approval input must be recoverable after a process restart without exposing secrets in the UI or audit log. Store a redacted display projection and an encrypted, short-lived continuation payload, together with a request hash and policy/context identifiers.

## Pi adapter rules

The Pi adapter may own transient model execution state only. It must not:

- call PocketBase directly;
- create or open Pi JSONL session files;
- own session history or application metadata;
- decide tool authorization;
- create approvals independently of the core gateway.

The adapter receives a runtime context and a transcript projection, runs Pi, emits normalized events, and is disposed after the operation. If the Pi SDK requires a session manager, the composition must provide a non-persistent in-memory implementation or an equivalent adapter.

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

1. `@subpolar/runtime` can run without PocketBase, WebUI, or Pi imports.
2. The WebUI composes the core with PocketBase and Pi adapters instead of owning duplicate policy logic.
3. Pi creates no persistent session or transcript files.
4. A new runtime can reconstruct a session entirely from PocketBase.
5. A process can stop after creating an approval, restart, approve the request, and execute it exactly once.
6. Duplicate call IDs return the durable result without re-executing the tool.
7. Tool policy changes are enforced at the execution boundary.
8. Session history, usage, search, archive, and replay operate on the persistence adapter rather than Pi files.
9. Unit, contract, integration, and manual WebUI tests cover the restart and approval flows.

## Current implementation status

The production WebUI composition has completed the run-lifecycle cutover:

- `POST /api/sessions/:id/runs` constructs a fresh runtime with an authenticated owner-bound PocketBase adapter.
- `subpolar_runs` and `subpolar_run_events` are durable sources for run outcomes and replay.
- Pi execution is wrapped by `@subpolar/runtime-pi` and uses `SessionManager.inMemory()` only.
- The active-session map is only a streaming/cancellation fast path; terminal replay does not require it.
- Existing routes for projects, history, usage, tools, agents, approvals, voice, automations, subagents, and CLI compatibility remain in place.

The direct core gateway cutover is complete. WebUI constructs owner-scoped core gateways for Pi and HTTP tool calls, resolves current PocketBase-backed policy before execution, persists approval/audit/idempotency state, and retains only the execution adapters and transport concerns. Legacy migration code and compatibility data projections remain where needed for existing records and clients; they are not active tool authority.
