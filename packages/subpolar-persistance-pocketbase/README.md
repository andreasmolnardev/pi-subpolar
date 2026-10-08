# PocketBase Adapter Foundation

`@subpolar/adapter-pocketbase` is a Phase 0A adapter boundary. It depends only
on `@subpolar/contracts` and accepts small, injected PocketBase-like ports. It
does not import PocketBase, Subpolar Agent routes, Hono, HTTP handlers, Pi runtime code,
or bridge code.

The factory returns owner-scoped repositories for agents, projects, sessions,
canonical structured transcripts, runs/events, tool definitions/policies,
approvals/opaque continuations, audit records, events, and durable call IDs.
The raw client and collection ports are used only during composition and are not
exposed by the returned adapter. Every read and mutation receives an `ownerId`;
records from another owner are not returned, and cross-owner mutations fail with
`OWNER_SCOPE_DENIED`.

The canonical transcript, run/event, tool-definition/policy, opaque approval
continuation, atomic approval claim, and durable call-id idempotency contracts
are defined by `@subpolar/contracts`. `src/durable.ts` implements those shared
interfaces with owner-scoped PocketBase persistence and re-exports the shared
types for compatibility with existing adapter imports.

## Workspace setup

From the repository root, use Bun 1.3.14 and `bun install --frozen-lockfile`.
The hoisted workspace shares compatible dependencies, but incompatible versions
may still require nested copies. Do not install separately in this package.
Owner-scoped persistence does not create an OS sandbox or certify live multi-user
execution. Live two-user verification remains outstanding; see
[Bun and multi-user operations](../../docs/bun-and-multi-user.md).

## Core gateway composition

The shared policy/approval authority lives in `@subpolar/core`. Bind one
authenticated owner to the durable ports at the application composition root:

```ts
import { createGateway } from "@subpolar/core";
import {
  createPocketBaseAdapter,
  createPocketBaseGatewayPorts,
} from "@subpolar/adapter-pocketbase";

const adapter = createPocketBaseAdapter({ client, collections, transaction });
const ports = createPocketBaseGatewayPorts(adapter, ownerId);
const policyRules = await adapter.policies.list(ownerId, { agentId, projectId });
const gateway = createGateway({
  tools,
  policyRules,
  ...ports,
  execute: (call, definition, context) => executeTool(call, definition, context),
});
```

`createGateway` accepts either a resolver or PocketBase-derived
`ToolPolicyRecord[]`. It selects the most specific matching agent/project rule,
uses deny > approval > allow precedence, and fails closed when no rule matches.
The owner-bound port factory supplies durable approvals, opaque continuation
storage, atomic approval claims, durable call-id idempotency, and audit writes.
It does not import core or Subpolar Agent, so a Subpolar Agent executor remains only an execution
adapter during migration rather than a second policy authority.

## Capabilities

Session, approval, audit, and event publication persistence are enabled only for
the corresponding configured collection. Event replay additionally requires the
explicit `eventReplay: true` option. Transactions, idempotency, and conditional
updates are enabled only when their explicit ports are injected. A durable
approval decision is accepted only when one of those atomic capabilities is
available. Transactions are preferred; transaction-backed decisions re-read the
row and verify that it is terminal before returning. Without an atomic
capability, `approvals.decide()` fails before changing the row with
`PocketBaseUnsupportedCapabilityError` (`pocketBaseCapability:
"approval.atomic-decision"`). Multi-process concurrency is claimed only when an
injected transaction, conditional-update, idempotency, or atomic-claim port
explicitly sets `multiProcessSafe: true`; collection presence alone never
claims cross-process atomicity.

All persisted shapes are constructed from whitelisted fields. The repository
owner, PocketBase record ID, approval timestamps, and audit/event persistence
timestamp cannot be supplied through arbitrary caller fields. Domain IDs remain
the explicit IDs in the repository contracts. Approval requests and audit/event
JSON are recursively redacted for sensitive field names such as `token`,
`password`, `secret`, `credential`, and `authorization`, both when writing and
when mapping stored records.

Unsupported operations throw `PocketBaseUnsupportedCapabilityError` with the
stable `UNSUPPORTED_CAPABILITY` code. The error extends the common
`UnsupportedCapabilityError`; its `capability` uses the common capability name
(`transactions`, `idempotency`, `conditional-updates`, and atomic approval
decisions map to `multi-process-concurrency`) and `pocketBaseCapability` retains
the adapter-specific name. The adapter-only collection capabilities
`agent.persistence`, `project.persistence`, `audit.persistence`, and
`event.publication` map to the common `session.persistence` name because the
common contract has no generic persistence capability. The adapter does not
infer PocketBase transactions, durable idempotency, or event replay from the
fact that a collection exists.

`createPocketBaseSessionStore(adapter, ownerId)` is the explicit bridge to the
core `SessionStore` contract. It binds one authenticated owner at composition
time, so core's ownerless `load()` and `append()` methods cannot select another
owner. Its `capabilities` preserves the PocketBase support flags; the common
contract's legacy `json-file` durability value is only a compatibility marker.

The fake-client tests are the contract example. They compare session and policy
approval outcomes with the local foundation, exercise cross-user denial, and
verify unsupported capability behavior.

Memory persistence also requires an explicitly configured `memories` collection.
Memory mappings construct owner, scope, and record ID fields from trusted adapter
values rather than caller-supplied overrides. Memory persistence does not imply
idempotency; that capability is advertised and usable only when an explicit
`idempotency` port is injected, otherwise `idempotency.execute()` throws the
typed `PocketBaseUnsupportedCapabilityError`.

The package-local `migrations/001_target_persistence.json` manifest describes
canonical transcript, run, run-event, tool, policy, continuation, and call-claim
collections plus their owner-scoped uniqueness indexes. Continuation payloads are
opaque encrypted values supplied by the caller; the adapter does not decrypt,
print, or put them in audit/event data.
