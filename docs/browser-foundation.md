# Browser Session Foundation

Phase 8 browser support is intentionally bounded to owned sessions and read/navigation capabilities.

- Browser sessions are stored in PocketBase as `browser_sessions`, scoped by owner and optional project, Pi session, and task. `GET /api/browser/sessions`, `POST /api/browser/sessions`, `GET /api/browser/sessions/:id`, and `POST /api/browser/sessions/:id/close` enforce those scopes.
- Browser actions use the normal tool gateway as `browser/open`, `browser/navigate`, `browser/back`, `browser/forward`, `browser/tabs`, `browser/read`, `browser/find`, `browser/screenshot`, and `browser/wait`.
- The default runtime is `BROWSER_UNAVAILABLE`. A host may inject a `BrowserPort`; `FakeBrowserPort` is a network-policy-bound test/runtime fake and is not live browser automation.
- Navigation uses the existing DNS-pinned network policy. Private DNS answers, unsafe redirects, timeouts, response/page limits, text limits, and tab limits fail closed.
- Browser action audit records contain action and metadata only. Page text, screenshot data, and other page content are not written to ordinary audit records.
- The registry reserves policy groups for `read`, `navigation`, `form-interaction`, `upload`, `download`, `submit`, and `destructive`. This phase registers only read/navigation actions; read-only profiles cannot execute future mutating groups and approval remains owned by the normal gateway.
