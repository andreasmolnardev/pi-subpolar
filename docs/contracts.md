# Subpolar Agent API Contracts

Phase 0 exposes the dependency-free contract identifier `subpolar-api.v1`.
Versioned endpoints are under `/api/v1`; new responses include the request
correlation field `requestId` and the `x-request-id` response header.

## Discovery

`GET /api/v1/capabilities` is public and returns the contract/version,
compatibility policy, correlation field names, event metadata, and the
currently exposed versioned capabilities. It does not return credentials,
provider configuration values, or user records.

## Diagnostics

`GET /api/v1/health` is public and returns a health snapshot with the bridge,
Pi runtime, PocketBase, project filesystem, provider, browser, STT, and TTS
components. Component states are explicit:

- `available` means the bridge observed the component responding.
- `unconfigured` means the component is a supported optional surface with no configuration observed.
- `unknown` means the bridge cannot observe it safely, which is the normal state for browser/STT/TTS client features from a server route.
- `degraded` and `unavailable` identify observed service problems.

Provider diagnostics contain only non-secret counts/identifiers and public
status vocabulary. Credentials, environment values, headers, filesystem paths,
and provider error text are not part of the response.


## Error Envelope

New contract errors use:

```json
{
  "error": {
    "code": "EXAMPLE_CODE",
    "message": "A safe human-readable message",
    "details": {}
  },
  "requestId": "request-id"
}
```

`details` and `requestId` are optional in the type, but versioned bridge
responses include `requestId`.

## Shared gateway composition

`@subpolar/contracts` defines the persistence-neutral gateway ports. An
application can bind an owner-scoped adapter to `ApprovalStore`,
`ApprovalContinuationPort`, and `ApprovalClaimPort`, then pass the resulting
ports to `@subpolar/core` together with tool definitions, PocketBase-derived
`ToolPolicyRecord[]`, and an executor. Continuation payloads are opaque and
must not be interpreted or logged by the adapter.

## Versioning

The v1 policy permits additive response fields and asks clients to ignore
unknown fields. Breaking wire changes require a new versioned contract
identifier and route prefix. Event metadata is versioned independently as
`subpolar-api.v1.events`; event correlation uses `requestId`, `runId`,
`sessionId`, `taskId`, `toolCallId`, and `approvalId`.
