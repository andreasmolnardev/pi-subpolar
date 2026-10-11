FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS package
ARG OPENCODE_VERSION=2.0.26
WORKDIR /tmp/opencode
RUN --mount=type=cache,target=/root/.npm npm pack --ignore-scripts --pack-destination /tmp "@opencode/cli-linux-arm64@${OPENCODE_VERSION}" \
    && test "$(node -e 'const fs=require("node:fs"),crypto=require("node:crypto");process.stdout.write(crypto.createHash("sha512").update(fs.readFileSync(process.argv[1])).digest("base64"))' /tmp/opencode-cli-linux-arm64-${OPENCODE_VERSION}.tgz)" = "IG316I8wVqndohzFAoWNeH83eMA8sKQFRtMeuk2Wfg4DU1haCSgzAJz3/gbytjwh6bXdWR7V3FCSrfjoraKDgw==" \
    && mkdir /tmp/extracted \
    && tar -xzf "/tmp/opencode-cli-linux-arm64-${OPENCODE_VERSION}.tgz" -C /tmp/extracted --strip-components=2 package/bin/opencode \
    && test -x /tmp/extracted/opencode

FROM debian:bookworm-slim@sha256:7c7b2c966bc9ee8cedfeef67e0e279108992c77681fa595db4a9d65c06ccc587
ARG OPENCODE_VERSION=2.0.26
RUN mkdir -p /usr/lib/subpolar /var/lib/subpolar/opencode /runtime/config /runtime/data /runtime/cache /runtime/sessions \
    && chown -R 10001:10001 /runtime \
    && chmod 0755 /var/lib/subpolar/opencode
COPY --from=package /tmp/extracted/opencode /usr/lib/subpolar/opencode
COPY deployment/external-agent-runtime/entrypoint.sh /usr/local/bin/subpolar-opencode-entrypoint
RUN install -o root -g root -m 0555 /usr/lib/subpolar/opencode /var/lib/subpolar/opencode/opencode \
    && chmod 0555 /usr/lib/subpolar/opencode /usr/local/bin/subpolar-opencode-entrypoint
USER 10001:10001
ENV OPENCODE_VERSION=${OPENCODE_VERSION}
ENV HOME=/runtime XDG_CONFIG_HOME=/runtime/config XDG_DATA_HOME=/runtime/data XDG_CACHE_HOME=/runtime/cache
ENTRYPOINT ["/usr/local/bin/subpolar-opencode-entrypoint"]
CMD ["sleep", "infinity"]
