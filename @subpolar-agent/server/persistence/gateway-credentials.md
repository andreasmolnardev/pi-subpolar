# Scoped Gateway Credentials

Credential management is intentionally server/browser-only. An authenticated PocketBase owner uses:

- `POST /api/gateway/credentials` with `{ principal, permissions, scope?, expiresAt? }` to create a credential. The response contains `secret` once.
- `GET /api/gateway/credentials` to list metadata. Secrets and hashes are never returned.
- `POST /api/gateway/credentials/:id/rotate` to revoke the old credential and return one replacement secret once.
- `DELETE /api/gateway/credentials/:id` to revoke a credential.

`permissions` contains `list`, `query`, `describe`, `add`, `call`, `approvals`, and/or `events`. `scope` may contain `projectIds`, `agentNames`, and `sessionIds`. The tools CLI uses the returned secret as `SUBPOLAR_TOOLS_TOKEN` or `--token` and remains remote-only.
