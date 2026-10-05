# `@subpolar/db-local`

Local persistence implementations for development, tests, and standalone CLI use.

## What it provides

- `EphemeralSessionStore` for in-memory session transcripts.
- `JsonFileSessionStore` for atomic JSON-file session persistence.
- `LocalMemoryStore` for owner-scoped local memories.
- `LocalSkillRepository` for versioned local skill records.
- `createLocalAdapter` to compose the local stores and capability metadata.

Without file paths, state is process-local and ephemeral. JSON-file persistence is deliberately single-process and does not claim multi-process concurrency, durable approvals, or event replay.

The adapter implements shared contracts and does not depend on Pi, PocketBase, WebUI, or network services.

## Workspace setup

From the repository root, use Bun 1.3.14 and `bun install --frozen-lockfile`.
The hoisted workspace shares compatible dependencies, but incompatible versions
may still require nested copies. Do not install separately in this package.
Owner-scoped records do not provide OS or hostile-tenant isolation.
See [Bun and multi-user operations](../../docs/bun-and-multi-user.md).

## Testing

```sh
bun test packages/subpolar-persistance-local
```
