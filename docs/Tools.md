# Tools

## Runtime model

The model does not invoke arbitrary integrations directly. It sees a small set of Pi tools that route requests into Subpolar's central tool runtime. External capabilities are registered in Subpolar's tool registry and are exposed through `search-tool` and `subpolar-tools`, rather than being added to the model as one Pi function per remote operation.

A registered definition is Subpolar's contract for a tool: its stable `namespace/operation` ID, description, input/output schemas, risk, approval requirement, enabled state, context visibility, and adapter-specific routing metadata. The registry entry selects which external operation can run and under what Subpolar policy; a provider's own description or annotations do not grant access or override that policy.

At a high level, a call is resolved against the registry, checked for enabled state and input requirements, evaluated against the active agent/session policy, and then dispatched through the definition's adapter. Results and execution failures return through the same tool-call path. Calls, denials, approvals, and execution failures are audited by Subpolar.

## Approval and model-visible results

Approval is part of the central tool runtime, not an adapter feature. An adapter does not decide whether a call is allowed: the registry's risk and approval settings and the active agent/session policy determine whether it may execute. A denied call must return a denial to the model; an allowed call proceeds to the adapter and returns its result.

**Current implementation caveat:** when a call needs manual approval, the in-process tool router currently creates a pending approval, sends a `permission.asked` event to the WebUI over the session event stream, and returns an `approvalRequired` result to the model without waiting for the user's decision. The WebUI submits its decision through the permission HTTP endpoint. This is not the desired resolver behavior: the model-facing call should remain pending while the WebUI decides, proceed on approval, and report a denial only on rejection. The current event/HTTP exchange is not a WebSocket request/response. The approval path needs to be aligned with that desired behavior before this page's high-level flow should be read as a guarantee that approvals are hidden from the model.

## Tool adapters

### Internal tools

Internal tools such as project file operations run through Subpolar's runtime with the selected project, session, and agent context. They use the same central registry and policy checks as external tools.

### HTTP tools

A direct HTTP definition describes one endpoint and request mapping. Subpolar applies its central checks first, then sends the request using the configured method, URL, headers, and parameter mapping. HTTP tools are appropriate when an operation has a simple request/response API and does not need an OpenAPI contract or an MCP session.

### OpenAPI tool servers

An OpenAPI provider describes a collection of HTTP operations. At session startup, Subpolar's OpenAPI integration reads provider configuration and its OpenAPI document, selects operations that have an `operationId`, derives each operation's inputs from path/query/header parameters and JSON request bodies, and registers selected operations in the central tool registry as `provider/operationId` definitions.

The OpenAPI document may be JSON, YAML, or an embedded object. Configurations can select operations and provide a base URL override and headers. The resulting tools are still central registry entries: the agent discovers and invokes them through `search-tool` and `subpolar-tools`, and the bridge executes each operation as an HTTP request. OpenAPI supplies the operation shape; Subpolar supplies agent access, risk, approval, auditing, and execution policy. A provider's HTTP service must be reachable from the Subpolar bridge.

This path is stateless at the operation level: Subpolar makes an HTTP request for each tool call rather than maintaining an MCP-style protocol session. It is a good fit for services with an OpenAPI description and ordinary HTTP operations.

### Web search and fetch

Subpolar exposes the provider-neutral `web.search` and `web.fetch` capabilities; search-provider-specific names and inputs are not exposed to the model. `web.search` uses the server-configured provider (`SUBPOLAR_WEB_SEARCH_PROVIDER`, currently Exa or Parallel), with credentials supplied through provider environment variables. `web.fetch` retrieves bounded text from an HTTP(S) page under the network policy. These are external operations and use the same central permission and approval path.

### MCP servers

An MCP definition also appears in the central registry as a Subpolar `namespace/operation` tool. It maps that agent-facing identity to an MCP server configuration and the server-side tool name. Only registered definitions are agent-facing; being advertised by an MCP server does not automatically make every server tool available to agents. The adapter now defaults to the stateless `2026-07-28` protocol. Set a server's `protocolVersion` to `2025-06-18` when connecting to a legacy server; that mode uses the initialize handshake and session behavior.

After the central runtime authorizes a call, the MCP adapter resolves the registered provider reference, connects to or reuses an initialized MCP client, calls the mapped server tool, and returns its content and error state through the normal tool result path. MCP discovery can normalize the server's advertised tools and schemas, but discovery is distinct from granting access: registration supplies Subpolar identity, risk, approval, enabled state, and visibility.

MCP transport can be local stdio or remote HTTP/SSE. The transport changes how protocol messages reach the server, not the central Subpolar checks. The adapter handles protocol sessions and provider errors; it does not replace registry policy, approvals, or audit logic. See [Embedding an MCP Server into Subpolar](Embedding%20an%20MCP%20Server%20into%20Subpolar.md) for the deployment boundary and current limitations.

## Discovery and use

External tools are not registered as individual Pi functions. Use `search-tool` to find relevant tools, then `subpolar-tools` to list, inspect, or call one. The active agent's policies and tool-context settings determine which registry entries are available.

## Teach Tools (Settings only)

Teach Tools is an interactive settings workflow for turning a CLI utility, an MCP server, or an OpenAPI document into reviewed registry definitions. The user describes the capability they want; Subpolar explores the source within bounded, read-only limits, then uses the user's configured model internally to select relevant source-backed operations and prepare draft descriptions (and CLI command/argument suggestions). The teaching assistant is an implementation detail of the authenticated settings route: it is not registered as a tool and is never exposed to the normal agent tool router.

Exploration does not invoke MCP operations or OpenAPI endpoints. CLI exploration is limited to allowlisted executables and help/introspection arguments; generated CLI commands run only after the user reviews and registers the draft, then remain subject to the normal approval and execution limits. Model-generated selections must refer to operations discovered from the supplied source. Secrets are not included in drafts where recognized, and credential values for MCP configuration must use environment references.

Drafts are proposals, not live capabilities: they remain disabled/unregistered while being reviewed. Each tool has a separate explicit confirmation and registration action. Registration is owner-scoped and goes through the existing registry validation; once registered, normal agent discovery, central policy, approval, audit, and adapter execution apply. Teach Tools does not bypass those runtime checks.

## Included by default

The default `master` agent can use:

- `read` — read project files.
- `write` — create or replace files; approval-required.
- `edit` — make targeted file changes; approval-required.
- `bash` — run commands in the project; approval-required.
- `grep` — search file contents.
- `find` — find files by pattern.
- `ls` — list directory contents.
- `search-tool` — find available tools.

`subpolar-tools` is available when the agent has access to external tools. Agents can have a smaller or larger set depending on their permissions. Policies can allow, deny, or require approval for a call.
