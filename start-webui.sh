#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bridge_pid=""
frontend_pid=""

cleanup() {
  if [[ -n "$frontend_pid" ]] && kill -0 "$frontend_pid" 2>/dev/null; then
    kill "$frontend_pid" 2>/dev/null || true
    wait "$frontend_pid" 2>/dev/null || true
  fi
  if [[ -n "$bridge_pid" ]] && kill -0 "$bridge_pid" 2>/dev/null; then
    kill "$bridge_pid" 2>/dev/null || true
    wait "$bridge_pid" 2>/dev/null || true
  fi
}

trap cleanup EXIT
trap 'cleanup; exit 130' INT TERM

if [[ ! -x "$root_dir/@webui/node_modules/.bin/vite" ]]; then
  npm --prefix "$root_dir/@webui" install
fi

bun "$root_dir/@webui/bridge.ts" &
bridge_pid=$!

# Do not start Vite until the API is listening. Otherwise the browser immediately
# generates a burst of misleading ECONNREFUSED proxy errors during startup.
bridge_ready=false
for attempt in {1..50}; do
  if ! kill -0 "$bridge_pid" 2>/dev/null; then
    wait "$bridge_pid" || true
    echo "Subpolar bridge exited before becoming ready" >&2
    exit 1
  fi
  if curl --silent --fail --max-time 1 http://127.0.0.1:"${WEBUI_PORT:-4173}"/api/health >/dev/null 2>&1; then
    bridge_ready=true
    break
  fi
  sleep 0.2
done
if [[ "$bridge_ready" != true ]]; then
  echo "Timed out waiting for the Subpolar bridge on port ${WEBUI_PORT:-4173}" >&2
  exit 1
fi

npm --prefix "$root_dir/@webui" run dev &
frontend_pid=$!
wait "$frontend_pid"
