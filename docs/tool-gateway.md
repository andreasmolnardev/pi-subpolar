# In-process ToolGateway

`@webui/server/tool-gateway.ts` is the in-process execution seam for Pi tool
wrappers and HTTP routes. It deliberately contains no HTTP server/client code,
authentication, or internal-token handling.

## Existing executor

The current `@webui/server/tools.ts` `callTool` function remains the authority
for:

- canonical tool lookup and enabled-state checks;
- input validation;
- agent policy and permission overrides;
- approval records and optional approval waiting; and
- execution, error conversion, and audit records.

Create the shared service by injecting that function rather than importing it
from the gateway module:

```ts
import { callTool } from './server/tools.ts'
import {
  createToolGatewayFromCallTool,
  type ToolGateway,
} from './server/tool-gateway.ts'

const gateway: ToolGateway = createToolGatewayFromCallTool(client, callTool)
```

The dependency injection keeps the gateway free of a `tools.ts` runtime import,
so a future `tools.ts` implementation can use the gateway without creating a
module cycle. It also makes the executor straightforward to replace in tests.

## Shared call shape

Both callers use:

```ts
await gateway.call(
  { toolId, input },
  {
    userId,
    agentName,
    sessionId,
    cwd,
    callId,
    permissionOverride,
    waitForApproval,
    onApproval,
  },
)
```

`waitForApproval: true` preserves the current tool-call HTTP route behavior.
When it is false or omitted, approval-required calls return the existing
`approvalRequired` result instead of blocking.

## Adapter registry

`ToolGatewayAdapterRegistry` is a trusted server-side extension point. An
adapter handler can implement an adapter itself or wrap/decorate the injected
executor by calling its `next` delegate. `gateway.call()` intentionally does
not choose an adapter from caller input: `callTool` resolves the registered
`ToolDefinition` and its adapter after policy checks. Use
`callWithAdapter()` only when trusted host code has already resolved an adapter;
it returns `ADAPTER_NOT_REGISTERED` rather than silently falling back.

The registry is therefore not a second tool registry and must not duplicate
PocketBase policy, approval, or audit logic.

## Bridge integration

The bridge should create one gateway for the application database/client and
capture it in the session manager or application context. The
`tool-routing` Pi extension should invoke `gateway.call()` directly instead of
posting to `/api/subpolar-cli/tools/call`. It should pass the session's user,
agent, directory, call ID, permission override, and an approval callback that
broadcasts the existing permission event.

The HTTP route should use the same gateway instance and the same context
construction, with `waitForApproval: true`. It should continue to perform
normal user/session authorization before constructing the context. The route
may retain the internal bearer token as a compatibility boundary for trusted
loopback callers, but that token must never be a field in
`ToolGatewayContext` or checked by the gateway.

After both callers use the service, the old loopback URL and token headers are
only needed for compatibility or for a separately deployed process—not for
Pi-to-bridge execution in the same process.
