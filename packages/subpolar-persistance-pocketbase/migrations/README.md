# PocketBase persistence migration

`001_target_persistence.json` is the package-local schema manifest for the target
persistence surface. It intentionally lives with the adapter rather than the
application or Subpolar Agent. Apply the collection definitions and indexes to the
PocketBase deployment used to compose this adapter.

The adapter collection option names are camel-cased (`transcripts`, `runs`,
`runEvents`, `tools`, `policies`, `continuations`, and `callClaims`); the
manifest uses the recommended PocketBase collection names. PocketBase field
names may be mapped to the adapter's camel-cased injected record shape at the
client boundary.

The `opaque_payload` and `claim_token` fields are opaque values. The adapter
never decrypts, prints, or includes them in audit/event JSON. `owner_id` is part
of every uniqueness and lookup boundary so records cannot be shared across
owners.

`002_automation_persistence.json` describes the independent first-class
automation collections. Occurrences have a stable unique key per owner and
automation, while executions reference canonical Subpolar runs rather than
copying their transcripts. Action rows record uncertain completion as
`unknown` so a recovery worker can avoid replaying irreversible effects without
proof that replay is safe. The `subpolar_automation_schedules` collection keeps
the scheduler cursor and due-time metadata needed to resume after restart.

Occurrence claims are only cross-process safe when the application injects an
atomic claim or conditional update port that provides that guarantee. Without
one, the adapter reports atomic claims as unsupported; stable uniqueness alone
does not mean trigger processing is exactly once. JSON values are sanitized so
secret-like fields are redacted before persistence.

PocketBase treats `false` boolean values and empty JSON objects as blank for
`required` validation. Therefore automation `enabled`, `executionConfig`, and
zero-based action `ordinal` fields are optional at the storage schema layer;
the domain adapter supplies the intended values and defaults. Migrations
`1791510002`–`1791510004` adjust existing development schemas accordingly.
