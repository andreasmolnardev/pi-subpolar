#!/bin/sh
set -eu

binary=/var/lib/subpolar/opencode/opencode
version=$("$binary" --version)
if [ "$version" != "opencode v${OPENCODE_VERSION}" ]; then
  echo "Persistent OpenCode binary version mismatch" >&2
  exit 1
fi
exec "$@"
