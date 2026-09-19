# Memory Capability

Memory is an opt-in gateway capability. It is disabled unless an agent's
`policies.memory` value is `true`, and it is never added to prompts or context
automatically. Agents must explicitly invoke `memory/query`.

Records are owned by the authenticated user and have one scope: `user`,
`agent`, or `project`. Agent and project records are checked against the active
session context. Queries are limited to 50 records, writes are bounded to 32 KiB,
updates use a required version, and deletes create tombstones. Writes may supply
an idempotency key.

`memory/write`, `memory/update`, and `memory/delete` use the normal tool policy
and approval flow. Plan and reviewer profiles are query-only. Tool-call audit
records include memory reads and mutations, but memory content is redacted from
ordinary audit input.

The PocketBase adapter advertises `memory.persistence` when its memory
collection is configured. The local adapter advertises that capability only
when `memoryFile` is explicitly configured; the default local adapter is
ephemeral and does not claim restart durability.
