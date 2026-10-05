# Remote Git providers

`provider-contracts.ts` defines the typed, read/write provider interface and capability discovery. `providers.ts` implements GitHub.com and Gitee.com adapters; both construct requests only against their fixed API hosts. Callers supply an owner/repository pair, never a Git remote URL or API base URL. Tokens are supplied only through the server-side `GitProviderTokenSource` callback and are never accepted from request/client data by these adapters.

The adapters limit requests to 30 seconds and response bodies to 4 MiB (with lower configurable limits), reject redirects, validate repository coordinates, and return sanitized provider errors. They are a foundation only: **not connected to owner credential UI, account storage, or routes**. Do not wire these into general preferences; those existing Git credentials are not a safe credential store. An owner-scoped credential design is required before integration.
