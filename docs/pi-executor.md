# Pi Executor Composition

`@subpolar/adapter-pi` is the package seam for connecting a host-provided Pi
runtime to the shared `createRunService`. It has no Pi dependency and accepts a
factory, configuration, and a small Pi-shaped executor interface.

The adapter maps `RunContext` explicitly to `principal`, `sessionId`,
`projectId`, `agentId`, `model`, `permission`, and `cwd`. A Pi executor receives
the request abort signal and can emit typed stream records. The core converts
those records into correlated `run.progress` events alongside `run.started` and
the terminal event. Approval and tool policy remain composition concerns and
must be delegated through the shared gateway rather than implemented in core.

`subpolar-cli` keeps the deterministic `local-fixture-echo` executor only when
no Pi option is supplied. Hosts can pass `pi.factory`, or `pi.module` as a
module specifier/export, plus `pi.config`. Module loading is lazy and happens
only for an explicitly configured run. Provider failures map to
`PI_PROVIDER_ERROR`; runtime failures map to `PI_RUNTIME_ERROR`, while core
maps cancellation to its existing non-recoverable or durable recovery result.

This is an in-process composition seam, not a promise that Pi is installed or
that runs are durable. The package tests use a deterministic fake Pi port and
do not require WebUI or PocketBase.
