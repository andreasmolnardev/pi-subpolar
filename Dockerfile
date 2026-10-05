FROM node:22-bookworm-slim AS node-runtime
FROM oven/bun:1.3.14

# Vitest runs on supported Node via bun x --no-install; npm is not needed.
COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node

WORKDIR /app

# start-webui.sh uses curl while waiting for the bridge health endpoint.
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Install dependencies in a separate layer so source-only edits do not trigger
# a full dependency reinstall when the image is rebuilt.
COPY package.json bun.lock bunfig.toml ./
COPY @webui/package.json ./@webui/package.json
COPY packages/subpolar-cli/package.json ./packages/subpolar-cli/package.json
COPY packages/subpolar-contracts/package.json ./packages/subpolar-contracts/package.json
COPY packages/subpolar-core/package.json ./packages/subpolar-core/package.json
COPY packages/subpolar-core-pi/package.json ./packages/subpolar-core-pi/package.json
COPY packages/subpolar-operations/package.json ./packages/subpolar-operations/package.json
COPY packages/subpolar-persistance-local/package.json ./packages/subpolar-persistance-local/package.json
COPY packages/subpolar-persistance-pocketbase/package.json ./packages/subpolar-persistance-pocketbase/package.json
COPY packages/subpolar-tools/package.json ./packages/subpolar-tools/package.json
RUN bun install --frozen-lockfile

COPY . .

RUN chmod +x ./start-webui.sh

EXPOSE 5173 4173

CMD ["./start-webui.sh"]
