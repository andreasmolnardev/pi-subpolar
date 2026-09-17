# Subpolar Roadmap

Subpolar turns Pi into a local, general-purpose agent platform. Roadmap priority
is WebUI usability and reliability first, followed by a small CLI protocol client
for external harnesses.

Last reviewed: 2026-09-17

## North Star

Provide one trustworthy agent runtime with multiple clients:

```text
WebUI -------------------+
                        |
@agents-cli -------------+--> Subpolar bridge --> Pi SDK
                        |          |
Other harnesses --------+          +--> PocketBase identity, policy, approvals, audit
                                      +--> registered internal, HTTP, OpenAPI, and MCP tools
```

The WebUI and CLI must use the same session context and tool gateway. A client
must never bypass agent ownership, tool policy, approval, or audit handling.

## Current Baseline

### WebUI

- Embedded Pi SDK sessions behind a Bun bridge; no Pi CLI process is required.
- Chat, streaming assistant output, transcript tool rendering, abort, queued
  prompts, resume, fork, clone, archive, and background sessions.
- Model and thinking-level selection, usage statistics, session naming, and
  cross-session search.
- PocketBase email authentication, HttpOnly session cookies, user preferences,
  agent records, tool policies, approval records, and tool-call audit records.
- Virtual project roots with project-local `AGENTS.md` context.
- Agent profiles, tool allowlists, registered-tool browsing, skills, OpenAPI
  tool registration, and centralized `search-tool`/`subpolar-tools` routing.
- Responsive pages for home, chat, history, agents, projects, workspace, and
  automations.
- Typed event streams over SSE and WebSocket boundaries, plus focused unit and
  component tests.

### Runtime and Tooling

- `@webui/server/tool-gateway.ts` defines the shared in-process execution seam.
- `/api/subpolar-cli/tools/*` currently exposes register, list, search, describe,
  call, and approval continuation operations.
- Built-in tools are `read`, `write`, `edit`, `bash`, `grep`, `find`, and `ls`.
- External tools use canonical IDs such as `provider/operation` and are exposed
  through `search-tool` and `subpolar-tools`, rather than as raw Pi functions.
- Tool calls validate input, apply agent policy, create approval records where
  needed, execute, and write audit records.

## Priorities

Priority levels:

- **P0**: required for a dependable local product and E2E testing.
- **P1**: important product capability after core reliability.
- **P2**: useful extension or deployment work.

## Phase 0: Contract and Runtime Hardening (P0)

Make the bridge a stable foundation for both browser and harness clients.

- [ ] Publish versioned HTTP contracts for health, sessions, events, tools,
  approvals, and errors.
- [ ] Generate typed client contracts from one API schema source and document
  endpoint, event, and CLI compatibility policy across versions.
- [ ] Define one error envelope with stable machine-readable codes and useful
  human-readable messages.
- [ ] Add explicit health and readiness checks for the bridge, PocketBase, and
  provider/model availability; make diagnostics usable from CI and containers.
- [ ] Keep session identity derived from authenticated ownership and resolved
  session context; treat request agent names and directories as selectors only.
- [ ] Define delivery state and persistence for messages, queue entries,
  approvals, and active runs so restart recovery has one authoritative source.
- [ ] Require idempotency keys for message sends, archive/unarchive operations,
  tool registration, and tool calls. Duplicate requests must return the original
  result or current state rather than execute twice.
- [ ] Add event replay with cursors or `Last-Event-ID` for session, tool, queue,
  and approval streams. Reconnects must reconcile from a known event position.
- [ ] Define cross-client consistency rules so WebUI, `@agents-cli`, and other
  harnesses observe the same session, queue, approval, and tool state.
- [ ] Finish gateway convergence so Pi extensions and HTTP callers use the same
  gateway instance and context construction.
- [ ] Remove internal loopback credentials from public client contracts. Keep
  them only as a compatibility boundary for trusted local code.
- [ ] Add request IDs, session IDs, tool call IDs, and structured bridge logs to
  make failed runs diagnosable without logging credentials or tool secrets.
- [ ] Add contract tests covering unknown tools, disabled agents, foreign
  sessions, malformed inputs, denied tools, approval-required tools, and audit
  records.
- [ ] Add crash-recovery handling for active generations, pending approvals,
  queued messages, background sessions, and interrupted external tool calls.

**Exit criteria:** WebUI and a non-browser client can use the same documented
route and receive identical authorization and tool result behavior.

### Security and Isolation

- [ ] Enforce CSRF protection and origin checks on browser-mutating routes.
- [ ] Add rate limits for authentication, session creation, message sends, tool
  calls, registrations, and external requests.
- [ ] Redact credentials, tokens, authorization headers, and sensitive tool
  inputs/results from normal logs, errors, diagnostics, and CLI output.
- [ ] Keep Markdown, HTML, code, Mermaid, and transcript rendering XSS-safe;
  test raw HTML and untrusted tool output explicitly.
- [ ] Enforce project-root path boundaries, traversal protection, symlink escape
  checks, and shell execution restrictions for every filesystem-backed tool.
- [ ] Protect HTTP/OpenAPI/MCP tools from SSRF, unsafe redirects, unbounded
  timeouts, oversized responses, and credential leakage.
- [ ] Add multi-user and cross-project isolation tests for sessions, agents,
  files, tools, approvals, events, and audit records.

## Phase 1: WebUI Core Experience (P0)

Turn current feature coverage into a reliable daily-use interface.

- [ ] Add startup and connection-state UX: bridge unavailable, PocketBase
  unavailable, expired auth, reconnecting, and stale event stream.
- [ ] Make transcript projection resilient to reconnects, duplicate events,
  interrupted runs, large prompts, and late tool results.
- [ ] Show clear run state for queued, working, waiting for approval, failed,
  cancelled, and completed sessions.
- [ ] Finish session lifecycle UX for new, resume, fork, clone, archive, search,
  rename, and background sessions.
- [ ] Add session list pagination, search/filter, active versus archived filters,
  sorting, and strict selected-project scoping.
- [ ] Preserve selected project, agent, model, thinking level, and permission
  mode across reloads with server-side validation.
- [ ] Persist drafts locally and recover them after refresh, navigation, or a
  transient bridge failure without accidentally sending them.
- [ ] Add copy and export actions for transcripts, individual messages, and tool
  results with clear handling for truncated or unavailable content.
- [ ] Add confirmation UI for archive, delete, cancel, and destructive tool
  actions; confirmations must identify affected session/project and risk.
- [ ] Improve mobile navigation and narrow-screen chat behavior without hiding
  approval, question, error, or tool-result state.
- [ ] Add keyboard navigation, focus management, accessible labels, and color
  contrast checks for core chat and settings flows.
- [ ] Define consistent empty, loading, offline, reconnecting, stale-data, and
  error states across home, chat, history, projects, agents, settings, and
  automation pages.
- [ ] Add browser E2E coverage for sign-in, setup, chat streaming, tool output,
  approval, reconnect, session resume, new-session routes, archive behavior,
  queueing, and mobile layout.

### New-Session Routing

Use canonical path-based routes for new session creation. Do not encode new
session context only in query parameters or transient navigation state.

- [ ] Add `/new` as the default new-session page.
- [ ] Add `/new/$projectName/$agentName` (router params `:projectName` and
  `:agentName`) for a named project and agent.
- [ ] Add `/new/$agentName` (router param `:agentName`) for an agent using the
  General Chat project.
- [ ] Treat a single segment after `/new` as an agent name, not a project name;
  project-only routing is not implicit.
- [ ] Resolve project names and agent names server-side before creating a
  session, with URL decoding, ownership checks, and explicit not-found or
  disabled-agent errors.
- [ ] Initialize composer context from the route and preserve selected project,
  agent, model, thinking level, and permission mode through session creation.
- [ ] On first send, create the session with the resolved project and agent,
  then navigate to its canonical session route without a queued state.
- [ ] Update sidebar, home, agent, project, keyboard shortcut, and redirect
  actions to generate these routes consistently.
- [ ] Add route tests for default, project-plus-agent, general-chat agent,
  encoded names, unknown projects, unknown agents, disabled agents, and direct
  reloads.

### Context Attachments and Composer

Make context additions explicit, inspectable, and reversible from the composer.

- [ ] Replace the clipper attachment affordance with a `+` icon button. Clicking
  it opens a dropdown with icon-labeled actions: `Upload file`, `Website`,
  `Image`, and `Text`.
- [ ] Make `Upload file` open a file picker and add selected files as context
  attachments with name, type, size, loading, failure, and remove states.
- [ ] Make `Website` open a focused URL prompt, validate the URL, fetch or
  resolve page context through the bridge, and show clear loading, failure, and
  unsafe-URL states before attachment.
- [ ] Make `Image` attach an image for vision-capable models. While the chat
  input has focus, support pasted images from the clipboard; if the selected
  model does not support vision, retain the input and display an actionable
  warning instead of silently dropping the image.
- [ ] Make `Text` open a dialog with an editable title and Monaco editor. Add a
  switch labeled for creating a `.md` file in the selected project; default it
  off so text is added to context only. When enabled, validate and sanitize the
  project-relative filename and route file creation through the normal tool
  policy.
- [ ] Convert large pasted text into a text context attachment instead of
  inserting it into the textarea. Use `Pasted text` for the first title and
  increment subsequent titles as `Pasted Text (1)`, `Pasted Text (2)`, and so on.
  Large pasted text must default to context-only and must not create a file.
- [ ] Show context attachments as compact removable chips/cards in a
  horizontally scrollable carousel immediately to the right of the `+` button.
  Preserve attachment order, title, source, and context/file mode.
- [ ] Define size, type, count, and total-context limits. Show truncation or
  conversion explicitly and prevent attachment credentials or unsafe content
  from leaking into logs.
- [ ] Add tests for each menu action, image paste with and without vision,
  large-paste naming, Monaco text editing, file-mode toggle, chip removal,
  carousel overflow, limits, and failed attachment recovery.

### Composer Controls and Slash Commands

- [ ] Dock model selection immediately to the left of the send control(s),
  including the `Steer` and `Queue` controls while generating.
- [ ] Hide the permissions select from the composer. Preserve permission state
  in session/runtime context and expose changes through slash commands.
- [ ] Pass slash commands through from the chat input bar using the same command
  discovery and execution path as Pi CLI; support autocomplete, keyboard
  navigation, command arguments, errors, and command history.
- [ ] Make `/permissions` open a focused prompt card above the chat input for
  selecting permission level. Support ArrowUp/ArrowDown, Enter, Tab, Escape,
  accessible focus, and confirmation of the selected level.
- [ ] Make Enter insert a newline in the textarea. Set the normal send button
  hover title to `Send (Ctrl+Enter)` and send on Ctrl+Enter without losing
  multiline editing or IME input behavior.
- [ ] Animate dropdowns, dialogs, focused command cards, attachment chips, and
  docked controls while honoring `prefers-reduced-motion`.
- [ ] Add tests for slash command passthrough, `/permissions`, keyboard focus
  and selection, multiline Enter behavior, Ctrl+Enter submission, and exact send
  button titles.

### Agent Routing and Handoff

- [ ] Support automatic agent routing by running a first routing-model pass when
  no agent is selected. Record the routing decision and make it visible in
  session metadata.
- [ ] Place agent selection to the right of the project selector icon button.
  Show global/non-project agents first, followed by project/agent entries for
  each available project. Respect hidden agents, project overrides, disabled
  agents, and ownership checks.
- [ ] Do not support direct agent switching after conversation messages exist in
  a session. Keep the active agent stable for ordinary follow-up messages.
- [ ] Support agent changes through `/handoff` only. Open a focused handoff card
  above the chat input with agent name and description, ArrowUp/ArrowDown,
  Enter/Tab selection, Escape cancellation, and accessible focus management.
- [ ] On handoff, ask the previously selected agent to summarize using this
  explicit instruction: `summarize our conversation to hand off to this agent: $AGENT NAME $AGENT DESCRIPTION`.
  Reuse the compaction/summarization pipeline where possible, transfer the
  resulting summary to the selected agent before accepting its next response,
  and record source/target agents in session metadata.
- [ ] Treat handoff as a controlled context transition, not a visual selector
  change. Preserve the original transcript and make failures retryable without
  losing the conversation or silently changing agents.
- [ ] Add tests for automatic routing, agent/project ordering, locked mid-session
  selection, handoff keyboard behavior, summary transfer, cancellation, and
  failed handoff recovery.

### Archived Sessions

Archived sessions remain discoverable within their project while clearly
separated from active work.

- [ ] Include archived threads/sessions for the currently selected project in
  its sessions list; do not hide them from normal project navigation.
- [ ] Render archived sessions with an archive icon before the session title and
  muted text/color, while retaining readable contrast and an accessible archived
  status label.
- [ ] When an archived session is opened, show a compact informational card
  directly above the chat input with this message: `Sending a message to this thread will move it out of the 'Archived' state`.
- [ ] Sending any message from an archived session must un-archive it as part of
  the send flow atomically with execution, then update the list and card without
  requiring a manual refresh. Use an idempotency key so retries cannot unarchive
  or send twice.
- [ ] Keep the first sent message immediate and normally rendered; un-archiving
  must never route it through queue state or make it appear delayed.
- [ ] Define behavior for failed un-archive and send operations so the session
  does not silently appear active when the message was not accepted.
- [ ] Add tests for archived-session listing, icon/muted presentation, opening
  the informational card, successful un-archive on send, and failure recovery.

### Sending and Queueing

Queueing is a runtime state, not a message appearance applied after the fact.
It is relevant only while the selected agent in the selected session is
currently generating.

- [ ] Send the first message used to create a new session/thread immediately.
  It must never be marked or rendered as queued.
- [ ] Render every accepted message optimistically as sent immediately, before
  the network round trip completes. Failed sends must show an explicit error
  state rather than silently looking queued.
- [ ] Keep the final appearance of a completed message immutable. Completion of
  assistant generation must not restyle, relabel, reorder, or reclassify an
  already-rendered user message.
- [ ] When the session is idle, show the normal single send icon button.
- [ ] When the agent is generating, replace that control with two icon buttons:
  `Steer` and `Queue`. Both need visible accessible labels and hover titles;
  neither should be an ambiguous unlabeled icon.
- [ ] `Steer` must call Pi's steering path and deliver the message after the
  currently running agent reaches its next tool-call boundary. Render it as a
  normal user message with a persistent `Steering` label above its bubble.
- [ ] `Queue` must call Pi's follow-up/queue path and deliver the message only
  after the current generation finishes. Do not use queue state for ordinary
  sends or new-session creation.
- [ ] Show pending queued messages in a compact card directly above the chat
  input. The card must show `Enqueued` in semibold or bold text followed by the
  message contents in regular weight.
- [ ] Keep queued-card identity, order, and contents stable while pending. On
  dispatch, remove the card only after confirmed handoff and promote the
  message to its stable transcript representation; never duplicate it.
- [ ] Support queue management for removing, retrying, reordering, and clearing
  queued messages. Persist queue entries and reconcile them after reconnect or
  bridge restart.
- [ ] Persist delivery intent and status separately from rendered message data:
  `sent`, `steering`, `enqueued`, `delivered`, `failed`, and `cancelled`.
  Rendering must use the original intent and never infer it from later run
  completion events.
- [ ] Use client-generated message IDs and idempotency keys to reconcile
  optimistic rows with persisted rows and prevent duplicate sends.
- [ ] Treat server events as authoritative for handoff. Use replay cursors to
  recover queue state after reconnect, and show an actionable retry state when
  delivery fails.
- [ ] Make optimistic, steering, queue-card entry, handoff, completion, and
  removal transitions animated. Preserve layout stability and honor
  `prefers-reduced-motion`.
- [ ] Define explicit event/reconciliation rules for reconnects, duplicate
  events, aborts, generation errors, and queue delivery failure so a message
  cannot appear both as a card and as a transcript row.
- [ ] Keep WebUI queue controls and CLI/harness queue operations on the same
  server-side state and event model.

Required state coverage:

| Situation | Send surface | Message presentation |
| --- | --- | --- |
| New session/thread creation | Normal send | Immediate normal user message; never queued |
| Existing idle session | Normal send | Immediate normal user message; stable after completion |
| Agent currently generating | `Steer` and `Queue` icon buttons | Steering message gets persistent `Steering`; queued message stays in `Enqueued` card |
| Generation finished | Normal send | No retroactive appearance change to prior messages |

**Exit criteria:** A user can start the local stack, authenticate, create a
project session, complete a tool-assisted prompt, recover from a bridge restart,
and resume the same session without data or authorization surprises. While a
session generates, the user can distinguish and verify steering versus queueing,
and each message appears exactly once with stable presentation.

### Suggested Responses

Offer optional next-step prompts after an assistant generation completes without
polluting the conversation with hidden tool or planning content.

- [ ] Add a user setting for a `follow-up suggestion model`, using the existing
  provider/model selection and availability validation. Allow the feature to be
  disabled and show an actionable configuration error when its model is
  unavailable.
- [ ] After generation is fully finished, send a separate follow-up request to
  the selected agent asking for possible user follow-ups. Never request
  suggestions while the agent is still generating or while tool calls remain
  active.
- [ ] Build that request from only the last user message and last assistant
  message in the conversation. Exclude tool calls, tool inputs, tool results,
  hidden reasoning, approvals, and unrelated older transcript content.
- [ ] Require a structured response containing a small bounded list of concise
  suggestion strings. Validate count, length, empty values, unsafe markup, and
  malformed model output before rendering.
- [ ] Render suggestions under the completed assistant output as link-like
  buttons with a leading `↳` icon. Make the entire control keyboard accessible,
  with focus, hover, pressed, disabled, and loading states.
- [ ] Tapping or activating a suggestion must send that exact text as a normal
  user message to the active agent through the normal send path, including
  archive un-archive, idempotency, and steer/queue rules when applicable.
- [ ] Keep suggestions attached to the assistant message that produced them.
  Do not rewrite or move them when later messages finish, and invalidate them
  when branching, handoff, or a new conversation context makes them stale.
- [ ] Deduplicate requests by completed assistant message ID and follow-up model
  so reconnects and transcript replays cannot create duplicate suggestion sets.
- [ ] Animate suggestion appearance and removal without shifting the transcript
  unexpectedly; honor `prefers-reduced-motion`.
- [ ] Treat suggestion generation as optional and non-blocking: assistant output
  remains complete if the request times out, fails, is cancelled, or is denied.
- [ ] Add settings, prompt-construction, tool-exclusion, structured-output,
  keyboard activation, send, deduplication, stale-context, failure, and reduced-
  motion tests.

## Phase 2: WebUI Workspace and Agent Control Plane (P1)

Make projects and agents first-class parts of the product.

### Projects and Workspace

- [ ] Add a safe project browser with file preview and explicit write/edit
  actions routed through Pi tools.
- [ ] Add repository discovery, status, diff, branch, worktree, and clone flows
  behind a dedicated repository service rather than ad hoc browser filesystem
  access.
- [ ] Make virtual project roots visible in navigation and session metadata.
- [ ] Add clear path-boundary enforcement and tests for traversal, symlink, and
  cross-project access.

### Agents

- [ ] Complete agent create, edit, duplicate, disable, delete, and activation
  flows with server-side validation.
- [ ] Edit system prompt, authored prompt, mode, tool policies, approval mode,
  and skill visibility independently.
- [ ] Preview effective runtime configuration before launching a session.
- [ ] Show unresolved policy IDs, disabled tools, approval requirements, and
  the source of each effective decision.
- [ ] Add a tool test panel that uses a real session context and displays
  validation, approval, result, and audit outcomes.

### Conversation Branching

Allow exploration of alternate directions without rewriting the parent thread.

- [ ] Add a branch/fork action to every assistant output, not only the latest
  message in a session.
- [ ] Send the selected assistant message ID as the fork anchor. Forking from an
  older output must remain possible even after newer messages are added.
- [ ] Create a child session containing the conversation through the selected
  anchor, preserving project, agent, model, and ownership context while keeping
  later parent messages out of the child context.
- [ ] Preserve parent-session and branch-point metadata for navigation between
  parent and child sessions, and display branch relationships in session history.
- [ ] Keep parent transcript immutable when creating or using a branch. Branch
  creation must be idempotent and safe to retry.
- [ ] Add branch actions to message hover/focus controls with accessible labels,
  confirmation where needed, and animated navigation to the child session.
- [ ] Add tests for branching from first, middle, latest, and older assistant
  outputs after newer messages exist, including reload, retry, archive, and
  cross-user denial cases.

### Automation

- [ ] Define durable automation and schedule records, ownership, timezone, and
  retry policy.
- [ ] Add run history, cancellation, concurrency limits, and failure reporting.
- [ ] Keep automation tool calls subject to the same agent policy and audit path
  as interactive sessions.

**Exit criteria:** Users can understand and safely change what an agent may do,
where it may work, and why a tool call was allowed or blocked.

## Phase 3: Integrations and Operations (P1/P2)

- [ ] Finish MCP server management and tool discovery UI.
- [ ] Finish OpenAPI provider editing, operation refresh, schema preview, and
  credential reference management.
- [ ] Add provider account status, expiry handling, login recovery, and safe
  model availability diagnostics.
- [ ] Add external-tool request guards: SSRF protection, private-network
  policy, redirect validation, request timeouts, response-size limits, and
  credential isolation.
- [ ] Add optional notification delivery for approvals, failed runs, and
  completed background or scheduled sessions.
- [ ] Define PocketBase schema migration/versioning, rollback, and compatibility
  procedures before changing application collections.
- [ ] Document Docker development, backup/restore for PocketBase metadata and
  session data, reverse-proxy deployment, and loopback versus network exposure.
- [ ] Add resource limits for prompts, tool inputs/results, concurrent sessions,
  external requests, retained audit data, and streamed output. Make truncation
  and timeout behavior explicit to every client.
- [ ] Add operational dashboards or exportable diagnostics without exposing
  prompt contents, credentials, or sensitive tool inputs by default.
- [ ] Define structured log and audit retention, deletion, and export policies.
- [ ] Add provider/model readiness diagnostics and actionable setup failures to
  the health endpoint and WebUI.

## Phase 4: `@agents-cli` Harness Utility (P0 after Phase 0)

Create `@agents-cli` as a standalone client for a **running** Subpolar bridge.
It should not embed Pi, start a second agent runtime, or talk directly to
PocketBase. A separate E2E runner may start and stop Subpolar around a test.

### Package Shape

Proposed layout:

```text
@agents-cli/
  src/
    cli.ts              # argument parsing and command dispatch
    client.ts           # typed bridge HTTP client
    auth.ts             # env, config, and token handling
    output.ts           # table, JSON, and error formatting
    types.ts            # public request/response contracts
  test/
    client.test.ts
    commands.test.ts
    e2e.test.ts
  package.json
  tsconfig.json
  README.md
```

The package should expose both a binary and a small programmatic client so
Playwright, shell scripts, CI jobs, and other agent harnesses can use it.

### Authentication and Context

- [ ] Add a scoped harness credential flow. Do not require consumers to know or
  reuse the bridge's private `SUBPOLAR_INTERNAL_TOKEN`.
- [ ] Support environment and config-file credentials, with stdin support for
  CI and no token values in command history or normal logs.
- [ ] Bind credentials to user, permitted agents, permitted projects, and
  expiration where practical; support revocation and rotation.
- [ ] Add explicit credential revocation, rotation, expiry errors, and cleanup
  of temporary E2E credentials after every run.
- [ ] Require an explicit session or create one through a documented session
  command before executing tools.
- [ ] Require `--agent` and `--cwd` only as selectors validated against the
  authenticated session context; never treat them as ownership assertions.

### Initial Command Surface

Names are illustrative but should remain small and scriptable.

| Command | Purpose |
| --- | --- |
| `agents-cli health` | Check bridge readiness and report version/capabilities. |
| `agents-cli sessions list` | List sessions visible to authenticated user. |
| `agents-cli sessions create` | Create or select a session for a harness run. |
| `agents-cli tools list` | List tools visible to selected agent. |
| `agents-cli tools query <text>` | Search visible tools using `search-tool` semantics. |
| `agents-cli tools describe <tool-id>` | Return schema, risk, approval, and usage metadata. |
| `agents-cli tools add` | Register or update a harness-provided tool definition. |
| `agents-cli tools call <tool-id>` | Execute a tool through the shared gateway. |
| `agents-cli messages send <text>` | Send immediately when session is idle or create a new session. |
| `agents-cli messages steer <text>` | Deliver steering message at the next tool-call boundary. |
| `agents-cli messages queue <text>` | Enqueue follow-up for delivery after generation finishes. |
| `agents-cli queue list` | List pending queued messages for a session. |
| `agents-cli queue remove <id>` | Remove one pending queued message. |
| `agents-cli queue retry <id>` | Retry failed queued-message delivery. |
| `agents-cli queue reorder <id> <position>` | Change pending queue order. |
| `agents-cli queue clear` | Remove all pending queued messages after confirmation. |
| `agents-cli approvals list` | List pending approvals for selected session. |
| `agents-cli approvals continue <id>` | Continue an approved tool call. |
| `agents-cli approvals reject <id>` | Reject a pending approval. |
| `agents-cli events` | Stream session/tool/approval events for a harness. |

`query` is the public CLI name requested for tool discovery. It maps to the
existing `search-tool` behavior in `docs/Tools.md`: non-empty text in, visible
`tool`, `description`, and `usage` rows out. It must not execute a tool and must
not reveal tools denied to the active agent. A short `agents-cli query` alias
may be added if it improves harness ergonomics.

Message commands must use the same delivery state machine as WebUI. `send` is
never queued when creating a session or sending to an idle session; `steer` and
`queue` are valid only while the agent is generating. Queue mutations must use
message IDs and idempotency keys, emit replayable events, and preserve original
delivery intent in JSON/JSONL output.

### Tool Registration

`tools add` must support the same definition needed by the bridge registry:

- canonical tool ID, namespace, description, and operation;
- adapter and target;
- input and output JSON Schemas;
- risk class and approval requirement;
- enabled state and non-secret metadata.

Registration must be idempotent, validate schemas, reject reserved or malformed
IDs, and never accept credentials as tool metadata. Registered tools remain
subject to agent visibility, policy, approval, execution, and audit checks.

### Tool Calls

- [ ] Accept JSON from `--input`, `--input-file`, or stdin.
- [ ] Produce human-readable tables by default and stable JSON with `--json`.
- [ ] Add JSONL output for streamed events and long-running operations so shell
  and harness consumers can process records incrementally.
- [ ] Return canonical tool ID, result or structured error, call ID, and
  approval ID when execution pauses.
- [ ] Define stable non-zero exit codes for transport failure, validation
  failure, denial, approval required, timeout, cancellation, and interrupted
  execution.
- [ ] Never silently use `allow_all`; approval-required calls must return a
  pending approval and provide a continuation path.
- [ ] Apply output size/time limits and make truncation explicit.
- [ ] Add `--wait`, timeout, cancellation, and event-stream options for session,
  tool, approval, and queued-message operations.

**Exit criteria:** A harness can authenticate, create/select a session, add a
read-only test tool, run `query`, inspect its schema, call it, receive a
structured result, and observe the call in audit history. A write or external
tool pauses for approval and cannot be continued by a foreign user or session.

## Phase 5: End-to-End Harness and Release Workflow (P0/P1)

Build one repeatable test path that proves WebUI and CLI use the same runtime.

### E2E Lifecycle

- [ ] Start an isolated PocketBase instance with disposable data.
- [ ] Start Subpolar bridge and WebUI using test ports and test credentials;
  wait for `/api/health` and readiness before issuing requests.
- [ ] Build or invoke `@agents-cli` against that running instance. The CLI test
  must connect over its public client boundary, not import bridge internals.
- [ ] Create a test user, project, agent, and session.
- [ ] Register a deterministic local fixture tool such as `e2e/echo`.
- [ ] Query tools and verify only agent-visible tools are returned.
- [ ] Describe `e2e/echo` and validate schema and metadata.
- [ ] Call the fixture and verify result, event stream, and audit record.
- [ ] Attempt a denied tool and verify denial plus audit record.
- [ ] Call an approval-required tool, verify pending state, approve through the
  WebUI or approval API, continue through CLI, and verify exactly one execution.
- [ ] Exercise idle send, active-generation `Steer`, active-generation `Queue`,
  queue removal, queue retry, queue clear, and post-generation delivery. Verify
  message IDs, delivery states, labels, cards, and event ordering.
- [ ] Retry sends and tool calls with the same idempotency key. Verify exactly
  one persisted message, unarchive operation, registration, and execution.
- [ ] Disconnect and reconnect clients using an event cursor. Verify replay
  produces no duplicate transcript rows, queue cards, approvals, or tool calls.
- [ ] Restart the bridge during generation with pending approvals and queued
  messages. Verify recovery or explicit failure state for every operation.
- [ ] Open an archived session, verify the informational card, send a message,
  and verify atomic unarchive plus normal immediate message presentation.
- [ ] Exercise attachment flows for file, website, image, text, large paste,
  context-only mode, project-file mode, removal, and vision capability warning.
- [ ] Exercise slash command passthrough, `/permissions`, multiline Enter,
  Ctrl+Enter send, automatic routing, locked agent selection, and `/handoff`.
- [ ] Complete a generation with suggested responses enabled. Verify the
  suggestion request contains only the final user and assistant messages, no
  tool calls or hidden reasoning, uses the configured follow-up model, renders
  `↳` buttons, and sends the selected suggestion exactly once.
- [ ] Verify suggestion timeout, malformed output, duplicate event replay,
  disabled model, branch, handoff, and reduced-motion behavior.
- [ ] Branch from first, middle, latest, and older assistant outputs after newer
  parent messages exist. Verify child context ends at the selected anchor and
  parent transcript remains unchanged.
- [ ] Verify foreign user, foreign session, expired credential, malformed input,
  disabled-tool, cross-project, and cross-agent failures.
- [ ] Shut down all processes and remove disposable data even after failure.

### CI Gates

- [ ] WebUI unit/component tests.
- [ ] Bridge and server typechecks.
- [ ] CLI unit and contract tests.
- [ ] CLI compatibility tests against each supported bridge/API version.
- [ ] Browser E2E tests for core WebUI flows.
- [ ] CLI E2E tests against a freshly started stack.
- [ ] Use deterministic fixture tools and test-token cleanup in every CLI E2E
  run.
- [ ] Dependency, secret-leak, and container checks.

**Release criteria:** A tagged build has documented startup commands, a stable
CLI contract, passing WebUI and CLI E2E tests, no credential leakage in logs,
and clear migration notes for any PocketBase schema or endpoint changes.

## Explicit Non-Goals

- The CLI will not be a replacement Pi implementation.
- External harnesses will not receive direct PocketBase access.
- Tool registration will not disable policy, approval, or audit controls.
- Browser clients will not receive provider credentials or bridge superuser
  credentials.
- Network-wide exposure is not assumed; loopback remains the default until
  authentication, origin checks, rate limits, and deployment guidance are
  complete.

## Source Documents

- [`README.md`](./README.md) - project principles and current startup flow.
- [`WEBUI_FEATURES.md`](./WEBUI_FEATURES.md) - WebUI feature disposition.
- [`docs/Tools.md`](./docs/Tools.md) - tool discovery, routing, approvals, and
  audit model.
- [`docs/tool-gateway.md`](./docs/tool-gateway.md) - shared execution seam.
- [`docs/agent-runtime.md`](./docs/agent-runtime.md) - agent runtime authority.
- [`docs/Orchestration.md`](./docs/Orchestration.md) - agent/project/session
  separation model.
