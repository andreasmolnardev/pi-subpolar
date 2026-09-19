# PocketBase Adapter Foundation

`@subpolar/adapter-pocketbase` is a Phase 0A adapter boundary. It depends only
on `@subpolar/contracts` and accepts small, injected PocketBase-like ports. It
does not import PocketBase, WebUI routes, Hono, HTTP handlers, Pi runtime code,
or bridge code.

The factory returns owner-scoped repositories for agents, projects, sessions,
approvals, audit records, and events. The raw client and collection ports are
used only during composition and are not exposed by the returned adapter.
Every read and mutation receives an `ownerId`; records from another owner are
not returned, and cross-owner mutations fail with `OWNER_SCOPE_DENIED`.

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
"approval.atomic-decision"`). Multi-process concurrency is never claimed by
this foundation.

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
