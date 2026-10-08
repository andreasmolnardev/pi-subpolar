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
- Projects and sessions: CRUD, paginated/filterable session listing, transcripts, message delivery, run start, and abort.
- Events: owner-scoped SSE at `/api/sse/stream`, including replay cursor and optional session filter.
- Approvals: pending approvals and session-bound decisions.
- Worktrees: session branch sources, explicitly approved worktree creation, task worktree lookup, and repository discovery.

The `run()` helper calls the existing message-delivery endpoint and then its corresponding `/runs` endpoint. It does not poll or synthesize live run state; use `events()` to observe server events.

## Explicit limitations

`unsupportedFeatures` lists server functionality that is absent or not safely available. In particular, remote Git refresh is an existing route that deliberately returns `UNSUPPORTED`; the client exposes project/session operations but does not promise parity with every legacy UI, task, tool, provider, workspace, voice, or automation route. Approval responses require both session ID and approval ID. Session event subscriptions here use the owner-scoped SSE feed; the server's authenticated per-session WebSocket is intentionally not wrapped by this HTTP client.

The API's legacy endpoints do not all return the versioned `subpolar-api.v1` envelope. `SubpolarApiError` preserves status and any structured code/request ID where present. Response models allow additional fields so additive server response changes remain usable.

## Tests

Run the package tests with:

```sh
bun run --cwd packages/subpolar-client test
```
