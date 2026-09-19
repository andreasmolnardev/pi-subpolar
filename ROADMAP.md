# Subpolar Roadmap

Subpolar is a self-hosted agent platform and control plane built around the Pi SDK.

Pi is the current execution runtime. Subpolar is the product.

The roadmap prioritizes a reusable Subpolar core separated from persistence adapters, a dependable PocketBase-backed WebUI, a standalone stateless-by-default `subpolar-cli`, a focused tools CLI for external harnesses, controlled agent capabilities, coding workflows, subagents, browser tools, and local-first voice.

Last reviewed: 2026-09-19

---

## Product Direction

Subpolar should answer five questions clearly:

1. **Who is acting?** — user, agent profile, subagent, automation, or external client.
2. **Where may it act?** — project, workspace, worktree, browser session, or external integration.
3. **What may it use?** — built-in tools, registered tools, integrations, skills, memory, and models.
4. **What requires approval?** — tool policy and risk remain enforced centrally by Subpolar.
5. **What happened?** — sessions, runs, tool calls, approvals, file changes, browser actions, subagents, and automation runs remain inspectable and auditable.

Subpolar should not become a thin Pi frontend. Pi provides the current agent runtime; Subpolar owns the durable product model and the trust boundary around it.

---

## Product Principles

### 1. Subpolar owns the control plane

Subpolar owns:

- authentication and users;
- projects and workspaces;
- agent profiles;
- session identity and ownership;
- tool registration and discovery;
- tool and skill policy;
- approvals;
- memory configuration and storage;
- browser sessions;
- automation scheduling;
- audit records;
- task/run state;
- subagent permissions;
- WebUI and external-client contracts.

Pi must not bypass these systems.

### 2. One core runtime, replaceable persistence

Subpolar's core execution services must not import PocketBase, WebUI routes, browser sessions, or CLI command modules. The core accepts explicit execution context and storage, identity, and event ports. A PocketBase adapter implements durable multi-user WebUI persistence; a local/ephemeral adapter powers standalone `subpolar-cli` without PocketBase or a running WebUI server.

"Stateless core" means core services have no hidden process-global durable state. Pi can still hold transient in-process execution state for an active run; resumable state lives in the selected adapter. `subpolar-cli` may keep only deliberately opted-in/minimal authentication configuration and project/session references by default, and loads conversation data from an explicit local session store when continuity is requested. No fake guarantees of restart recovery when using a strictly in-memory adapter.

### 3. Consistent state within a deployment

The WebUI, tools CLI, automations, and any remote clients of **one running WebUI deployment** must observe the same:

- session state;
- active run;
- queue;
- approvals;
- tool policy;
- subagents;
- project/worktree state;
- browser session state;
- memory configuration;
- events.

Clients connected to the same deployment are projections of the same authoritative state. A separately started standalone `subpolar-cli` uses the **same core logic** but its own selected store; it does not automatically share live WebUI sessions. Connecting or importing/exporting between deployments must be explicit.

### 4. Capabilities are explicit

Agents receive capabilities through explicit configuration.

A capability can be:

- a built-in tool;
- an HTTP/OpenAPI/MCP tool;
- a browser tool;
- a memory tool;
- a skill;
- the subagent tool;
- a project/workspace capability;
- a future capability type.

Capabilities must be visible, inspectable, and independently controllable.

### 5. Agent profiles define behavior

Subpolar does not need a separate hard-coded "Plan Mode".

A reusable agent profile defines:

- system/authored instructions;
- preferred model and thinking level;
- tool access;
- skill access;
- approval policy;
- context policy;
- memory access;
- optional project overrides.

Ship useful template profiles, including a **Plan (Coding)** profile that is read-oriented and does not receive write/edit/shell mutation capabilities unless the user changes it.

### 6. Memory is opt-in

Persistent memory is **off by default**.

When enabled, memory is accessed through explicit tools rather than silently injecting an unbounded memory store into every prompt.

Initial memory tools:

- `memory/query`
- `memory/write`
- `memory/update`
- `memory/delete` or equivalent controlled removal flow

Memory permissions are configurable per agent.

### 7. Context is deliberate

Tools and skills need configurable context modes so Subpolar controls how much information reaches the model.

Avoid dumping every available tool schema, skill body, memory item, or integration into the prompt.

### 8. Parallelism uses normal Subpolar primitives

Parallel agent work is not a separate orchestration engine.

Parallel coding work should use:

- the normal Pi session/runtime;
- a **subagent tool** that an agent may or may not receive;
- isolated Git worktrees for mutating coding subagents;
- normal tool policy and approval enforcement;
- normal event/audit paths.

### 9. Local-first, remote-capable

Subpolar should work well as a local Docker service while remaining usable over trusted LAN/VPN/reverse-proxy deployments.

### 10. Recoverable by design

Messages, queued work, tool calls, approvals, subagents, browser actions, and automations need durable state and explicit failure/recovery behavior.

### 11. Product quality matters

Theme support, responsive UX, keyboard navigation, accessibility, good diffs, command palettes, transitions, and other quality-of-life features are roadmap features rather than afterthoughts.

---

## Roadmap Overview

```text
                       SUBPOLAR CORE (shared package)
          +------------------------------------------------+
          | Pi SDK run/session orchestration               |
          | agents / tasks / subagents / policy / approvals |
          | context assembly / tool gateway / event model  |
          | tools / skills / browser / memory capabilities  |
          +----------------------+-------------------------+
                                 |
                      explicit adapter contracts
             +-------------------+-------------------+
             |                                       |
   WebUI deployment adapter                 Standalone CLI adapter
   PocketBase persistence                  local/ephemeral storage
   server auth / multi-user                local auth/config store
   durable sessions/events                 session/project references
             |                                       |
      Subpolar API / SSE                        subpolar-cli
             |
       WebUI / PWA / tools-cli / other remote clients

          tools-cli → authenticated tool gateway ONLY
          subpolar-cli → same core IN PROCESS, no WebUI needed
```

The WebUI server and standalone CLI are **two compositions of the same Subpolar core**, not two implementations of an agent. Both run Pi through the same core orchestration, capability authorization, approval resolution, and tool gateway. Their adapters determine how state is stored, which identities are valid, and how events are delivered.

The WebUI hosts PocketBase-backed sessions that remote clients—including the tools CLI—can access through documented authenticated endpoints. Standalone `subpolar-cli` uses local state and does not require PocketBase or an HTTP server. The tools CLI cannot independently start an agent run or act as a standalone Subpolar runtime.

No ACP or multi-harness runtime adapter is planned. **Database/storage adapters are not agent runtime adapters.** Pi remains the sole execution engine on this roadmap.

---

## Core Product Model

```text
User
├── Projects
│   ├── workspace
│   ├── repository metadata
│   ├── worktrees
│   ├── project context
│   └── project agent overrides
├── Agent Profiles
│   ├── instructions
│   ├── model defaults
│   ├── tools
│   ├── skills
│   ├── context modes
│   ├── memory permissions
│   └── approval policy
├── Sessions
│   ├── transcript
│   ├── active run
│   ├── queue
│   ├── agent
│   ├── project/worktree
│   ├── browser session
│   └── branches
├── Tasks
│   ├── goal
│   ├── owning agent/session
│   ├── subagent runs
│   ├── worktrees
│   ├── status
│   └── review state
├── Automations
└── Inbox / Review Queue
```

### Session

A Session is the durable conversational context.

### Run

A Run is one active execution/generation inside a session.

### Task

A Task represents delegated work that may outlive a single generation and may create subagent runs or isolated worktrees.

Tasks are useful for:

- background work;
- automation output;
- coding changes awaiting review;
- long-running work;
- parallel subagent work.

Initial task states:

```text
draft
queued
running
waiting_for_input
waiting_for_approval
review_required
failed
completed
cancelled
```

---

# Priorities

- **P0** — required for a dependable local product and trustworthy shared runtime.
- **P1** — core product capability after the runtime is dependable.
- **P2** — extension, deployment, ecosystem, or advanced quality-of-life work.

---

# Phase 0A — Core Extraction and Persistence Adapter Architecture (P0, prerequisite)

Refactor the existing embedded Pi bridge into a reusable core before building the standalone CLI. Do not fork the bridge into CLI and WebUI implementations.

## Core Boundaries

Proposed package boundaries (illustrative names; align with existing monorepo conventions):

```text
packages/
  subpolar-core/             # Pi SDK orchestration, context, tool gateway, policy
  subpolar-contracts/        # types, domain records, events, errors, ports
  subpolar-adapter-pocketbase/# durable server storage/identity implementation
  subpolar-adapter-local/     # ephemeral + minimal filesystem state for standalone CLI
  subpolar-cli/              # terminal UX, local runtime composition
  subpolar-tools-cli/        # remote tool-only gateway client
apps/
  webui/                     # HTTP/WS/SSE adapters, routes, PocketBase composition
```

- [ ] Extract session/run/task orchestration, Pi integration, tool registry/resolver, policy decisions, approvals, context assembly, and events from WebUI-specific modules.
- [ ] Make core callable in-process by both WebUI and `subpolar-cli` without loopback HTTP calls or importing WebUI routes.
- [ ] Define dependency direction: apps/CLI → core contracts → ports; adapters implement ports. Core does not depend on concrete adapters.
- [ ] Separate domain services from authentication transport, database queries, browser UI, and terminal I/O.
- [ ] Keep core services stateless between calls except explicit in-flight run handles; inject execution/session context and services rather than relying on singleton WebUI state.
- [ ] Reuse one implementation of tool lookup, input validation, policy, approvals, execution, and auditing in both modes.
- [ ] Keep event envelopes/IDs and approval decisions consistent across adapters while documenting which guarantees require durable storage.

## Adapter Ports

Specify minimal, capability-oriented interfaces instead of exposing raw database collection APIs:

- [ ] Identity/principal and credential resolution (server versus local).
- [ ] Agent, project and session repositories.
- [ ] Run, message, queue and task records.
- [ ] Approval and tool-audit records.
- [ ] Event publication/replay, including declared durability/cursor support.
- [ ] Memory store (optional, disabled by default).
- [ ] Credential/secret references (never exposed to model output or ordinary logs).
- [ ] Transactions and idempotency/lease semantics, with explicit capability checks and safe degradation when unsupported.

Do not imply that an in-memory adapter can provide transactional multi-process persistence or replay after process exit. Fail explicitly when a requested feature requires an unsupported adapter guarantee.

## PocketBase Adapter (WebUI)

- [ ] Move PocketBase collections, queries, migrations, authenticated ownership, and durable replay into a concrete adapter layer.
- [ ] Preserve existing WebUI data and migration compatibility during extraction.
- [ ] Keep server-side multi-user authorization and cross-project isolation.
- [ ] Provide transactional/idempotent operations or equivalent safe serialization for messages, approvals, and mutating tools.
- [ ] The WebUI remains one shared long-lived core runtime with PocketBase as its backend.

## Local Adapter (`subpolar-cli`)

- [ ] Default to ephemeral execution with minimal persistent local auth/config and project/session references; do not require PocketBase, Docker, a WebUI process, or a background server.
- [ ] Define optional explicit local session persistence so users can resume chat history across CLI invocations; do not claim persistence if not configured.
- [ ] Define local profile/project lookup and agent template defaults without depending on PocketBase collections.
- [ ] Keep credentials in OS-protected storage or an appropriately permissioned local file; do not store provider secrets in session records.
- [ ] Scope local agent/tool permissions; local mode is not implicitly `allow_all`.
- [ ] Document differences in ownership, durability, notifications, schedules, multi-user support, and cross-process concurrency.
- [ ] Never automatically synchronize local CLI session data with PocketBase; future import/remote mode must be explicit.

## Migration and Verification

- [ ] Map old WebUI bridge modules to core services versus adapter responsibilities.
- [ ] Refactor incrementally with characterization tests before removing old code paths.
- [ ] Run identical fixture scenarios through PocketBase and local adapters for tool discovery, execution, policy, approvals, messages, agent context, and subagents.
- [ ] Test local CLI startup with PocketBase/network/WebUI unavailable.
- [ ] Test WebUI behavior against existing PocketBase data after migration.
- [ ] Document single-process versus durable server guarantees and adapter contract versioning.

**Exit criteria:** The same core Pi-backed run and tool gateway passes tests with either the PocketBase WebUI adapter or the standalone local adapter; no domain service imports PocketBase and no CLI agent logic duplicates the WebUI bridge.

---

# Phase 0 — Contract, Runtime, Security, and Recovery (P0)

Make the shared core and its WebUI API a stable foundation for the WebUI, standalone CLI, automations, subagents, browser tools, and external clients. Contract requirements below apply to the WebUI HTTP boundary where relevant; `subpolar-cli` consumes the same domain contracts in-process.

## Versioned Contracts

- [ ] Publish versioned HTTP contracts for:
  - health;
  - sessions;
  - runs;
  - tasks;
  - messages;
  - events;
  - tools;
  - skills;
  - approvals;
  - browser sessions;
  - memory;
  - automation state.
- [ ] Generate typed client contracts from one API schema source.
- [ ] Document endpoint, event, and client compatibility policy.
- [ ] Define one stable error envelope with machine-readable codes and useful human-readable messages.
- [ ] Add capability/version discovery so clients can gracefully hide unsupported features.

## Health and Diagnostics

- [ ] Add health and readiness checks for:
  - bridge;
  - PocketBase;
  - Pi runtime;
  - configured model providers;
  - project filesystem access;
  - browser runtime when enabled;
  - STT/TTS backends when enabled.
- [ ] Make diagnostics usable from Docker health checks and CI.
- [ ] Add request IDs, session IDs, run IDs, task IDs, tool call IDs, subagent IDs, browser action IDs, and approval IDs to structured logs.

## Durable State

- [ ] Define authoritative persistence for:
  - messages;
  - queued entries;
  - approvals;
  - active runs;
  - tasks;
  - subagents;
  - browser sessions;
  - automations.
- [ ] Require idempotency keys for mutating public operations.
- [ ] Add event replay using cursors or `Last-Event-ID`.
- [ ] Define cross-client consistency rules.
- [ ] Finish gateway convergence so Pi extensions, standalone `subpolar-cli`, and WebUI HTTP callers use the same capability gateway and context construction.
- [ ] Keep internal loopback credentials out of public contracts.
- [ ] Add crash recovery for:
  - active generations;
  - pending approvals;
  - queued messages;
  - background sessions;
  - interrupted tool calls;
  - active subagents;
  - browser actions;
  - automation runs.
- [ ] Persist enough state to show an explicit interrupted/unknown result when an operation cannot safely resume.

## Security and Isolation

- [ ] Enforce CSRF protection and origin checks on browser-mutating routes.
- [ ] Add rate limits for authentication, session creation, sends, registrations, tool calls, browser actions, memory writes, and external requests.
- [ ] Redact credentials, tokens, authorization headers, sensitive tool arguments, and sensitive tool results from normal logs and errors.
- [ ] Keep Markdown, HTML, code, Mermaid, diff, terminal, and tool-result rendering XSS-safe.
- [ ] Enforce project-root path boundaries and symlink escape protection.
- [ ] Apply shell execution restrictions consistently.
- [ ] Protect HTTP/OpenAPI/MCP/browser network tools from SSRF, unsafe redirects, unbounded timeouts, oversized responses, and credential leakage.
- [ ] Add multi-user and cross-project isolation tests.
- [ ] Prevent a parent agent from delegating capabilities to a subagent that the parent/session is not permitted to grant.

**Exit criteria:** both core compositions share behavior; WebUI browser/remote clients additionally observe identical ownership, policy, approval, tool, queue, and event behavior within the same deployment.

---

# Phase 1 — WebUI Daily-Use Experience (P0)

Turn existing feature coverage into a reliable interface that can be used as the primary Subpolar client.

## Connection and Runtime UX

- [ ] Add explicit states for:
  - bridge unavailable;
  - PocketBase unavailable;
  - expired authentication;
  - reconnecting;
  - stale stream;
  - runtime unavailable;
  - provider unavailable.
- [ ] Make transcript projection resilient to reconnects, duplicate events, interrupted runs, large prompts, and late tool results.
- [ ] Show clear run states:
  - queued;
  - working;
  - waiting for approval;
  - waiting for user input;
  - failed;
  - cancelled;
  - completed.
- [ ] Show active background tasks/subagents without requiring the user to inspect raw events.

## Session Lifecycle

- [ ] Finish new, resume, fork, clone, archive, rename, search, and background session flows.
- [ ] Add pagination, filtering, sorting, and strict project scoping.
- [ ] Preserve selected project, agent, model, thinking level, and applicable runtime settings with server-side validation.
- [ ] Persist local drafts without accidental sends.
- [ ] Add transcript/message/tool-result copy and export actions.
- [ ] Add confirmations for destructive operations.

## New-Session Routing

Canonical new-session routes:

```text
/new
/new/:agentName
/new/:projectName/:agentName
```

- [ ] Resolve project and agent names server-side.
- [ ] Treat a single segment as an agent in General Chat.
- [ ] Preserve project, agent, model, thinking level, and permission context on creation.
- [ ] Create the session on first send and navigate to its canonical route.
- [ ] Add route coverage for encoded names, unknown resources, disabled agents, and direct reloads.

## Context Attachments

The chat input `+` menu should support:

- Upload file
- Website
- Image
- Text

- [ ] Add file attachments with loading/error/remove states.
- [ ] Resolve website context through the bridge with safe URL handling.
- [ ] Support image context for vision-capable models.
- [ ] Support pasted clipboard images.
- [ ] Warn without discarding input when the selected model lacks vision support.
- [ ] Add editable text context using Monaco.
- [ ] Allow text to remain context-only or explicitly create a project `.md` file.
- [ ] Convert large pasted text into named context attachments.
- [ ] Show attachments as removable chips/cards in a horizontal carousel.
- [ ] Define type, size, count, and total-context limits.

## Composer and Commands

- [ ] Dock model selection next to send/steer/queue controls.
- [ ] Keep permission state outside the normal composer selector.
- [ ] Pass Pi slash commands through using one command discovery/execution path.
- [ ] Support autocomplete, keyboard navigation, arguments, command history, and errors.
- [ ] Implement `/permissions` as a focused command card.
- [ ] Enter inserts newline.
- [ ] Ctrl+Enter sends.
- [ ] Honor IME behavior and accessibility.
- [ ] Animate transient UI while respecting `prefers-reduced-motion`.

## Agent Routing and Handoff

- [ ] Allow an optional routing-model pass when no agent is selected.
- [ ] Record the routing decision.
- [ ] Keep direct agent selection locked after meaningful conversation state exists.
- [ ] Support `/handoff`.
- [ ] Summarize context explicitly for the target agent.
- [ ] Preserve original transcript and record source/target agent metadata.
- [ ] Make handoff failure retryable.

## Archived Sessions

- [ ] Keep archived sessions discoverable in their project.
- [ ] Visually distinguish archived sessions.
- [ ] Show the archived-session informational card.
- [ ] Atomically unarchive on send.
- [ ] Keep first-send behavior immediate and idempotent.

## Sending, Steering, and Queueing

- [ ] Normal sends are immediate when idle.
- [ ] New-session first sends are never queued.
- [ ] Render accepted user messages optimistically.
- [ ] Preserve final user-message appearance.
- [ ] While generating, replace Send with:
  - `Steer`
  - `Queue`
- [ ] Use Pi's steering path at the next tool boundary.
- [ ] Use Pi's follow-up queue only after current generation finishes.
- [ ] Show queued messages in an `Enqueued` card.
- [ ] Support remove, retry, reorder, and clear.
- [ ] Persist delivery intent:
  - sent;
  - steering;
  - enqueued;
  - delivered;
  - failed;
  - cancelled.
- [ ] Use client-generated message IDs and idempotency keys.
- [ ] Reconcile queue state from server events after reconnect.

## Suggested Responses

- [ ] Add an optional follow-up suggestion model.
- [ ] Generate suggestions only after the assistant run fully completes.
- [ ] Construct suggestion input only from the last user and assistant messages.
- [ ] Exclude tools, tool results, hidden reasoning, approvals, and unrelated history.
- [ ] Validate structured bounded suggestion output.
- [ ] Render keyboard-accessible `↳` actions.
- [ ] Send selected suggestions through the normal message path.
- [ ] Keep suggestions attached to their source assistant message.
- [ ] Deduplicate suggestion generation.

---

# Phase 2 — WebUI Quality of Life and Personalization (P1)

Subpolar should feel like a polished daily-use product, not just an administration panel.

## Themes and Appearance

- [ ] Add:
  - system theme;
  - light theme;
  - dark theme.
- [ ] Add user-selectable accent colors.
- [ ] Define semantic design tokens rather than hard-coded component colors.
- [ ] Make code blocks, diffs, Monaco, terminal output, charts, tool cards, and dialogs theme-aware.
- [ ] Persist appearance preferences per user.
- [ ] Support `prefers-reduced-motion`.
- [ ] Ensure accessible contrast across themes.
- [ ] Consider optional additional themes after tokenization is stable.

## Navigation and Productivity

- [ ] Add a global command palette.
- [ ] Add keyboard shortcuts for:
  - new chat;
  - session search;
  - project switch;
  - agent switch before session creation;
  - focus chat input;
  - open changes;
  - open inbox/review queue.
- [ ] Add recent projects/sessions.
- [ ] Add pinned/favorite projects, agents, and sessions.
- [ ] Add dense/comfortable transcript preferences if useful.
- [ ] Improve narrow-screen and touch behavior.
- [ ] Preserve approval, error, queue, and tool state on mobile.

## Information Density

- [ ] Allow collapsible tool calls.
- [ ] Allow configurable default expansion for:
  - tools;
  - code blocks;
  - diffs;
  - subagent activity.
- [ ] Show timestamps and duration where useful without cluttering normal chat.
- [ ] Add searchable transcript/activity views.
- [ ] Add clear empty/loading/offline/stale/error states everywhere.

---

# Phase 3 — Projects, Git, Worktrees, and Review (P1)

Make Subpolar a strong coding-agent surface without making coding the only supported use case.

## Project Workspace

- [ ] Add a safe project browser with:
  - file tree;
  - preview;
  - syntax highlighting;
  - explicit edit/write actions through normal tools.
- [ ] Show virtual project roots in navigation and session metadata.
- [ ] Enforce project boundaries on every filesystem operation.

## Git Service

Add a dedicated repository service rather than ad hoc browser filesystem calls.

- [ ] Repository discovery.
- [ ] Repository status.
- [ ] Branch listing/creation/switching.
- [ ] Git diff.
- [ ] Worktree discovery and management.
- [ ] Clone flow.
- [ ] Commit.
- [ ] Push.
- [ ] Configurable Git provider integrations for PR creation.
- [ ] Conflict detection and clear recovery UI.

## Changes / Diff Review

Create a first-class Changes surface.

- [ ] Show:
  - changed files;
  - staged changes;
  - unstaged changes;
  - untracked files.
- [ ] Support unified and split diff views.
- [ ] Show diffs generated by agent edits directly from conversation/activity entries.
- [ ] Add file/hunk revert.
- [ ] Allow selecting a diff/hunk as context for a follow-up request.
- [ ] Allow review comments/annotations that can be sent back to the agent.
- [ ] Support `Ask agent to fix this` from selected change context.
- [ ] Support commit/push/PR actions from reviewed changes.
- [ ] Clearly distinguish project workspace changes from isolated subagent worktree changes.

## Checkpoints and Restore

Checkpoints protect local work without requiring every safety boundary to become a Git commit.

- [ ] Create explicit checkpoints before risky/multi-file agent work where configured.
- [ ] Capture enough repository/workspace state to:
  - compare;
  - restore;
  - discard.
- [ ] Associate checkpoints with session/run/task IDs.
- [ ] Show checkpoint creation in activity.
- [ ] Make restore an explicit user-approved operation.
- [ ] Define behavior for untracked files and non-Git projects.

## Conversation Branching

- [ ] Allow branch/fork from any assistant output.
- [ ] Fork using the selected assistant message as anchor.
- [ ] Preserve project, agent, model, ownership, and branch-point metadata.
- [ ] Keep parent transcript immutable.
- [ ] Show parent/child relationships.
- [ ] Keep creation idempotent.

---

# Phase 4 — Tasks, Subagents, and Parallel Coding Work (P1)

Subagents are exposed through a normal Subpolar tool.

There is no separate privileged orchestration subsystem.

## Subagent Tool

Add a built-in capability such as:

```text
subagent/run
```

Possible inputs:

```text
agent
task
project
workspace_mode
context
optional model override
```

- [ ] Make the subagent tool grantable/revocable like any other tool.
- [ ] Require the caller to have permission to use the selected target agent.
- [ ] Prevent capability escalation.
- [ ] Create a visible child run/task.
- [ ] Give the child an isolated context window.
- [ ] Stream child activity into the parent session at an appropriate summarized level.
- [ ] Allow the parent to wait, poll, or continue while the subagent runs.
- [ ] Return a structured result to the parent.
- [ ] Support cancellation.
- [ ] Enforce concurrency limits.
- [ ] Audit creation, capability selection, approvals, and result.

## Isolated Worktrees for Coding Subagents

Mutating coding subagents should use isolated worktrees by default.

```text
Parent project workspace
        |
        +--> worktree/subagent-a
        +--> worktree/subagent-b
        +--> worktree/subagent-c
```

- [ ] Create a worktree automatically for mutating coding subagents.
- [ ] Record base branch/ref.
- [ ] Associate each worktree with its task/subagent.
- [ ] Keep parent workspace unchanged while parallel work runs.
- [ ] Show changed files and diff per worktree.
- [ ] Support:
  - apply/merge;
  - cherry-pick where appropriate;
  - discard;
  - retry;
  - conflict resolution.
- [ ] Clean up abandoned worktrees safely.
- [ ] Allow read-only subagents to share the parent workspace when mutation is impossible by policy.
- [ ] Never infer that an agent is read-only only from its prompt; use actual tool/capability policy.

## Tasks and Parallel Runs

- [ ] Add durable Task records.
- [ ] Associate tasks with:
  - parent session;
  - parent run;
  - owning agent;
  - child subagents;
  - project;
  - worktree;
  - review state.
- [ ] Allow multiple tasks/subagents to execute concurrently within configured limits.
- [ ] Expose progress/status in the WebUI.
- [ ] Keep task state independent from a single chat message.
- [ ] Allow completed coding tasks to transition to `review_required`.

## Review Inbox

Add one place for work that needs human attention.

Inbox categories:

- approval required;
- agent question;
- task completed;
- task failed;
- changes ready for review;
- automation result;
- browser action requiring approval if applicable.

- [ ] Deduplicate attention items.
- [ ] Resolve inbox items when underlying state changes.
- [ ] Deep-link to session/task/change/approval.
- [ ] Support filtering by project and type.
- [ ] Add optional notification delivery without making notifications the source of truth.

---

# Phase 5 — Agent Profiles and Templates (P1)

Agents are reusable policy-and-behavior configurations.

## Agent Management

- [ ] Create.
- [ ] Edit.
- [ ] Duplicate.
- [ ] Disable.
- [ ] Delete.
- [ ] Validate server-side.
- [ ] Preview effective runtime configuration before launch.
- [ ] Show source of effective decisions:
  - global;
  - agent;
  - project override;
  - session override where permitted.
- [ ] Show unresolved tool/skill IDs.
- [ ] Show approval requirements.
- [ ] Add a real-context tool test panel.

## Agent Configuration

Configure independently:

- system instructions;
- authored instructions;
- default model;
- thinking level;
- built-in tool policy;
- registered tool policy;
- browser tool policy;
- memory tool policy;
- subagent capability;
- approval mode;
- skills;
- context inclusion modes;
- project overrides.

## Built-In Agent Templates

Templates are starting configurations, not special runtime modes.

Initial templates:

### General

Balanced everyday agent with safe defaults.

### Coding

Project-aware coding agent with filesystem, search, Git, and optionally shell access.

### Plan (Coding)

A planning/research-oriented coding profile.

Default characteristics:

- read/search tools;
- Git status/diff inspection;
- no write/edit by default;
- no mutating shell operations by default;
- can produce implementation plans;
- user may duplicate/customize it like any other agent.

### Reviewer

Read-oriented code/diff review profile.

Templates must remain editable after creation.

---

# Phase 6 — Capability Context Modes for Tools and Skills (P1)

Having access to a tool or skill is separate from how it enters model context.

This is important for context size, discovery quality, and least-privilege reasoning.

## Tool Context Modes

Initial modes:

### Always

The tool definition is included directly in the agent's available tool/context surface.

Good for a small number of frequently used built-ins.

### Discoverable

The tool is authorized for the agent but is not injected eagerly.

The agent discovers it through `search-tool` / capability discovery and receives the schema when needed.

This should be the preferred mode for large integration catalogs.

### On-demand only

The capability can be resolved only through an explicit tool-selection/discovery operation or explicit user/agent action.

### Disabled

The agent cannot discover or call it.

- [ ] Store context mode separately from authorization/risk policy.
- [ ] Ensure discovery never reveals disabled tools.
- [ ] Let project overrides reduce access or context exposure.
- [ ] Show effective mode in the agent editor and tool browser.

## Skill Context Modes

Initial modes:

### Always loaded

Skill instructions are included when the agent session starts.

### Discoverable

Only skill metadata is discoverable; the full skill is loaded when selected.

### Explicit only

The skill is loaded only through explicit invocation/selection.

### Disabled

The skill is unavailable.

- [ ] Keep skill metadata small.
- [ ] Avoid injecting entire skill libraries.
- [ ] Record when a skill is loaded.
- [ ] Let policies control whether agents may create/update skills in the future.

---

# Phase 7 — Memory (P1/P2)

Persistent memory is off by default.

Memory should be explicit, searchable, permissioned, and auditable.

## Memory Configuration

- [ ] Global user setting: memory disabled by default.
- [ ] Optional per-agent memory permission.
- [ ] Optional project-scoped memory stores.
- [ ] Clearly show when a session/agent has memory capability.
- [ ] Do not silently enable memory because a provider supports it.

## Memory Tools

Initial tools:

```text
memory/query
memory/write
memory/update
memory/delete
```

- [ ] `memory/query` searches only memory scopes available to the active agent/session.
- [ ] `memory/write` creates explicit memory entries.
- [ ] `memory/update` changes a known entry.
- [ ] `memory/delete` removes or tombstones an entry according to retention design.
- [ ] Every mutation is auditable.
- [ ] Memory tools use normal permission/approval policy.
- [ ] Agent profiles may be query-only.
- [ ] Avoid automatically exposing all memory entries to every run.

## Memory Scope

Possible initial scopes:

- user;
- agent;
- project.

Do not add implicit cross-user or cross-project recall.

---

# Phase 8 — Browser Tools and Browser Sessions (P1)

Add a browser capability set so authorized agents can inspect and control websites similarly to modern browser-operating agents.

Browser automation must remain a normal Subpolar capability with tool-level permissions and audit.

## Browser Session Model

```text
Browser Session
├── owner
├── project/session
├── tabs
├── current page
├── cookies/storage boundary
├── activity
└── lifecycle state
```

- [ ] Create/close browser sessions.
- [ ] Keep browser state server-side.
- [ ] Associate browser sessions with user/session/task ownership.
- [ ] Decide whether persistent browser profiles are supported separately from ephemeral sessions.
- [ ] Provide clear UI for active browser state.

## Initial Browser Tools

Exact naming can evolve, but cover:

```text
browser/open
browser/navigate
browser/back
browser/forward
browser/tabs
browser/click
browser/type
browser/press
browser/select
browser/scroll
browser/read
browser/find
browser/screenshot
browser/download
browser/upload
browser/wait
browser/close
```

- [ ] Prefer semantic accessibility/DOM targets over raw coordinates when possible.
- [ ] Allow screenshots for visual reasoning.
- [ ] Make downloads explicit artifacts with ownership and limits.
- [ ] Make uploads explicit and policy-controlled.
- [ ] Protect local/private network targets according to browser/network policy.
- [ ] Apply timeouts and resource limits.
- [ ] Audit actions without dumping sensitive page contents by default.

## Browser Tool Permissions

Browser actions must be independently configurable.

Example policy groups:

- read/navigation;
- form interaction;
- file upload;
- download;
- authentication-sensitive actions;
- purchase/submit/destructive actions.

A profile may have browser reading without browser writing.

- [ ] Support approval requirements by tool/action risk.
- [ ] Show browser actions inline in activity/transcript.
- [ ] Allow the user to take over/interact with the browser where feasible.
- [ ] Allow browser sessions to be attached to subagent tasks subject to capability policy.

---

# Phase 9 — Local Conversational Voice: STT and TTS (P1/P2)

Voice should be built into Subpolar rather than tied to a model provider.

The target is local-capable, low-friction conversational interaction.

## Speech-to-Text

Flow:

```text
Microphone
   ↓
local STT backend
   ↓
partial/final transcript
   ↓
chat input
   ↓
normal Subpolar send path
```

- [ ] Local STT backend support.
- [ ] Streaming/partial transcription where backend allows it.
- [ ] Configurable language or automatic detection.
- [ ] Push-to-talk.
- [ ] Optional conversational continuous mode.
- [ ] Allow user correction before submission where appropriate.
- [ ] Display recording/transcribing/error states.
- [ ] Do not make cloud STT a requirement.

## Text-to-Speech

Flow:

```text
assistant output
   ↓
local TTS backend
   ↓
streamed/generated audio
   ↓
WebUI player / conversational playback
```

- [ ] Local TTS backend support.
- [ ] Voice selection.
- [ ] Speed/output settings where backend supports them.
- [ ] Stream or begin playback before an extremely long response fully finishes where feasible.
- [ ] Stop/cancel speech.
- [ ] Do not automatically read responses unless enabled.

## Conversational Voice Mode

- [ ] Optional mode that combines:
  - microphone capture;
  - local STT;
  - normal agent execution;
  - local TTS.
- [ ] Keep transcript visible.
- [ ] Preserve normal tool approval UX.
- [ ] Interrupt TTS when the user starts speaking if conversational mode supports interruption.
- [ ] Ensure voice mode uses the same session and agent state as typed interaction.
- [ ] Keep voice optional and disabled unless configured.

Voice provider/backend settings belong under user/runtime settings rather than being hard-coded to an agent provider.

---

# Phase 10 — Integrations and Tool Operations (P1)

## MCP

- [ ] Finish MCP server management.
- [ ] Discover tools and schemas.
- [ ] Show connection state and errors.
- [ ] Apply tool context modes.
- [ ] Keep permissions per discovered tool/capability rather than implicitly trusting an entire server.

## OpenAPI / HTTP

- [ ] Provider editing.
- [ ] Operation refresh.
- [ ] Schema preview.
- [ ] Credential references.
- [ ] Context modes per operation.
- [ ] SSRF/private-network policy.
- [ ] Redirect validation.
- [ ] Request timeouts.
- [ ] Response-size limits.
- [ ] Credential isolation.

## Tool Registry

- [ ] Canonical IDs such as `provider/operation`.
- [ ] Search/discovery through `search-tool`.
- [ ] Schema validation.
- [ ] Risk class.
- [ ] Approval requirement.
- [ ] Context mode.
- [ ] Enabled state.
- [ ] Audit.
- [ ] No secret credentials in ordinary metadata.

---

# Phase 11 — Skills (P1/P2)

Skills are reusable procedural context, independent from tool authorization.

## Skill Management

- [ ] Browse.
- [ ] Install/create.
- [ ] Edit.
- [ ] Duplicate.
- [ ] Enable/disable.
- [ ] Agent scope.
- [ ] Project scope.
- [ ] Version metadata.
- [ ] Context mode.
- [ ] Inspect effective skill set.

## Future Skill Authoring

After core skill management is stable:

- [ ] Allow an agent to propose a reusable skill.
- [ ] Require explicit permission for skill creation/update.
- [ ] Review changes before activation where configured.
- [ ] Keep authored skills auditable/versionable.

---

# Phase 12 — Automations (P1)

Automations execute normal Subpolar agents and capabilities.

Do not create a second lightweight agent implementation.

## Automation Model

```text
Automation
├── name
├── enabled
├── schedule / trigger
├── prompt
├── agent
├── project
├── optional model override
├── capability/permission context
├── last run
├── next run
└── metadata
```

## Scheduling

- [ ] Durable schedule records.
- [ ] Timezone.
- [ ] Cron-like recurring schedules.
- [ ] One-shot schedules.
- [ ] Retry policy.
- [ ] Concurrency policy.

## Execution

- [ ] Use the normal Pi/Subpolar session runtime.
- [ ] Apply normal agent policy.
- [ ] Apply normal tool/skill context modes.
- [ ] Apply approval rules.
- [ ] Record normal audit/activity events.
- [ ] Allow automations to create Tasks.
- [ ] Send completed/failed/review-required work to the Review Inbox.
- [ ] Add run history and cancellation.
- [ ] Make automation-created work clearly distinguishable from interactive sessions.

## Future Triggers

After scheduling is dependable, consider:

- webhook triggers;
- repository events;
- integration events.

Do not make trigger-specific code bypass normal execution policy.

---

# Phase 13 — Notifications and Remote Use (P1/P2)

## Notifications

Optional delivery for:

- approvals;
- task completion;
- task failure;
- automation results;
- agent questions;
- review-required changes.

Notifications are pointers into authoritative Subpolar state, not state themselves.

## Remote-Friendly Product Behavior

- [ ] Trusted LAN deployment guidance.
- [ ] Tailscale/VPN-friendly configuration.
- [ ] Reverse-proxy guidance.
- [ ] Device/session management.
- [ ] Robust reconnect across network changes.
- [ ] Mobile-responsive approvals and review.
- [ ] PWA installability.
- [ ] Push notifications where practical.
- [ ] Keep network-wide exposure opt-in and documented.

---

# Phase 14 — Two Distinct CLIs (P0/P1)

Keep **tool access for external harnesses** separate from **running the full Subpolar agent locally**. Both use Subpolar domain contracts, but only one embeds the shared core.

## `subpolar-cli` — Standalone Headless Agent (P0 after Phase 0A)

`subpolar-cli` composes the same `subpolar-core` and Pi SDK used by the WebUI **in-process** with the local adapter. It is not an HTTP wrapper around the WebUI and does not need PocketBase or a running server.

### Default State Model

- [ ] Stateless-by-default core execution: no hidden persistent global daemon/database.
- [ ] Persist only explicitly configured authentication/provider settings and lightweight project/session selection or references by default.
- [ ] Permit ephemeral sessions with conversation state held for the current process; support optional explicitly enabled local session transcript storage for resuming across invocations.
- [ ] Define what a session/project "reference" means when the underlying session is ephemeral; do not present a stale reference as resumable context.
- [ ] Support `--project`, `--agent`, `--model`, and `--session` as validated selectors; avoid claiming server ownership from raw paths or flags.
- [ ] Local auth store is **not** PocketBase user authentication. Use provider credentials for model access and explicit remote credentials only if a future remote-connect mode is added.
- [ ] Share policies, context assembly, tool gateway, approvals, audit semantics, skills, browser tools, memory opt-in, and subagent behavior with WebUI core; capabilities requiring durable state must report if unavailable.
- [ ] Use CLI prompts/stdin or explicit noninteractive approval policy; do not silently grant tools in scripts.

### Initial Command Surface

| Command | Purpose |
| --- | --- |
| `subpolar-cli` | Start an interactive headless agent session |
| `subpolar-cli run <prompt>` | Execute one prompt and return a result |
| `subpolar-cli auth ...` | Configure/list/remove provider credentials safely |
| `subpolar-cli agents list` | Inspect available local agent profiles/templates |
| `subpolar-cli projects list` | List configured local project references |
| `subpolar-cli projects select <name>` | Select local project context |
| `subpolar-cli sessions list` | List sessions available in the configured local store |
| `subpolar-cli sessions resume <id>` | Resume only where durable session data exists |
| `subpolar-cli sessions export <id>` | Export available session data explicitly |

- [ ] Support human-readable output, `--json`, JSONL events, stdin prompts, timeouts, cancellation, and appropriate exit codes.
- [ ] Stream assistant output, tool calls/results, approvals, subagents, and errors using shared domain events.
- [ ] Support Pi slash commands where meaningful in interactive terminal mode.
- [ ] Avoid duplicating provider/model configuration, agent selection, or tool execution business logic in CLI commands.
- [ ] Provide startup/packaging documentation for local and CI usage without launching WebUI.

## Tools CLI — Remote Tool Gateway Utility (P0 after Phase 0)

Replace the planned general-purpose `@agents-cli` harness with a **tools-only CLI**, provisionally named `@subpolar/tools-cli` / `subpolar-tools` (final package/binary name can be settled during implementation). Do not use this tool utility to create agent sessions, send chat messages, steer, queue, or run Pi.

The tools CLI is an authenticated HTTP client of a running Subpolar deployment. It must not import `subpolar-core`, embed Pi, instantiate local adapters, or access PocketBase directly.

### Authentication and Scope

- [ ] Use scoped remote credentials rather than `SUBPOLAR_INTERNAL_TOKEN`.
- [ ] Support environment/config/stdin credentials without revealing tokens in logs or shell history.
- [ ] Bind access to an authenticated principal and permitted project/agent/session context as needed for tool-policy checks.
- [ ] Require an authorized execution context supplied by the caller or created through a limited documented context mechanism; do not create an agent conversation implicitly.
- [ ] Support revocation, rotation, expiry, and CI credential cleanup.

### Initial Tool Commands

| Command | Purpose |
| --- | --- |
| `subpolar-tools health` | Check remote gateway and capability version |
| `subpolar-tools list` | List tools visible in authorized context |
| `subpolar-tools query <text>` | Discover authorized tools via `search-tool` semantics |
| `subpolar-tools describe <id>` | Show schema, risk, approval and context mode |
| `subpolar-tools add` | Register/update a harness-provided tool definition |
| `subpolar-tools call <id>` | Execute through normal policy/approval/audit gateway |
| `subpolar-tools approvals list` | Inspect relevant pending tool approvals |
| `subpolar-tools approvals continue <id>` | Continue only an authorized approved call |
| `subpolar-tools approvals reject <id>` | Reject an authorized pending tool call |
| `subpolar-tools events` | Stream relevant tool/approval events |

### Tool Contracts

- [ ] Registration supports canonical ID, namespace, description, adapter/target, input/output schema, risk, approval requirement, enabled state, and non-secret metadata.
- [ ] Validate schemas and reject malformed/reserved IDs.
- [ ] Use idempotency for registration and calls.
- [ ] Accept JSON from `--input`, `--input-file`, or stdin.
- [ ] Return tool result/structured error, call ID, and approval ID when applicable.
- [ ] Provide human output, `--json`, JSONL for streams, stable exit codes, `--wait`, timeout, and cancellation.
- [ ] Never silently select `allow_all` or bypass approval because the caller is a CLI.
- [ ] Document how external harnesses attach their own agent identity/context without impersonating another user's sessions.

**Exit criteria:** `subpolar-cli` runs a complete agent locally using shared core with no PocketBase process; `subpolar-tools` reaches an authenticated server-side tool gateway without embedding a runtime. Both use the same validation and policy semantics in their respective authorized contexts.

---

# Phase 15 — Operations, Data Lifecycle, and Release Engineering (P0/P1/P2)

## PocketBase and Data

- [ ] Keep PocketBase schema/migrations in its adapter, not in core.
- [ ] Schema migration/versioning.
- [ ] Rollback procedure.
- [ ] Compatibility rules.
- [ ] Backup/restore documentation for metadata and session data.
- [ ] Explicit retention/deletion behavior.

## Resource Controls

Add limits for:

- prompt/context size;
- attachments;
- tool inputs/results;
- concurrent sessions;
- concurrent tasks;
- concurrent subagents;
- browser sessions;
- browser downloads;
- external requests;
- retained audit data;
- streamed output;
- voice buffers where relevant.

Make truncation and timeout behavior explicit.

## Observability

- [ ] Structured logs.
- [ ] Audit retention policy.
- [ ] Exportable diagnostics.
- [ ] Operational dashboards or metrics.
- [ ] Avoid exposing prompts, credentials, sensitive tool inputs, memory entries, or private browser contents by default.

---

# Phase 16 — End-to-End Product Verification (P0/P1)

Build repeatable tests proving that PocketBase-backed WebUI and standalone `subpolar-cli` share one Subpolar core, while the tools CLI talks only to the remote tool gateway.

## Core Lifecycle

- [ ] Execute identical core fixture suites with local and PocketBase adapters.
- [ ] Start isolated PocketBase.
- [ ] Start Subpolar bridge/WebUI on test ports.
- [ ] Wait for readiness.
- [ ] Create test user/project/agent/session.
- [ ] Register deterministic fixture tools.
- [ ] Test discovery visibility.
- [ ] Test schema description.
- [ ] Test allowed tool.
- [ ] Test denied tool.
- [ ] Test approval-required tool.
- [ ] Verify exactly-once behavior with idempotency.
- [ ] Verify audit records.

## Messaging and Recovery

- [ ] Idle send.
- [ ] Steering.
- [ ] Queue.
- [ ] Queue mutations.
- [ ] Disconnect/reconnect with cursor replay.
- [ ] Bridge restart during generation.
- [ ] Pending approval recovery.
- [ ] Queued-message recovery.
- [ ] Archived-session unarchive-on-send.

## Context and Commands

- [ ] File attachment.
- [ ] Website attachment.
- [ ] Image attachment.
- [ ] Text attachment.
- [ ] Large paste.
- [ ] Vision capability warning.
- [ ] Slash commands.
- [ ] `/permissions`.
- [ ] `/handoff`.
- [ ] Suggested responses.

## Git / Worktrees / Subagents

- [ ] Create isolated mutating subagent.
- [ ] Verify separate worktree.
- [ ] Run two or more subagents concurrently.
- [ ] Verify parent workspace isolation.
- [ ] Review each diff.
- [ ] Apply one subagent result.
- [ ] Discard another.
- [ ] Verify permission non-escalation.
- [ ] Verify foreign-user/task denial.
- [ ] Test cancellation and cleanup.
- [ ] Test conflict state.

## Memory

- [ ] Memory off by default.
- [ ] Query denied when memory capability is disabled.
- [ ] Enable memory for an agent.
- [ ] Write/query/update/delete with audit.
- [ ] Verify project/user scope isolation.

## Browser

- [ ] Open/navigate/read.
- [ ] Interact with a deterministic test page.
- [ ] Verify read-only browser profile cannot perform write interaction.
- [ ] Verify approval-gated action.
- [ ] Verify session ownership.
- [ ] Verify SSRF/private-network restrictions according to policy.
- [ ] Test crash/interruption handling.

## Voice

- [ ] Local STT test path.
- [ ] Local TTS test path.
- [ ] Voice settings persistence.
- [ ] Conversation uses normal session path.
- [ ] Tool approval remains visible during voice use.

## CLI and Adapter Separation

- [ ] Run `subpolar-cli` with WebUI, HTTP server, and PocketBase unavailable.
- [ ] Verify `subpolar-cli` does not persist transcripts in the default ephemeral configuration.
- [ ] Verify explicitly enabled local session storage supports resume after process restart.
- [ ] Verify no stale ephemeral session reference is presented as resumable.
- [ ] Confirm both adapters give consistent policy, approval and tool execution decisions.
- [ ] Confirm `subpolar-tools` cannot send prompts, start Pi or bypass tool policy.
- [ ] Confirm tools CLI cannot access WebUI data outside its authorized context.
- [ ] Verify WebUI backward compatibility and PocketBase migration from the existing schema.
- [ ] Exercise explicit unsupported-capability errors for in-memory adapter durability/replay requirements.

## CI Gates

- [ ] WebUI unit/component tests.
- [ ] Bridge/server typechecks.
- [ ] Contract tests.
- [ ] Standalone `subpolar-cli` tests (without PocketBase).
- [ ] Remote tools CLI tests.
- [ ] Core/adapter contract suites.
- [ ] Browser E2E.
- [ ] Subagent/worktree E2E.
- [ ] Memory permission tests.
- [ ] Browser-tool security tests.
- [ ] Dependency checks.
- [ ] Secret-leak checks.
- [ ] Container checks.

---

# Feature Matrix

This section describes where major product capabilities live.

| Capability | Product owner |
| --- | --- |
| Authentication | Subpolar core auth contracts + deployment-specific identity adapter |
| Session ownership | Subpolar core validation + selected persistence/identity adapter |
| Agent profiles | Subpolar |
| Project/workspace model | Subpolar |
| Tool registry | Subpolar |
| Tool policy | Subpolar |
| Tool context mode | Subpolar |
| Skills | Subpolar |
| Skill context mode | Subpolar |
| Approvals | Subpolar |
| Audit | Subpolar |
| Memory | Subpolar |
| Browser sessions/tools | Subpolar |
| Tasks | Subpolar |
| Subagent permissions/orchestration | Subpolar |
| Worktree lifecycle | Subpolar |
| Automations | Subpolar |
| TTS/STT UX and backend abstraction | Subpolar |
| Data persistence | WebUI: PocketBase adapter; standalone CLI: local/ephemeral adapter |
| Core orchestration and tool policy | Shared Subpolar core (WebUI and `subpolar-cli`) |
| Remote tool gateway client | `subpolar-tools` (no agent runtime) |
| Model execution loop | Pi SDK |
| Steering/follow-up semantics | Pi SDK exposed through Subpolar |
| Pi slash commands | Pi SDK exposed through Subpolar |

---

# Explicit Non-Goals for the Current Roadmap

- No ACP runtime integration yet.
- No generic multi-harness runtime adapter layer yet.
- The tools CLI is not an agent harness; it only operates authorized tools.
- `subpolar-cli` must not reimplement the shared Subpolar core or require PocketBase.
- Stateless-by-default does not imply fake persistent sessions or cross-deployment state sharing.
- Remote clients do not receive direct PocketBase access; the WebUI PocketBase adapter is internal.
- Tool registration never disables authorization, approval, or audit.
- Subagents never bypass the normal tool gateway.
- Parallel coding work does not mutate one shared workspace concurrently; use isolated worktrees.
- Plan behavior is not a hard-coded runtime mode; use agent profiles/templates.
- Persistent memory is not enabled by default.
- Memory is not silently injected wholesale into prompts.
- Browser automation does not imply unrestricted browser permissions.
- Voice does not require cloud STT/TTS.
- Network-wide exposure is not assumed by default.
- Subpolar does not need to copy every feature of Codex, Hermes, T3 Code, or any other agent UI; features should reinforce Subpolar's own control-plane model.

---

# Near-Term Recommended Build Order

The roadmap phases describe product areas, but implementation should proceed in dependency order.

## Milestone A — Dependable Subpolar

1. Phase 0A shared core extraction and adapter contracts.
2. Phase 0 contracts/recovery/security.
3. Standalone `subpolar-cli` minimal headless composition and local adapter.
4. PocketBase WebUI regression and adapter parity tests.
5. Phase 1 WebUI reliability.
6. Shared event model and E2E coverage.
7. QoL/theme foundation.

## Milestone B — Strong Coding Surface

1. Git repository service.
2. Diff/Changes UI.
3. Checkpoints.
4. Worktree lifecycle.
5. Task model.
6. Subagent tool.
7. Parallel isolated coding runs.
8. Review Inbox.

## Milestone C — Agent Control Plane

1. Agent CRUD/effective configuration.
2. Built-in templates including Plan (Coding).
3. Tool context modes.
4. Skill context modes.
5. Memory tools with memory off by default.

## Milestone D — General-Purpose Agent Capabilities

1. Browser session runtime.
2. Browser tools and policies.
3. Local STT.
4. Local TTS.
5. Conversational voice.
6. Automation/task integration.

## Milestone E — Tool Gateway Clients and Operations

1. Remote `subpolar-tools` utility and scoped gateway credentials.
2. Notifications/PWA improvements.
3. Operational diagnostics.
4. Deployment/backup/release hardening.

---

# Release Standard

A tagged Subpolar release should have:

- documented startup and migration commands;
- a stable API/event contract for the features it exposes;
- core/adapter parity for WebUI and standalone CLI;
- documented ephemeral versus durable local session semantics;
- passing WebUI and contract tests;
- no credential leakage in normal logs;
- explicit tool, skill, memory, subagent, and browser permissions;
- recoverable session/task state;
- clear migration notes for PocketBase schema changes;
- Docker deployment guidance;
- no privileged client path that bypasses the Subpolar control plane.
