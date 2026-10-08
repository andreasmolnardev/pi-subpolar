This is the repo to store all pi cusomizations in.

## Runtime and integration testing

- Always run Subpolar and its backend services through the project's Docker Compose configuration (`docker-compose.dev.yaml`). Do not launch PocketBase, the bridge, Vite, or `start-subpolar-agent.sh` directly on the host.
- Start the development stack with `docker compose -f docker-compose.dev.yaml up --build`; stop it with `docker compose -f docker-compose.dev.yaml down` when finished if you started it.
- Use `subpolar-test-cli` against the Docker-published API at `http://localhost:4173` for manual backend verification. Authenticate only with a normal user account/token; never use PocketBase superuser credentials or internal administrator tokens from the client.
- Keep tests and development data isolated and do not delete or reset existing Docker volumes or PocketBase data unless explicitly requested.
