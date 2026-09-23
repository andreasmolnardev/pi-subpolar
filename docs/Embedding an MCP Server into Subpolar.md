# Embedding an MCP Server into Subpolar

This page is about where an MCP server process runs and how Subpolar reaches it. MCP tool authorization and invocation within the Subpolar tool runtime are covered in [Tools](Tools.md).

## Current support

Subpolar's MCP adapter supports two deployment shapes:

- **Subpolar-launched process (stdio):** Subpolar starts a configured executable as a child process and communicates with it over stdin/stdout. This is process-level integration, not loading the server into Subpolar's own runtime. Subpolar can keep the client session open and reuse it for calls.
- **Separately running service (HTTP/SSE):** Subpolar connects to an MCP endpoint over the network. A service running in another process or container can be used this way if its endpoint is reachable from the bridge and passes the configured network policy.

The generic stdio transport can launch a process, but Subpolar does not currently provide a first-class MCP container manager. There is no managed image selection/build, container lifecycle, volume or socket-mount configuration, or UI choice between a host process and a Docker container. While an administrator could arrange a process command that starts another program, that is not equivalent to Subpolar safely managing a container deployment.

## Deployment goal

The intended configuration should let an operator choose the server's placement:

1. **Run with Subpolar:** start the MCP server as a managed child process and use stdio. This is suited to a server installed in the bridge's runtime environment.
2. **Run in a separate Docker container:** start or connect to an isolated container when the server needs its own dependencies, environment, or lifecycle. Subpolar must have an explicit, secure way to communicate with it and, when required, grant access to a socket.

These are desired deployment options, not a claim that the complete container workflow is implemented. The current remote HTTP/SSE transport can communicate with a separately managed container that exposes an MCP endpoint; container creation and management remain external to Subpolar.

## Socket access and isolation

Socket access is a deployment/security boundary, not just another MCP transport setting. If a containerized server needs a host socket (for example, to communicate with a host service), the design must decide which socket is exposed, to which container, with what read/write permissions, and how the configuration is authorized and audited. Mounting a host socket can grant substantial host-level authority; it should not be enabled implicitly or inferred from a tool call.

A future managed-container option should make socket access explicit and narrowly scoped. It will also need to define how credentials, environment variables, working directories, resource limits, startup failures, shutdown, and container cleanup are handled. Until those controls exist, use a separately managed service with an explicitly reachable MCP endpoint, or a trusted stdio executable in the bridge's configured environment.

## Choosing a current deployment

- Use **stdio** when Subpolar's runtime host has the server executable and its dependencies, and the process can run with the permissions available to the bridge.
- Use **HTTP/SSE** when the server is already deployed as a service, including in a separately managed container, and the bridge can reach its MCP endpoint.
- Do not treat a Docker command configured as a generic stdio executable as a supported or isolated deployment mode. It does not provide Subpolar-managed container lifecycle or a controlled socket-mount policy.
