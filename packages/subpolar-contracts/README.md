# `@subpolar/shared`

Shared contracts for the Subpolar runtime, adapters, tools, and applications.

## What it contains

- Runtime, execution, and principal context types.
- Run requests, outcomes, lifecycle events, and persistence ports.
- Tool definitions, calls, policies, approvals, and audit contracts.
- Session, transcript, memory, and skill interfaces.
- Operations manifest types and validation helpers.
- Skill validation, versioning, scope resolution, and an in-memory skill repository.

This package is intentionally implementation-neutral. It defines the interfaces that `@subpolar/runtime`, storage adapters, Pi integration, and applications compose together. It does not import Pi, PocketBase, WebUI, or HTTP implementations.

## Testing

```sh
bun test packages/subpolar-contracts
```
