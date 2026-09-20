# Automation, Inbox, and Notifications

The bridge owns durable `automations` and `automation_runs` records. Automation input is validated before persistence, and all reads and mutations use the authenticated PocketBase owner. A trigger key is unique per owner and automation, providing idempotent manual and scheduler triggers. `executeAutomation` is the executor seam: callers inject the existing Pi/Subpolar run callback; this module does not create another agent runtime.

Runs carry attempts, durable compare-and-set leases, explicit retry states, cancellation, and restart-safe `unknown` state. Lease renewal, expiry, and cancellation all match owner/state/lease identity. A worker should call `markInterruptedRuns` during startup before polling pending work. Concurrency policy is enforced at trigger time and at lease acquisition. Missing durable conditional-update support fails execution rather than falling back to a process-local lock.

`inbox_items` is the source of truth for approvals, questions, task transitions, automation results, and browser approvals. Its `(owner_id, kind, reference_id)` unique index deduplicates updates. Notification subscriptions and delivery rows are projections only; adapter failures create a failed delivery row and never remove the inbox item.

`triggerDue(ownerId)` is the scheduler trigger seam: it finds active due definitions and creates idempotent schedule runs. It is intentionally not a daemon or polling loop. Cron is five-field, range-checked, and next-run calculation is bounded to a one-year horizon.

Routes are owner-scoped under `/api/automations`, `/api/inbox`, and `/api/notifications`. Client payloads never supply the owner identity.
