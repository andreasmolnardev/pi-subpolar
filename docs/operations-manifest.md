# Operations Manifest

`@subpolar/contracts` exposes an adapter-neutral, versioned operations manifest. The wire format is `operations-manifest/v1`; `version` is the contract version and must be checked before processing a manifest.

## Safety contract

- Migration plans identify source and destination formats, compatibility, and strictly increasing ordered steps. Each step carries a `sha256:<64 lowercase hex>` checksum. Steps requiring manual intervention must include a reason and instructions.
- Backup artifacts are limited to configuration, database, filesystem, index, metadata, and transcript classes. Secret-bearing paths and media types are rejected, and artifacts must be encrypted.
- Restore explicitly declares `merge`, `replace`, or `rebuild`, plus dry-run, overwrite, and approval requirements. An approval ID is required when approval is required.
- Retention is categorized as active, archive, expired, or tombstone. Tombstone retention is explicit and can have its own age.
- Limits cover artifact count/size, total size, migration steps, and diagnostic count. Timeouts and truncation are explicit policy values.
- Diagnostics use an allowlist of code, field, count, or redacted details. They require correlation IDs, a redaction marker, bounded messages, and reject secret-looking names or values.

`validateOperationsManifest` performs structural and safety validation and returns all errors. `serializeOperationsManifest` validates first, then uses `stableSerialize`, which sorts object keys and rejects cycles, non-finite numbers, and non-JSON values. Serialization is therefore stable across adapters but does not itself calculate checksums; adapters calculate and verify the declared SHA-256 values over their canonical payloads.
