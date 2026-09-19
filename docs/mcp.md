# MCP adapter

`@webui/server/mcp-adapter.ts` is a dependency-free MCP client for the Bun/Node server runtime. It is intentionally not wired into `server/tools.ts` yet; the later tool-router change can inject one adapter and use the same instance for discovery and calls.

## Exports

- `createMcpAdapter(options?)` — creates the injectable high-level adapter.
- `DefaultMcpAdapter` — default adapter implementation.
- `McpClient` — initialized client with `initialize()`, `listTools()`, `callTool()`, and `close()`.
- `StdioMcpTransport` and `HttpMcpTransport` — built-in transports.
- `McpTransport` and `McpTransportFactory` — injection seam for tests, pooling, or a future SDK transport.
- `normalizeMcpTool()` and `normalizeMcpTools()` — convert MCP `tools/list` entries to stable `{ toolId, name, inputSchema, outputSchema, ... }` values.
- `resolveMcpToolReference()` and `mcpConfigFromToolDefinition()` — resolve the repository's `ToolDefinition`-style fields (`namespace`, `target`, `operation`, and `metadata`).
- `mcpToolToRegistryDefinition()` — convert a discovered tool into the repository's snake_case registry shape.
- Types: `JsonRpcId`, `JsonRpcRequest`, `JsonRpcResponse`, `McpTransportKind`, `McpHeaderValue`, `McpLimits`, `McpServerConfig`, `McpClientOptions`, `McpTool`, `McpCallResult`, `McpToolReference`, `McpToolRegistryDefinition`, `McpErrorCode`, `NormalizeMcpToolsOptions`, `CreateMcpAdapterOptions`, and `McpAdapter`.
- `McpAdapterError` — errors include a stable code such as `MCP_TIMEOUT`, `MCP_REMOTE_ERROR`, `MCP_PROTOCOL_ERROR`, or `MCP_LIMIT_EXCEEDED`.

Import it directly until an existing server barrel is deliberately updated:

```ts
import { createMcpAdapter } from './mcp-adapter.ts'
```

## Configuration

No package installation is required. The host must provide a Bun/Node runtime with `fetch` for HTTP/SSE and permission to spawn the configured executable for stdio.

### stdio

```ts
const adapter = createMcpAdapter()
const tools = await adapter.discover({
  transport: 'stdio',
  command: 'your-mcp-server',
  args: ['--workspace', '/path/to/workspace'],
  namespace: 'provider',
  serverKey: 'provider-main',
})
```

The process communicates newline-delimited JSON-RPC on stdout. Its stdout must contain protocol messages only; diagnostics belong on stderr. `env` values can be literal strings or `{ env: 'PROCESS_ENV_NAME' }` references. The latter keeps secrets out of registry metadata.

### streamable HTTP

```ts
const adapter = createMcpAdapter()
const tools = await adapter.discover({
  transport: 'http',
  url: 'https://example.invalid/mcp',
  headers: { authorization: { env: 'MCP_AUTH_TOKEN' } },
  namespace: 'provider',
})
```

The HTTP transport sends JSON-RPC POST requests and accepts JSON responses or `text/event-stream` responses. It retains `mcp-session-id` and sends `MCP-Protocol-Version`.

### legacy HTTP + SSE

```ts
const tools = await adapter.discover({
  transport: 'sse',
  url: 'https://example.invalid/sse',
  namespace: 'provider',
})
```

The SSE transport first opens the URL with `GET`, reads the `event: endpoint` announcement, then POSTs JSON-RPC requests to the announced endpoint. JSON-RPC responses arriving on the long-lived SSE stream are correlated by ID.

## Registered tool references

A later `tools.ts` integration can pass its existing definition shape directly (extra `ToolDefinition` fields are harmless):

```ts
await adapter.invoke({
  tool_id: 'provider/echo',
  namespace: 'provider',
  target: 'your-mcp-server',
  operation: 'echo',
  metadata: {
    transport: 'stdio',
    args: ['--workspace', '/path/to/workspace'],
    serverKey: 'provider-main',
    toolName: 'echo',
  },
}, { value: 'hello' })
```

`metadata.mcp` may contain the same transport keys and takes precedence over top-level metadata. If `toolName` is omitted, `operation` is used. For HTTP/SSE, `target` is used as the URL unless `metadata.url` is supplied. For stdio, `target` is used as the command unless `metadata.command` is supplied.

`mcpToolToRegistryDefinition()` preserves MCP input/output schemas and maps annotations conservatively: destructive tools become `delete`, read-only tools become `read`, open-world tools become `external`, and unannotated tools default to `write` (therefore approval-required).

## Limits and lifecycle

Defaults are intentionally bounded: 30-second requests, a 5-minute maximum request timeout, 500 discovered tools, 100 list pages, 1 MiB arguments, 4 MiB responses, and 4 MiB stdio lines. Supply `limits` on `createMcpAdapter()` or a server config to tune them. Calls exceeding a configured maximum fail with `McpAdapterError`; MCP application-level tool failures are returned as `McpCallResult.isError === true`.

Keep one adapter per bridge/application lifetime so its initialized MCP clients can be reused. Call `await adapter.close()` during shutdown. The current module does not perform policy checks, approvals, auditing, or schema validation beyond requiring JSON-object arguments and size limits; those remain responsibilities of the central tool router.
