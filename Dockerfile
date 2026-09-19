FROM oven/bun:1

WORKDIR /app

# start-webui.sh uses curl while waiting for the bridge health endpoint.
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl nodejs npm \
  && rm -rf /var/lib/apt/lists/*

# Install dependencies in a separate layer so source-only edits do not trigger
# a full dependency reinstall when the image is rebuilt.
COPY @webui/package.json @webui/package-lock.json ./@webui/
RUN npm ci --prefix @webui

COPY . .

RUN chmod +x ./start-webui.sh

EXPOSE 5173 4173

CMD ["./start-webui.sh"]
