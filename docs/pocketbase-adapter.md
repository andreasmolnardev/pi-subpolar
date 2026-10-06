# PocketBase Adapter Composition

The PocketBase adapter is composed by the Subpolar Agent bridge for canonical run outcomes
and run-event replay. Its exact composition seam is:

1. The application composition root supplies a `PocketBaseClientPort` whose
   `collection(name)` method wraps the concrete PocketBase SDK collections.
2. The composition root optionally supplies `PocketBaseTransactionPort` and
   `PocketBaseIdempotencyPort` implementations whose guarantees are real for
   the deployed PocketBase setup.
3. The root constructs `createPocketBaseAdapter({ client, collections, ... })`.
4. Core code receives only `adapter.agents`, `adapter.projects`,
   `adapter.sessions`, `adapter.approvals`, `adapter.audits`, `adapter.events`,
   and the capability report. It never receives a raw collection or route.
5. The application composition root translates its authenticated principal to
   the repository `ownerId`, creates owner-bound run/event and gateway ports,
   and injects them into a fresh `StatelessSubpolarRuntime` for each canonical
   prompt run. Pi execution is supplied through the transient Pi adapter and an
   in-memory SDK session.

For tool calls, load the current records with
`adapter.policies.list(ownerId, { agentId, projectId })` and pass them to
`createGateway({ tools, policyRules, ...createPocketBaseGatewayPorts(adapter,
ownerId), execute })` from `@subpolar/core`. Core owns validation, rule
selection, deny/approval/allow precedence, durable approval state, claims,
idempotency, and audit decisions. The executor is the only host-specific seam.
The owner-bound helpers are `createPocketBaseApprovalStore`,
`createPocketBaseApprovalContinuationPort`, `createPocketBaseApprovalClaimPort`,
`createPocketBaseIdempotencyPort`, and `createPocketBaseAuditPort`.

## Capability Rules

Configured collections provide the persistence boundary for sessions,
approvals, audits, and published events. Replay must be explicitly enabled with
`eventReplay: true`. Transactions and idempotency require explicit ports. The
adapter reports `multi-process-concurrency: false` because ordinary collection
calls do not provide a transaction or cross-process exactly-once guarantee.
Unsupported operations return a typed `UNSUPPORTED_CAPABILITY` error instead of
silently degrading.

## Migration Risks

- The current collection port is a minimal source-compatible seam, not a claim
  that every PocketBase SDK version has these exact method signatures.
- Owner filtering is enforced by the adapter, but the eventual PocketBase
  rules must also prevent a compromised server-side composition layer from
  reading another owner's records.
- Session append is not atomic without an injected transaction boundary; two
  processes can still lose an update.
- Event publication is not idempotent unless an idempotency port or collection
  uniqueness rule is supplied. Replay ordering currently follows collection
  list order.
- Approval records are durable when the approval collection is present, but
  approval execution and tool execution are not one transaction in this phase.
- Existing Subpolar Agent routes and local JSON session data have different schemas.
  Migration needs an explicit owner identity, collection rules, timestamp
  policy, and a backfill/rollback plan before production wiring.

Run the package contract tests with:

```sh
bun test packages/subpolar-persistance-pocketbase
```
