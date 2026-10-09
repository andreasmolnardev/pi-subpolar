# `@subpolar/automations`

Infrastructure-neutral automation definitions and orchestration contracts. The package owns validation, safe template rendering, restricted conditions, occurrence claiming semantics, execution lifecycle, and action lifecycle. A host composes persistence, scheduler/webhook/event delivery, and side-effect adapters.

Every definition requires an `agentId`. `AgentExecutionPort` is the only execution seam: a host adapter must resolve the owner-scoped agent and run it through the canonical Subpolar run path. The package never calls a model provider or imports Pi, Pi Durable, React, Hono, or PocketBase.

Trigger configuration is validated by `TriggerRegistry`; delivery and timezone-aware schedule calculation are injected by the host. Webhook triggers use a credential reference, not secret material. Webhook actions accept only HTTP(S) URLs at the domain boundary; the host must still apply outbound network/SSRF policy. Tool actions must go through the host's normal authorized tool gateway.

Templates support bounded `{{ dotted.path }}` substitutions. Conditions support only `exists`, `==`, `!=`, and `contains`; no expression evaluation or code execution is used. Unknown or unpersisted action outcomes fail closed and are not automatically replayed.
