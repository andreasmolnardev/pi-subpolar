# Subpolar Package Foundation

These packages are a small, local foundation for composition. Pi execution is
available through the injected `@subpolar/adapter-pi` port; it does not import
the Pi runtime itself. Multi-process durability, HTTP, Subpolar Agent, PocketBase, and
approval persistence remain outside this boundary.

## Package Boundaries

The canonical contract identity is `@subpolar/contracts`; package manifests and
imports must use that name. The former `@subpolar/shared` identity is not kept
as a second workspace package because two names for the same contract package
would make workspace resolution ambiguous.

The current importable foundation identities are `@subpolar/contracts`,
`@subpolar/runtime`, `@subpolar/db-local`, `@subpolar/runtime-pi`, and
`@subpolar/runtime-cli`. These map to the requested modular roles as follows:
contracts, core, local adapter, Pi adapter, and CLI. Existing import identities
other than the concrete contracts mismatch remain unchanged for compatibility.
The repository's test commands use source paths in several packages; their
imports must stay within the package boundaries and must not pull in Subpolar
Agent, PocketBase, HTTP, or server modules. Core and contracts do not import Pi.

## Gateway Semantics

Each gateway has exactly-once behavior for a `callId` within that gateway
instance. Completed results and in-flight calls are held in memory, so a
duplicate returns the original result without executing again, including after
an audit sink fails. If execution completed but audit emission failed, the
first call returns `AUDIT_FAILED`; that result is cached and repeated calls
return the same result. This is not a durable or multi-process idempotency
guarantee. A future durable deployment must inject a shared result store at
the composition boundary rather than infer durability from this gateway.

Audit and executor error output is redacted, including secrets embedded in
ordinary strings and JSON-encoded key/value strings. Successful executor
values remain executor output and are not treated as a secret store.

## Local Adapter Limits

The ephemeral adapter is process-local. The JSON adapter validates session IDs,
records, timestamps, and transcript entries before use; it uses null-prototype
record maps and serializes operations per store instance. Its
`multi-process-concurrency` capability is explicitly false. Separate store
instances or processes pointing at one file are not coordinated and must not
be used as a transactional or durable shared store.

The CLI uses the named `local-fixture-echo` executor only when no Pi factory or
module is configured. A configured Pi factory/module is loaded lazily and is
reported as `pi`; there is no implicit claim that the fixture executed Pi.
