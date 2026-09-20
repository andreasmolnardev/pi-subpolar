# Operations Runtime

`@subpolar/operations` is a narrow P15 consumer of `OperationsManifest` from
`@subpolar/contracts`. It only builds, validates, serializes, and reports
operations plans.

`buildOperationsManifest` emits a manifest only after contract validation.
`createManifestReport` and `validateManifestReport` return deterministic errors
and stable serialization. Migration inputs are limited to `backup/v1` and
`backup/v2`; resource limits and encrypted, non-secret backup artifacts are
required.

`createDryRunReport` reports planned migration steps, artifact count, and bytes.
It always returns `performed: false`: it does not copy files, access a database,
create backups, or restore anything. Secret-bearing artifact paths are refused,
invalid limits and manifests are refused, and destructive restores require an
explicit approval flag in addition to the manifest approval policy.

`verifyMigrationSteps` is an offline checksum preflight. It validates the
manifest first, hashes supplied `Uint8Array` payloads with SHA-256, detects
missing and unexpected IDs, and returns results in manifest order. Its stable
error codes are `INVALID_MANIFEST`, `MISSING_PAYLOAD`, `UNEXPECTED_PAYLOAD`, and
`CHECKSUM_MISMATCH`. It does not execute migration steps, mutate inputs, or use
the network or filesystem.
