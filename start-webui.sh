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

trap cleanup EXIT INT TERM

if [[ ! -x "$root_dir/@webui/node_modules/.bin/vite" ]]; then
  npm --prefix "$root_dir/@webui" install
fi

bun "$root_dir/@webui/bridge.ts" &
bridge_pid=$!
npm --prefix "$root_dir/@webui" run dev &
frontend_pid=$!
wait "$frontend_pid"
