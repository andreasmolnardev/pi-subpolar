# Agent browser integration

The earlier proposal has been superseded by the implementation documented in [Subpolar Browser](browser-foundation.md).

The integration preserves `BrowserPort`, `BrowserSessionService`, existing browser IDs, `policies.browser`, the normal gateway's policy/approval semantics, PocketBase-owned session scopes and the existing right-hand sidebar. It adds a portable `@subpolar/browser` Playwright worker, owned persistent profile grants, live remote viewing/manual control and historical screenshot attachments.

The application is the authorization authority. The internal worker accepts only host-authorized structured calls and never runs a separate browser AI agent. Worker/CDP credentials and filesystem profile paths are not available to agents or viewer clients. Profiles, browser sessions, tabs, tool calls, viewer leases and screenshot artifacts remain separate identities.

The initial display transport is bounded authenticated image polling. Video/WebRTC, remote CDP providers, everyday Chrome profile import and application-level encrypted profile storage remain future extensions. Administrators must provide encrypted disk/backup storage and isolation appropriate to their trust model.

The authoritative implementation and verification tracker is root `TODO.md`. Completion of source code does not by itself certify the earlier proposal's entire security and E2E matrix. Refer to recorded commands, failures and limitations there before deployment.
