# Disposable Phase 16 E2E Harness

This directory contains bounded test-infrastructure scaffolding. The contract smoke suite uses an in-process fake and does **not** prove that PocketBase, the bridge, or the browser UI work together live.

## Dependency-free checks

Prerequisites: Bun 1.x. No installed project dependencies, PocketBase binary, Docker, network, or developer data are needed.

```sh
bun test e2e/contract-smoke.test.ts
bun --check e2e/harness.ts
bun --check e2e/fake-contract.ts
```

The root alias `npm run test:e2e:contract` runs the same fake-only suite.

## Live disposable run

Prerequisites:

- Bun 1.x
- PocketBase binary on `PATH` (or `E2E_POCKETBASE_BIN`)
- installed root/WebUI dependencies, including `@webui/node_modules`
- a working bridge and Vite runtime in the current checkout

Run from the repository root:

```sh
bun e2e/harness.ts
```

The runner starts PocketBase, the Bun bridge, and Vite on dedicated test ports (`48090`, `4173`, and `48174` by default), waits for each health/readiness endpoint, and exits non-zero on startup failure. The bridge default remains `4173` because the checked-in Vite proxy targets that port. Override ports with `E2E_POCKETBASE_PORT`, `E2E_BRIDGE_PORT`, and `E2E_WEBUI_PORT`. Override complete commands with `E2E_POCKETBASE_COMMAND`, `E2E_BRIDGE_COMMAND`, and `E2E_WEBUI_COMMAND`; commands are whitespace-split and do not run through a shell.

All data is created below a fresh system temporary directory: PocketBase data, Pi session data, project root, and per-process logs. Credentials are deterministic test-only values. Repository `pocketbase/pb_data`, `.env`, home directories, and production credentials are not read or written. Processes are terminated and temporary data is removed on exit. Use `--keep` or `E2E_KEEP_ARTIFACTS=true` to retain the temporary directory; failed runs retain it automatically and print its exact path.

The default PocketBase path bootstraps the deterministic superuser in the fresh data directory before serving. A custom `E2E_POCKETBASE_COMMAND` is treated as a complete long-running command and must perform any required bootstrap itself. The live path is intentionally not included in the default dependency-free test command, and no live E2E result should be inferred from the fake suite.

## Scope and limitations

The fake suite checks health, capabilities, authentication setup, project/session creation, tool discovery, denied/approval/allowed calls, call-id idempotency, and audit outcomes. It does not validate PocketBase schema migrations, browser rendering, Vite proxying, Pi execution, real approval timing, or network/security behavior. Live service verification remains dependent on the external prerequisites above.
