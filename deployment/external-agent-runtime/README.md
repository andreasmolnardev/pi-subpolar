# OpenCode v2 runtime image

This opt-in Docker service installs OpenCode v2.0.26 from the official ARM64 Linux npm package. The build verifies the package SHA-512 integrity before extraction. On first start, Docker copies the root-owned binary into the named `opencode_installation` volume. The runtime user (UID 10001) cannot modify it. The volume survives container recreation; remove it only when uninstalling the runtime.

The service runs with no network, a read-only root filesystem, no Linux capabilities, no-new-privileges, a one GiB memory limit, two CPUs, and a 256 process limit. Runtime data is stored separately in the `opencode_runtime_data` volume. The container does not mount the Subpolar repository or project workspaces.

Enable the service with:

```sh
docker compose -f deployment/external-agent-runtime/compose.yaml --profile external-agent-runtime up -d --build opencode-v2
```

Run `deployment/external-agent-runtime/verify-docker.sh` to check the pinned version, non-root/read-only/network isolation, ACP initialize and session lifecycle, and binary persistence across container recreation. The ACP check does not send a model prompt.

This image is the isolated runtime installation and compatibility check. Subpolar's runtime manager, per-session workspace mounts, session-scoped MCP endpoint, approval/activity bridge, and controlled shell dispatch still need application integration before OpenCode can be selected for conversations or subagents.
