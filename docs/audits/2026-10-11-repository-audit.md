# Repository audit — 2026-10-11

Audited revision: `d10e20e`, branch `automations`. This report records findings; it does not fix them.

## Scope and limits

Repository-wide, risk-focused review of the bridge, domain routes, portable packages, authentication and principal boundaries, owner/project/session checks, tool authorization and approvals, persistence, automations, Git and subprocess execution, browser lifecycle/networking/control/artifacts, frontend identity cleanup/rendering, dependency lockfile, startup and deployment configuration. Reviewed current source and ran all main test families and a production build. No `.codegraph/` index exists.

This is not a line-by-line examination of every file or an exhaustive penetration test. Docker build/runtime, distributed deployments, hostile multi-tenant isolation, external OAuth/service integrations and real production load were not validated. Controlled reproductions used temporary local fixtures, not personal accounts or application data. Findings below distinguish reproduced behavior from dependency advisories and deployment limits.

## Findings

### A1 — P1: Ephemeral browser sessions leak a Chromium process

Location: `packages/subpolar-browser/src/engine.ts:178–195`, close at `604–615`.

An ephemeral start launches Chromium into `launchingBrowser`, then launches a second Chromium instance for `newContext`. Only the second browser is reachable through the stored context and closed by `close`/`dispose`. Successful sessions discard the reference to the first browser. Failure cleanup also selects the context's browser in preference to the first browser when a context exists.

Evidence: real worker/client started an ephemeral session and successfully waited 12 seconds. After `worker.close()` and removal of its temporary profile root completed, the Bun process remained alive with a Chromium child. Source shows the two launches and missing ownership of the first process. The audit explicitly terminated those fixture processes afterward.

Impact: repeated creation/closure accumulates processes and memory outside the session count, eventually exhausting worker resources. This is in the new browser implementation and was missed by the earlier functional tests.

Fix: use the already-created `launchingBrowser` for `newContext`, retain ownership through initialization, and close every owned browser on success teardown and error cleanup. Regression should prove exactly one launch per ephemeral session and process termination after repeated start/close cycles.

### A2 — P1: Read-only repository diff can execute a configured text-conversion command

Location: `@subpolar-agent/server/git/service.ts:102`, executor at `server/git/executor.ts:21–33`.

The Git diff arguments disable external diff but omit `--no-textconv`. Git still honors a repository's `diff.<driver>.textconv` configuration and `.gitattributes`, even with `--binary`. The minimal subprocess environment and `shell: false` do not stop Git from spawning this configured helper.

Evidence: a disposable repository with `file.txt diff=audit` and a local `diff.audit.textconv` helper was read with the exact diff argv through `executeGit`. The helper wrote a marker, proving execution. The separate session-workspace implementation already includes `--no-textconv` in its diff operations.

Impact: a read-only repository endpoint or gateway diff can execute local commands with bridge privileges without a mutation approval. Prerequisite: an attacker or other actor must influence local repository configuration; a tracked `.gitattributes` file alone does not supply the executable configuration.

Fix: add `--no-textconv` to all applicable read diffs and audit local Git configuration-driven execution paths. Test a configured helper that must never run.

### A3 — P1: Saving tool policies removes active denials before replacing them

Location: `@subpolar-agent/server/routes/settings.ts:27–38`.

The PUT handler deletes every current policy, then validates and creates replacement rows individually. Concurrent authorization can observe an empty or partial policy set. A write failure leaves denials permanently removed; malformed replacements are skipped after deletion.

Evidence: controlled route fixture paused the first create after delete. `evaluateAgentToolPolicy` for master `web.search` changed from `{deny:true}` before saving to `{allow:true}` during the save, even though the replacement requested the same denial.

Impact: an active agent can execute previously denied tools during a policy update. A failed settings save can broaden permissions afterward.

Fix: validate the whole replacement before any write and publish an atomic policy revision/transaction. All authorization readers must use the same committed revision. A route-only mutex does not protect concurrent gateway readers or other processes. Test concurrent execution and persistence failure.

### A4 — P2: Outbound total timeout ends at response headers

Location: `@subpolar-agent/server/core/network-policy.ts:326–328`; response handling at `232–256`.

`fetchWithNetworkPolicy` clears its total abort timer and detaches the caller abort signal as soon as it returns a streaming Response. The socket inactivity timer remains, but a server sending small periodic chunks avoids it. Reading the response body can exceed the advertised total timeout indefinitely, and cancellation after headers no longer reaches the upstream request.

Evidence: controlled local server sent a body byte every 10 ms. With `timeoutMs:30`, the helper plus `response.text()` succeeded after 277 ms rather than failing at the deadline.

Impact: remote HTTP tools and automation webhook response reads can hold operations open beyond their deadline. Automation cancellation can fail to interrupt a response read after headers.

Fix: keep the deadline and cancellation binding until EOF, cancellation or body failure; destroy the upstream stream at the deadline. Test a continuously dripping response and abort after headers.

### A5 — P2: Response byte limit is enforced after unbounded producer buffering

Location: `@subpolar-agent/server/core/network-policy.ts:243–247`; outer `limitedResponse` enforces the cap only when consuming.

The Node incoming response enters flowing mode and enqueues every chunk into a Web ReadableStream without byte counting or backpressure. The outer limiter checks bytes only when the caller reads. A chunked response can therefore buffer far more than the configured limit while consumption is delayed or absent.

Evidence: controlled chunked server sent 1,048,576 bytes before consumption with `maxResponseBytes:1024`. The byte-limit error occurred only when `response.text()` was called afterward. Content-Length checking does not cover this chunked case.

Impact: an allowed remote endpoint can exhaust bridge memory despite a nominal response limit.

Fix: enforce the cumulative cap directly on upstream arrival, destroy on overflow, and implement pause/resume or pull-based backpressure. Test delayed consumption and a response without Content-Length.

### A6 — P2: Locked dependencies have outstanding security advisories

Location: `bun.lock:783`, `1199`, `1549`, `1625`; `@subpolar-agent/package.json:85`.

`bun audit --json` reports four distinct advisories across four package names (Vitest and its mocker share one advisory):

| Locked package | Advisory | Conditions and remedy |
| --- | --- | --- |
| tinypool 1.1.1 | [GHSA-5gmw-xhrv-c9v3](https://github.com/advisories/GHSA-5gmw-xhrv-c9v3), [GHSA-85c8-ppgw-ccpr](https://github.com/advisories/GHSA-85c8-ppgw-ccpr) | Critical upstream severity; requires an additional prototype-pollution primitive. Worker option inheritance can turn it into code execution. Both fixed in 2.1.2. Resolve through a compatible Vitest upgrade; do not assume a major transitive override is compatible. |
| vitest / @vitest/mocker 3.2.7 | [GHSA-82fw-gwwq-j7x9](https://github.com/advisories/GHSA-82fw-gwwq-j7x9) | Moderate upstream severity; arbitrary file read via redirect mocks. Public mocker/interceptor plugins on exposed dev sockets are the unauthenticated path; ordinary Vitest browser RPC is token-authenticated. Fixed stable version 4.1.11. |
| katex 0.16.47 | [GHSA-238p-pmpm-9mq7](https://github.com/advisories/GHSA-238p-pmpm-9mq7) | Low upstream severity; requires preexisting prototype pollution and insertion of insufficiently sanitized renderer output. Fixed in 0.18.2. Check the Mermaid dependency chain. |

Verified current advisory details against the GitHub Advisory Database. These are dependency findings, not proof of a remotely exploitable application endpoint. No independent prototype-pollution primitive or enabled public mocker endpoint was established. Upgrade and rerun browser/UI/server tests before closing this finding.

## Executed validation

| Check | Result |
| --- | --- |
| `bun run test:core` | 129 passed, 444 assertions |
| Other packages + E2E contract (`subpolar-automations`, `subpolar-operations`, `subpolar-client`, `e2e/contract-smoke.test.ts`) | 18 passed, 67 assertions; packages without tests provide no additional assurance |
| `bun run test:server`, Bun portion | 134 passed, 1 failed, 731 assertions |
| `bun run test:server`, Vitest portion | 467 passed, 3 failed |
| `bun run test:ui` | 951 passed, 18 failed across 113 suites |
| `bun run test:voice` | 44 passed across 2 suites |
| `bun run build` | Passed; large bundle warnings (main chunk approximately 2.49 MB, 710 KB gzip) |
| `bun audit --json` | Fails on the dependency findings above |
| Browser implementation verification immediately before audit | Typechecks passed; 20 browser tests, 18 profile/tool tests and 10 focused UI tests passed; real live E2E passed 47 assertions twice |

Failure classification:

- UI: 17 `SessionWorkspaceChanges` assertions use the old sidebar launcher behavior; one SkillDialog assertion expects the old template. Those 18 failures were reproduced against starting frontend code before this audit.
- Vitest server: two Git service assertions and one task control-plane assertion compare macOS `/var` with canonical `/private/var`; reproduced against starting server code.
- Bun server: `multi-user-tool-execution.test.ts:118–120` still expects browser upload/download to be globally disabled. They now enter authorized browser execution, and the fixture has no owned agent, so it fails with `Agent not found`. This compatibility test needs to be rewritten for bounded transfers and permission enforcement. It is not classified as a preexisting failure.

## Additional deployment and assurance gaps

- Browser manual-control arbitration and automation conditional updates are process-local. Multi-process deployments need shared/database arbitration; current code documents this limitation.
- Browser profile disk/backup encryption, disk quotas and hostile-tenant isolation are operator responsibilities; no application-layer profile encryption.
- Docker daemon was stopped. Compose config was validated earlier, but image execution, Linux Chromium sandbox behavior and container firewall enforcement remain unverified.
- Development Compose runs application tooling, publishes PocketBase and uses a floating PocketBase image. It is not a validated production configuration.
- Many domain routes have `@ts-nocheck` and dependency bags typed as `any`; passing TypeScript checks does not establish route contract consistency.
- Main frontend bundle is large; inspect lazy loading before optimizing, rather than treating the build warning as a correctness failure.

Recommended order: fix A1–A3, add meaningful regression tests, repair the stale transfer test, address A4–A5, upgrade dependencies, then validate Docker and distributed deployment requirements. All findings remain open at the audited revision.
