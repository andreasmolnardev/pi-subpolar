# Multi-user provider persistence

Provider persistence uses an explicit PocketBase user ID. PocketBase filters are query constraints, not the final authorization boundary: these services also validate returned records, including when a privileged client or test store ignores filters.

## Returned-record fences

- `ProviderAccountService.listAccounts` removes foreign-owner records before parsing or projecting metadata. `getAccount`, status, update, delete, and credential loading require exact returned `user_id` and normalized `instance_id` matches. A mismatched first record is treated as missing; the service does not scan for another match or fall back to ambient credentials.
- Account create/update responses must match the requested owner, instance, and provider before projection. A foreign create response is not used for credential creation or rollback deletion; a foreign update response is not used for subsequent credential writes.
- Credential loading verifies owner, instance, and any stored provider selector before decryption or last-used updates. Credential replacement and deletion reject mismatched credential records **before any account metadata or credential mutation**. A missing credential is distinct from a returned mismatched credential: only a genuinely missing row permits credential creation.
- New/replaced credential rows include `provider_type`. Collection initialization adds this optional field to existing deployments. Legacy rows with absent/empty `provider_type` remain readable; provider and auth-type binding for those rows is cryptographically verified during decryption, not by a legacy plaintext selector.
- Custom-provider listing removes foreign records before constructing the public CRUD/discovery configuration. Save verifies owner and provider ID before decrypting, preserving, or replacing secrets, and validates its write response before projection. Delete ignores returned mismatches. Public configuration excludes encrypted payloads, secret headers, and sensitive nested model/override keys. This service adds no executor, environment credential fallback, or public secret retrieval API.
- Login-flow `getOwned`/`deleteOwned` require exact owner and flow ID before projection, stale-flow expiration, or deletion. `set` checks both fields on the initial lookup and after a create race. Completed results must match the enclosing flow's flow ID, provider instance, runtime provider, and auth type. Unknown fields and provider-controlled error text are not projected.

The legacy flow `get(flowId)` and `delete(flowId)` methods are **server-internal, unowned operations**. They verify the returned flow ID, but cannot authenticate a caller without an owner argument. User-facing access must use the owned methods. Login flow IDs remain globally unique in the production schema; tests intentionally simulate duplicate IDs to exercise owner fencing independently of that constraint.

These fences do not make arbitrary storage writes transactional or defend against a database that mutates a different row than the requested record ID. They reject unauthorized returned records and prevent the application from selecting foreign IDs for subsequent operations. A mismatched write response can be detected only after that write has happened.

## Encryption and native sign-in compatibility

AES-256-GCM envelopes and AAD are unchanged:

- Accounts: `subpolar/provider-account/v1`, user ID, instance ID, provider type, auth type (NUL-separated).
- Custom providers: `subpolar/custom-provider/v1`, user ID, provider ID (NUL-separated).

Native Pi 1.0.2 credentials are serialized without dropping OAuth extension fields such as issued client IDs and scopes. Installation device identity, browser-login defaults, device-code selection, direct ChatGPT native registration, and refresh behavior are unchanged. No bridge, runtime, or UI implementation is changed by this persistence follow-up. Custom-provider inference is outside this change; unknown custom providers remain subject to the separately hardened runtime's fail-closed behavior.

## Validation

From `@subpolar-agent`, run the bounded provider suite using the existing workspace dependencies (no install needed):

```sh
bun run --bun vitest run --maxWorkers=2 server/tests/multi-user-providers.test.ts server/tests/provider-login-flow-store.test.ts server/tests/custom-providers.test.ts server/tests/provider-auth.test.ts
```

The new multi-user tests cover:

- Two owners with identical account instance/provider IDs, an unfiltered store returning the foreign record first, and no foreign read/status/refresh/metadata/delete side effects.
- Credential owner, instance, and provider mismatches with intentionally invalid ciphertext, demonstrating rejection before decryption; refresh/delete failures leave both collections unchanged.
- Authorized OAuth refresh, extension-field preservation, metadata and last-used updates, and owner-only deletion.
- Legacy envelope tampering across owner, instance, provider, and auth-type AAD bindings.
- Foreign account create/update responses, including no foreign rollback deletion or subsequent credential write.
- Custom-provider foreign-first listing/save/delete, wrong selectors, secret-preserving metadata updates, public secret stripping, owner-only deletion, and foreign write-response rejection.
- Flow owner/ID checks before expiration/projection/update/delete, duplicate flow IDs across owners, create-race selector checks, known-field projection, and inconsistent completed-result rejection.

The existing provider-auth suite additionally exercises native Codex device-code login, the browser-default prompt, installation device UUID persistence, direct ChatGPT registration/login/refresh, issued client IDs/scopes, and account isolation.
