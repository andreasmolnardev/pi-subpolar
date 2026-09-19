# PocketBase Adapter Composition

The Phase 0A PocketBase adapter is intentionally not wired into `@webui` or the
bridge. Its exact composition seam is:

1. The application composition root supplies a `PocketBaseClientPort` whose
   `collection(name)` method wraps the concrete PocketBase SDK collections.
2. The composition root optionally supplies `PocketBaseTransactionPort` and
   `PocketBaseIdempotencyPort` implementations whose guarantees are real for
   the deployed PocketBase setup.
3. The root constructs `createPocketBaseAdapter({ client, collections, ... })`.
4. Core code receives only `adapter.agents`, `adapter.projects`,
   `adapter.sessions`, `adapter.approvals`, `adapter.audits`, `adapter.events`,
   and the capability report. It never receives a raw collection or route.
5. A future WebUI or Pi composition layer can translate its authenticated
   principal to the repository `ownerId` and inject the adapter into a core
   service. That wiring is deliberately deferred.

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
- Existing WebUI routes and local JSON session data have different schemas.
  Migration needs an explicit owner identity, collection rules, timestamp
  policy, and a backfill/rollback plan before production wiring.

Run the package contract tests with:

```sh
bun test packages/subpolar-adapter-pocketbase
```
