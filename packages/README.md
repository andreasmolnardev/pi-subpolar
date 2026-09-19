# Subpolar Package Foundation

These packages are a small, local foundation for later composition. They are
not a full Pi integration and do not implement Phase 14. Pi execution,
multi-process durability, HTTP, WebUI, PocketBase, and approval persistence
remain outside this boundary.

## Package Boundaries

Installed workspace consumers should import `@subpolar/contracts`,
`@subpolar/core`, `@subpolar/adapter-local`, and `@subpolar/cli` through each
package's `exports` map. The repository's source-only test path intentionally
uses relative source imports as a fallback because this checkout has no
installed workspace links or lockfile. Those imports must stay within these
packages and must not pull in Pi, WebUI, PocketBase, HTTP, or server modules.

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

The CLI currently composes only the named `local-fixture-echo` executor. It is
a smoke seam for the package boundary, not Pi or Phase 14 functionality.
