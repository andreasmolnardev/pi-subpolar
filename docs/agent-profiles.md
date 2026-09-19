# Authoritative Agent Profiles

Agent records in PocketBase are the authority for runtime configuration. Older
records remain valid: missing model, thinking, approval, policy, and context
fields are normalized to compatibility defaults when read.

The built-in `General`, `Coding`, `Plan`, and `Reviewer` records are ordinary
owned profiles. They may be edited, disabled, or deleted subject to the normal
owner validation.

Tool authorization and context exposure are separate. Tool context modes are
`always`, `discoverable`, `on-demand`, and `disabled`; skill modes are
`always-loaded`, `discoverable`, `explicit-only`, and `disabled`. Discovery
never returns disabled or on-demand tools. Project overrides can only reduce a
profile's exposure. Calls are still checked by the central policy and approval
gateway, even when a tool is not discoverable.

The runtime projection, tool discovery, and tool authorization all consume the
same normalized effective configuration. Unresolved policy IDs are retained as
diagnostics and never grant a capability.
