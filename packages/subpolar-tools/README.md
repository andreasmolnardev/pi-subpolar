# `@subpolar/tools`

Persistence-neutral tool registration, authorization, and execution boundaries.

## What it does

- Canonicalizes tool IDs as `adapter/namespace/name`.
- Registers internal, HTTP, OpenAPI, MCP, browser, memory, and subagent adapters.
- Validates tool inputs against JSON-schema-style definitions.
- Resolves context and applies an injected policy before execution.
- Exposes authorization capabilities that cannot be manufactured by callers.
- Supports injected persistence, redaction hooks, and execution events.
- Provides the `subpolar-tools` CLI for calling a remote Subpolar gateway.

The registry does not choose a database or network implementation. Those boundaries are injected by the host application.

## Usage

```ts
import { createToolRegistry, canonicalizeToolId } from "@subpolar/tools";
```

The CLI is available with:

```sh
bun packages/subpolar-tools/src/cli.ts health --json
```

## Testing

```sh
bun test packages/subpolar-tools
```
