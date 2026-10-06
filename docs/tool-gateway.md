# Core tool gateway

Subpolar Agent composes `packages/subpolar-core` directly. The core gateway owns canonical
lookup, input validation, database-derived policy, approval state, idempotency,
and audit decisions. Subpolar Agent supplies the execution adapter and transport context.

```ts
import { createCoreToolGateway } from './@subpolar-agent/server/index.ts'

const gateway = await createCoreToolGateway(client, userId)
const result = await gateway.call(
  { callId, toolId, input, idempotencyKey: `tool-call:${callId}` },
  {
    requestId: callId,
    principal: { id: userId, kind: 'user' },
    sessionId,
    agentId,
    projectId,
    cwd,
    metadata: { agentName },
  },
)
```

`createCoreToolGateway` loads canonical definitions from the PocketBase registry,
resolves the selected agent's policy records for each call, and binds owner-scoped
PocketBase audit and call-idempotency ports. Approval records remain in the
PocketBase-backed approval flow; the in-memory approval map is only a fast path
for the existing legacy continuation implementation and is not authoritative.

The Pi routing extension and `/api/subpolar-cli/tools/call` both call this core
interface directly. HTTP authentication, gateway credential scopes, session
ownership checks, SSE publication, and the transport response remain Subpolar Agent
responsibilities. The executor in `tools.ts` only invokes Pi, subagent, memory,
browser, web, HTTP/OpenAPI, MCP, and registered tool implementations after the
core gateway has admitted the call.
