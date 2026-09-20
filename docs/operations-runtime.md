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
