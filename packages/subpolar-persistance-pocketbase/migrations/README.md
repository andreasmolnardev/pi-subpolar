# PocketBase persistence migration

`001_target_persistence.json` is the package-local schema manifest for the target
persistence surface. It intentionally lives with the adapter rather than the
application or WebUI. Apply the collection definitions and indexes to the
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
