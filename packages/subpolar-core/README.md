# `@subpolar/runtime`

Core execution and authorization logic for Subpolar.

## What it does

- Creates the policy gateway with `createPolicyGateway` or `createGateway`.
- Validates tool input and fails closed when no policy allows a call.
- Applies deny > approval-required > allow precedence.
- Coordinates approval stores, continuation ports, claims, idempotency, and audit events.
- Redacts credentials and other sensitive values from errors and audit data.
- Provides the stateful run service and the stateless Subpolar runtime.

The runtime depends on shared contracts and injected ports. It does not import Pi, PocketBase, WebUI, or concrete HTTP adapters. Storage and provider behavior must be supplied by the composition root.

## Main APIs

- `createPolicyGateway`
- `createRunService`
- `createStatelessSubpolarRuntime`
- `redactAuditValue`

## Testing

```sh
bun test packages/subpolar-core
```
