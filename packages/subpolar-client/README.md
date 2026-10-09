# @subpolar/client

Typed, dependency-free TypeScript client for the Subpolar Agent HTTP API. The package uses the repository's Bun workspace and exports directly from `src/index.ts`.

## Usage

```ts
import { SubpolarClient } from '@subpolar/client'

const client = new SubpolarClient({
  baseUrl: 'http://127.0.0.1:4173',
  // Browser cookie auth is included by default. Pass a token for bearer auth.
  token: process.env.SUBPOLAR_TOKEN,
})

const [capabilities, projects] = await Promise.all([
  client.capabilities(),
  client.listProjects(),
])

const session = await client.createSession({ project: projects[0]?.id, title: 'Investigate issue' })
const result = await client.run(session.id, 'Summarize the repository')

for await (const event of client.events({ sessionId: session.id })) {
  console.log(event.id, event.event, event.data)
}
```

`token` is optional. Requests default to `credentials: 'include'`, suitable for browser cookie authentication; configure `credentials` or `fetch` to adapt transport behavior. The injected `fetch` implementation is useful for Node runtimes, tests, and custom networking.

## Supported API areas

- Authentication: config, current session, email sign-up/sign-in, sign-out, password change.
- Discovery: versioned capabilities and health (`/api/v1/*`).
- Agents: owner-scoped listing (`GET /api/agents`).
- Providers and models: provider catalog (`GET /api/providers/catalog`) and model-state read/update (`/api/providers/model-state`).
- Settings and tools: preferences read/update, registered tools list, and agent tool-policy list/replace.
- Projects and sessions: CRUD, paginated/filterable session listing, transcripts, session update, message delivery, run start, and abort. Owner-scoped run inspection is available through `/api/runs/:runId`.
- Events: owner-scoped SSE at `/api/sse/stream`, including replay cursor and optional session filter. Pass `sessionId` to scope events to a session.
- Approvals: pending approval list (optionally session-filtered), lookup within that list, and session-bound decisions.
- Worktrees and repository: session branch sources, explicitly approved worktree creation, task worktree lookup, repository discovery, and owner-scoped repository status.

The `run()` helper calls the existing message-delivery endpoint and then its corresponding `/runs` endpoint. It does not poll or synthesize live run state; use `events()` to observe server events.

## Explicit limitations

`unsupportedFeatures` documents the exact gaps verified against the current WebUI modules and bridge handlers:

- Agent inspection by ID is unsupported: the server has an owner-scoped collection `GET /api/agents`, but no `GET /api/agents/:id` handler.
- Approval inspection by ID is unsupported: pending approvals can only be listed, optionally with `sessionId`; `inspectApproval()` searches that supported response and returns `undefined` when absent.
- Session WebSocket events at `/api/sessions/:id/events` are used by the WebUI but are not wrapped here. Use the supported owner-scoped `/api/sse/stream` subscription with a `sessionId` filter.
- Remote Git refresh is an existing route that deliberately returns `UNSUPPORTED`.
- No project/session bulk-delete route exists.

This client sends the configured user bearer credential or browser credentials; it does not use an installation/admin token. Approval decisions require both session ID and approval ID. The package does not claim parity with unrelated legacy UI operations (for example, runtime tool execution, provider credential flows, workspace mutations, voice, or automation).

The API's legacy endpoints do not all return the versioned `subpolar-api.v1` envelope. `SubpolarApiError` preserves status and any structured code/request ID where present. Response models allow additional fields so additive server response changes remain usable.

## Tests

Run the package tests with:

```sh
bun run --cwd packages/subpolar-client test
```
