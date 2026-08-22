#!/bin/sh
# The remaining gates, on ports this agent owns, against this worktree's own src.
#
# `qa-determinism` reuses any listener on its port without asking what it is serving, so the
# port is checked before the run and the server it leaves behind is killed after. It also passes
# TC_VITE_CACHE_DIR through from the environment rather than setting it, so it is set here:
# node_modules is a symlink to the shared checkout and vite's default cache would be shared.
set -e
W=/Users/ernestmccarter/Documents/dev/Total-Claude/.claude/worktrees/agent-ad82a43c18e618daf
export TC_VITE_CACHE_DIR=$W/.vite-fv

for p in 5961 5962; do
  if lsof -nP -iTCP:$p -sTCP:LISTEN -t >/dev/null 2>&1; then
    echo "REFUSING: port $p already has a listener — it is not mine to measure through."
    exit 1
  fi
done

echo "=== probe-seams (both maps) ==="
node "$W/tools/probe-seams.mjs" --port=5962 --maps=campus-martius,carthage 2>&1 | tail -20

echo "=== qa-determinism: default (field battle, tell 8,632) ==="
node "$W/tools/qa-determinism.mjs" --port=5961 2>&1 | tail -14

echo "=== qa-determinism: campus-martius assault (tell 3,072) ==="
node "$W/tools/qa-determinism.mjs" --port=5961 --battle="map=campus-martius&scenario=assault" 2>&1 | tail -14

echo "=== qa-determinism: carthage assault (tell 3,440) ==="
node "$W/tools/qa-determinism.mjs" --port=5961 --battle="map=carthage&scenario=assault" 2>&1 | tail -14

echo "=== cleaning up the servers I started ==="
for p in 5961 5962; do
  pid=$(lsof -nP -iTCP:$p -sTCP:LISTEN -t 2>/dev/null | head -1)
  [ -n "$pid" ] && kill -TERM "$pid" 2>/dev/null && echo "killed $pid on $p" || echo "$p already free"
done
