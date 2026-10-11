#!/bin/sh
set -eu

compose='docker compose -f deployment/external-agent-runtime/compose.yaml --profile external-agent-runtime'
$compose build opencode-v2
$compose up -d opencode-v2
$compose exec -T opencode-v2 /var/lib/subpolar/opencode/opencode --version | grep -Fx 'opencode v2.0.26'
$compose exec -T opencode-v2 sh -c 'test "$(id -u)" = 10001 && test ! -w /var/lib/subpolar/opencode/opencode && test ! -e /dev-workspace'
container=$($compose ps -q opencode-v2)
test "$(docker inspect -f '{{.HostConfig.NetworkMode}}' "$container")" = none
test "$(docker inspect -f '{{.HostConfig.ReadonlyRootfs}}' "$container")" = true
before=$($compose exec -T opencode-v2 sha256sum /var/lib/subpolar/opencode/opencode | cut -d ' ' -f 1)
bun deployment/external-agent-runtime/verify-docker-acp.mjs
$compose up -d --force-recreate opencode-v2
after=$($compose exec -T opencode-v2 sha256sum /var/lib/subpolar/opencode/opencode | cut -d ' ' -f 1)
test "$before" = "$after"
$compose exec -T opencode-v2 /var/lib/subpolar/opencode/opencode --version | grep -Fx 'opencode v2.0.26'
bun deployment/external-agent-runtime/verify-docker-acp.mjs
