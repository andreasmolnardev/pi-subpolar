# Subpolar Browser

Subpolar operates server-hosted Chromium through the existing BrowserSessionService and tool gateway. `@subpolar/browser` is a portable Playwright package with an authenticated worker boundary; it has no PocketBase or WebUI dependency. The application owns authentication, agent policy, profiles, screenshot history and viewer control. The network fetch fake remains available for tests.

## Run locally

```sh
bun install
bunx --no-install playwright install chromium
# Set the same dedicated random secret (32+ characters) in both processes.
SUBPOLAR_BROWSER_WORKER_TOKEN=your-random-secret-at-least-32-characters \
SUBPOLAR_BROWSER_PROFILE_ROOT=/protected/subpolar-profiles \
bun packages/subpolar-browser/src/worker.ts
```

Configure the bridge with `SUBPOLAR_BROWSER_WORKER_URL=http://127.0.0.1:3101` and the same `SUBPOLAR_BROWSER_WORKER_TOKEN`. The worker binds loopback by default. With no worker configured, browser calls return `BROWSER_UNAVAILABLE`; the rest of the application stays usable. Chromium installation and Linux system dependencies are required; use `playwright install --with-deps chromium` on Linux.

The worker never accepts an agent-supplied endpoint, CDP URL or profile directory. Stop the worker with SIGTERM for graceful profile flushing. Explicit browser close releases runtime resources; disconnecting a viewer keeps the session alive until close or idle cleanup.

## Profiles and agent permission

Settings → Browser Profiles manages owned persistent Chromium profiles. Create, rename, clear state, delete, or open a profile to log into a website. Active profiles cannot be cleared or deleted. Chromium data lives in the worker's protected filesystem, not PocketBase JSON. Back up that volume only after closing browsers. Treat backups as credentials and encrypt the disk/backup with administrator-managed keys. Application-layer encryption is not implemented.

Agent Settings → Tools → Browser keeps `policies.browser` as the capability switch and configures `browser.allowedProfileIds`, `browser.defaultProfileId`, and `browser.allowEphemeral`. Enabling the capability grants no persistent profiles by itself. Profile ownership and grants are checked for every agent action, including sessions created manually. Revocation blocks subsequent agent operations. Project policy can further restrict browser access; it cannot elevate denied capabilities.

Only one browser session may write a persistent profile at a time. A grant never attaches an agent to another execution's browser. Profile persistence retains supported cookies and website storage; it does not guarantee recovery of open tabs, in-flight actions or authentication that a website has expired.

## Live Browser

Use the existing workspace sidebar's plus menu → Live Browser. The old repository Browser view is now Code Browser. Opening the sidebar does not launch Chromium. Choose an existing session or create a browser window with an ephemeral or saved profile. Settings can open a profile independently of an agent session for login.

The viewer receives authenticated image frames on demand, with at most one frontend request outstanding. Frames are remote screenshots, not a destination iframe. Agent execution requires no viewer. Take control creates an exclusive expiring lease; agent actions fail with a recoverable manual-control state until return or lease expiry. Manual input does not enter agent tool history. Disconnect releases control, with expiry providing recovery for abrupt client loss. Polling is the initial remote display transport and has lower frame rate than video/WebRTC.

## Tools and history

Existing browser IDs remain compatible. Navigation, accessibility snapshots, semantic interactions and tab management use the ordinary registry, discovery, authorization and approval pipeline. Agent-created sessions use the authorized default profile or permitted ephemeral state. Form and consequential operations preserve existing approval policy; read-only agent templates cannot mutate.

Browser actions attempt screenshot capture independent of the viewer. PocketBase stores images in a protected file field linked to owner, browser session, Pi session and tool call. Artifacts expire after 30 days; access rejects expired records and bounded cleanup removes up to 50 expired records per collection during capture/profile listing. Historical tool output includes a screenshot artifact descriptor; the chat timeline lazily loads its authenticated file endpoint. Failed capture produces unavailable status without fabricating an image. Manual input avoids screenshot history to protect login entry. Live viewing necessarily displays the page to its authenticated owner.

## Security and deployment

`deployment/browser/Dockerfile` creates a separate non-root worker with installed Chromium. Compose gives it only the profile volume, resource limits, a Chromium-compatible seccomp profile, and no published port. The application connects over the private Compose network. The worker token is a privileged internal secret, never sent to the browser client. The worker container does not mount the application source, operator home, SSH credentials or Docker socket.

Chromium retains its sandbox. A DNS-pinned egress proxy validates every destination connection and blocks private/local/metadata targets by default, including redirected and subresource traffic. `SUBPOLAR_BROWSER_ALLOWED_PRIVATE_HOSTS` is an exact administrator-only exception list, intended for controlled internal services and test fixtures. Keep it empty for normal deployments. Chromium disables direct non-proxied WebRTC UDP and QUIC. Container/host firewall rules should reinforce egress isolation for untrusted deployments.

Run one bridge admission process for a browser worker: controller leases currently live in that process. Horizontal bridge replicas require a shared controller arbiter before deployment. Use one worker/storage isolation boundary per trust domain for hostile multi-tenant deployments; a browser context or shared worker filesystem is not a complete hostile-tenant boundary. Browser profile data is credential-bearing. Never mount an everyday Chrome profile.

Docker configuration follows [Playwright's non-root sandbox and seccomp guidance](https://playwright.dev/docs/docker). Docker runtime verification requires a running daemon; see TODO.md for executed tests and limitations.

## Verification and troubleshooting

```sh
bun test packages/subpolar-browser
bun run typecheck
E2E_BROWSER_LIVE=true bun test e2e/browser-live.test.ts --timeout 240000
```

The opt-in live test uses disposable PocketBase, bridge, Vite, worker and a controlled login website. It requires the local PocketBase binary and installed Chromium. It fails when required services are unavailable. No personal website accounts or profiles are used. Unit tests alone do not establish end-to-end success; consult TODO.md for actual results.

For unavailable browser, check worker URL/token, Chromium installation and sandbox support. For busy profile, close the owning session before clearing/reusing it; do not remove a live lease manually. For denied tools, inspect `policies.browser`, effective project restrictions, tool context mode, profile allowlist and approval policy. For missing screenshots, check PocketBase file storage, worker capture status and retention. Do not debug by logging cookies, authorization headers, profile contents, page form input or screenshot bytes.
