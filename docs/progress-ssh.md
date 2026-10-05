# Feature18 — SSH / remote execution

## Status: security foundation only; feature NOT complete

There is **no SSH transport, remote command execution, profile persistence, or
host-key enrollment API** implemented by this change. The new policy module is
not wired into production routes or the tool executor. It must not be advertised
as working remote execution. No packages were added or installed, and no shell
executor, automatic trust, or second permission authority was introduced.

## Repository inspection

- `@webui/src/api/ssh.ts` previously posted
  `{ requestId, response: 'accept' | 'reject' }` to
  `POST /api/ssh/host-key/respond` and assumed a `{ success, error? }` response.
  This is a legacy **client expectation**, not an implemented backend contract.
- `src/api/types.ts` describes the legacy `ssh.host-key-request` SSE payload,
  including `isKeyChanged`; the frontend dialog and event context still exist.
  A frontend event or boolean is not evidence of a verified server challenge.
- The current `server/bridge-request-handler.ts` dispatches the existing domain
  routes and returns `{ error: 'Not found' }`, HTTP 404, when none handles a
  request. No SSH response handler, challenge issuer, or SSH transport was found
  in these routes or the bridge runtime. Authentication may reject a request
  earlier. There is no legitimate backend host-key acknowledgement to simulate.
- `src/api/settings.ts` also has a legacy `testSSHConnection` helper that posts
  inline key material to `/api/settings/test-ssh`; no matching backend handler
  was found. That helper and Git credential UI are outside this change's scope;
  they must not be reused as a remote execution credential service.
- No SSH settings component (`settings/*Ssh*`, including case variants) was found.
  The host-key dialog is in `src/components/ssh`, outside the owned UI scope,
  and was not modified. Its accept button may still render; the API helper now
  refuses approval explicitly and cannot silently trust a key.
- `@webui/package.json` declares no SSH transport dependency. Existing remote
  tool adapters are not a verified SSH connection facility. No dependency was
  added, and an OS `ssh` subprocess was not introduced as a substitute.
- The existing shared gateway is composed by `createCoreToolGateway` in
  `server/application/tools/tools.ts`; `packages/subpolar-core` owns permission
  resolution, approvals, idempotency, and audits. It remains the authority.

## Implemented

### `@webui/server/application/ssh-policy.ts`

- Strict, owner-bound remote profile validation: profile ID, owner, name,
  hostname/IP, explicit port, username, opaque server credential reference, and
  a nullable pre-enrolled host-key pin. Inline private keys, passwords,
  passphrases, extra options, and unknown fields are rejected with fixed errors
  that do not reflect submitted values.
- Public profile serialization uses an explicit allowlist and omits owner and
  credential reference. `hasCredential` means a reference is configured, **not**
  that a vault entry exists or authentication has succeeded. Every view reports
  `executionAvailable: false`.
- SHA256 fingerprints are computed from the actual SSH public-key wire bytes,
  not a fingerprint claimed by the client. This initial policy deliberately
  supports **Ed25519 only** and validates its exact SSH wire layout. Unsupported
  algorithms, malformed bytes, and noncanonical fingerprints are rejected.
- Unknown keys are refused with `UNKNOWN_HOST_KEY`; mismatches are refused with
  `HOST_KEY_CHANGED`. Verification does not mutate trust or offer a boolean
  bypass. Pins must come from trusted server storage after out-of-band enrollment;
  accepting a pin supplied by the requesting agent/client would defeat this policy.
- `SSH_REMOTE_EXECUTION_AVAILABLE` is false; `requireSshTransport()` always throws
  `SSH_TRANSPORT_UNAVAILABLE`. Neither verification nor this guard is a tool
  permission decision, a transport implementation, or a gateway integration.
- Endpoint syntax validation is **not** network authorization. Private IPs can
  be described, but no connection is made. Deployment network restrictions and
  DNS/address binding remain prerequisites for a future transport.

### `@webui/src/api/ssh.ts`

- Host-key acceptance fails before any network request with
  `SSH_TRANSPORT_UNAVAILABLE` until a real authenticated trust flow exists.
  This intentionally disables the legacy UI's acceptance path, including any
  changed-key acceptance; a bare `approved: true` can never enroll/rotate a pin.
- Rejection preserves the actual existing client wire shape (`response: 'reject'`),
  validates its request ID, requires a literal successful acknowledgement, and
  returns only `{ success: true }`. Missing routes, malformed JSON, negative
  acknowledgements, and network errors throw rather than masquerading as success.
- SSH response errors do not expose arbitrary backend messages, details, or
  exception text that could contain credentials. This is not a claim of global
  redaction: future command output, connection logs, vault access, and audit
  payloads still need their own bounded, secret-safe handling.

## User/deployment decisions required

1. **Transport deployment:** choose a supported server-side SSH library (a future
   dependency decision) or a separately deployed managed SSH service with a
   reviewed protocol. Specify where it runs, who operates it, and which remote
   networks/hosts it may reach. Do not enable shell-based fallback implicitly.
2. **Credential custody:** decide on server-side encrypted vault versus an
   isolated managed SSH agent, owner isolation, key/passphrase provisioning,
   backup/rotation/revocation, and who holds decryption keys. No browser storage,
   agent prompt, SSE, tool arguments, or audit records may carry private keys or
   passphrases. Agent forwarding is not enabled by this foundation.
3. **Trust enrollment:** provide administrator/operator-verified host fingerprints
   through an independent channel, scoped to owner + profile + canonical host +
   port. Decide who can enroll/revoke pins and whether Ed25519-only meets the fleet's
   requirements. Scanning a key over the same untrusted connection is not proof.
4. **Key rotation:** decide a separate privileged, audited out-of-band re-enrollment
   process. Changed keys must remain a hard stop, not an accept/retry button.
5. **Execution semantics:** choose the permitted remote commands/workspaces,
   remote account privilege ceiling, concurrency/time/output limits, cancellation,
   and file access rules. SSH authenticates a host/account; it does not authorize
   a tool call or grant remote root privileges.

## Safe integration plan (not implemented)

1. Persist owner-scoped profiles and immutable/versioned trust records; resolve
   profiles and credentials server-side. Never allow execution input to override
   the selected host, username, credential reference, or pin.
2. Register any remote tool through the existing canonical tool registry and
   shared core gateway. Preserve principal/session/project/agent/call identity,
   capability ceilings, policy denies, approvals, idempotency, and audit flow.
   Only the gateway-admitted executor may resolve the transport. No SSH-specific
   `approved` flag or UI host-key decision can authorize command execution.
3. Inside that executor, resolve a permitted endpoint and bind the actual
   connection to its validated address/host/port. Block proxy/jump/config escape
   paths unless separately reviewed. Apply deployment egress rules including
   private-network policy; do not inherit HTTP defaults blindly.
4. Have the SSH handshake expose the actual peer key to `verifySshHostKey`
   **before credentials are transmitted or a session opens**. Abort unknown,
   malformed, or changed keys. Fail closed on cancellation, deadline, vault
   unavailability, or trust version changes. Verification helpers alone cannot
   enforce this ordering without a transport adapter.
5. Add an authenticated owner-scoped enrollment flow only if interactive
   enrollment is selected: server-issued expiring, single-use challenges bound
   to the exact owner/profile/endpoint/key/trust version; reject cross-owner,
   stale, replayed, and changed-key responses. Authenticate/authorize mutations
   and audit them separately from execution approval. The legacy boolean API is
   insufficient and must not be enabled as-is.
6. Add mocked gateway-to-transport tests proving denies/pending approvals never
   connect, credentials are never sent before pin verification, and cancellation,
   timeouts, bounded output, redaction, replay, rotation, and owner isolation work.
   Then validate against operator-provisioned known/unknown/changed-key hosts.
   Routes, persistence, gateway composition, capability reporting, and UI wiring
   require a separately owned integration change.

## Validation

- Focused tests: `./node_modules/.bin/vitest run
  server/tests/remote-execution-ssh-policy.test.ts
  server/tests/remote-execution-ssh-api.test.ts --reporter=dot` — **41 passed**.
  HTTP is mocked at `fetch`; no hosts are contacted and no SSH execution is claimed.
- Targeted strict TypeScript check of the policy and its tests passed:
  `./node_modules/.bin/tsc --noEmit --strict --skipLibCheck --target ES2022
  --module ESNext --moduleResolution bundler --allowImportingTsExtensions
  --types node server/application/ssh-policy.ts
  server/tests/remote-execution-ssh-policy.test.ts`.
- `npm run bridge:typecheck` failed with 46 errors across existing runtime,
  dependency declarations, adapters, tests, and frontend imports. The new API
  test also pulls the frontend `@/config` alias into the bridge TS project, which
  does not define that alias; this integration check is not green. No errors
  were reported in the new SSH policy module. Unowned code was not changed to
  suppress these diagnostics.
- The first app TypeScript check timed out after 120 seconds. A second run of
  `./node_modules/.bin/tsc --noEmit -p tsconfig.app.json --pretty false` completed
  with an unrelated error in `src/components/navigation/DesktopSidebar.tsx:372`
  (`{}` is not assignable to `string`); no SSH file errors were reported.
- Shared gateway regression coverage: `approval-execution.test.ts` and
  `tool-routing.test.ts` passed under Vitest (**6 tests**). The initial combined
  Vitest command could not load `gateway-credentials.test.ts` because it imports
  `bun:test`; rerunning it with `bun test server/tests/gateway-credentials.test.ts`
  passed (**4 tests**).
- `git diff --check` passed.

Only the SSH API helper, new policy, new remote-execution tests, and this document
are owned by this change. No settings routes, bridge files, root README, existing
Git credential components, or other concurrent work were modified.
