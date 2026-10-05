# Remote Git providers

`provider-contracts.ts` defines provider capabilities and typed repository/branch/issue/comment/pull-request/check operations. `providers.ts` implements GitHub.com and Gitee.com adapters against their fixed API hosts. Callers supply validated owner/repository coordinates, never a Git remote URL or API base URL. The adapters accept tokens only through a server-side callback; request/client data cannot supply credentials.

Owner-scoped GitHub/Gitee accounts are stored encrypted through the provider-account service and exposed to the UI only as credential-free identity/status records. Read-only data routes authenticate the owner, resolve their account, and invoke the adapters. The workspace panel currently supports repository metadata, branches, issues/comments, pull requests, and checks. Remote PR creation and other provider mutations are not exposed; capability discovery reports unsupported operations as unavailable.

The adapters limit requests to 30 seconds and response bodies to 4 MiB (with lower configurable limits), reject redirects, validate repository coordinates, and return sanitized provider errors. Provider REST access is separate from Git smart-HTTP transport: connecting an account does not authenticate local `git fetch` or `git push`.

## Remote Git mutation gate

Authenticated fetch/push and agent-facing Git mutation tools remain deliberately disabled. The Git executor has no credential-provider transport, the existing local mutation service is not wired through gateway approvals, and shared-host execution is not an OS sandbox. Do not put provider tokens in Git argv, remotes, repository config, process-wide environment, prompts, tool output, or logs.

Before enabling remote Git operations:

1. Resolve an opaque account ID only after authenticating the request and verifying account ownership and provider/remote match. Validate remotes against fixed GitHub/Gitee HTTPS hosts and reject embedded credentials, redirects, arbitrary hosts, and unapproved refspecs.
2. Implement a Git-specific ephemeral credential transport (not the provider REST token callback) that never persists a secret in argv, `.git/config`, a shared file, or inherited process environment. Return only bounded sanitized Git results.
3. Add separately typed `fetch`/`push` service operations. Tie durable gateway approval and audit to owner, workspace/project, session, remote/account, operation, and exact refs. Never interpret “connected account” as permission to push.
4. Expose fixed-schema tools only through the central gateway after current policy and approval checks. Harden allowed Git invocations against hooks, filters, fsmonitor, prompts, and subprocess behavior; raw Bash cannot be a bypass path.
5. Establish an isolated worker/container with tenant-only filesystem and credential access before claiming hostile multi-user safety. Application owner checks alone do not contain a subprocess or prevent direct Git calls from another trusted-host path.

Provider PR creation/comments and ordinary Git fetch/push are separate capabilities. Keep forge API mutations in `GitProvider`; keep commits, branches, fetches, pushes, and worktrees in `GitService`.
