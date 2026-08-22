#!/bin/sh
# Scratch: start a vite for this worktree on a port nobody else holds.
#
# `node_modules` is not in the worktree — it is resolved by walking up to the shared checkout,
# which is why `npx vite` works here and a direct path does not. Spawned directly rather than
# through `npx`, because SIGTERM kills the npx wrapper and leaves vite holding the port; that
# is where nineteen orphaned servers came from.
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PORT="${1:-5937}"
export TC_NO_HMR=1
export TC_VITE_CACHE_DIR="$ROOT/.vite-cache/p$PORT"
exec node "$ROOT/../../../node_modules/vite/bin/vite.js" \
  --port "$PORT" --host 127.0.0.1 --strictPort
