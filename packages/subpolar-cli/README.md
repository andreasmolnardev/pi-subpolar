# `@subpolar/runtime-cli`

The Subpolar command-line runtime and composition entry point.

## What it does

- Provides the `subpolar-cli` executable.
- Runs prompts through the core run service.
- Uses the local fixture executor by default.
- Accepts an injected Pi executor factory or module through the CLI composition API.
- Supports ephemeral sessions, JSON-file sessions, JSON output, JSONL lifecycle events, timeouts, and cancellation.

The CLI composes `@subpolar/runtime`, `@subpolar/db-local`, and `@subpolar/runtime-pi`. It is an application boundary, not part of the policy or persistence implementations.

## Usage

```sh
bun packages/subpolar-cli/src/cli.ts run "hello"
bun packages/subpolar-cli/src/cli.ts run "hello" --json
bun packages/subpolar-cli/src/cli.ts run "hello" --jsonl --timeout 30000
```

## Testing

```sh
bun test packages/subpolar-cli
```
