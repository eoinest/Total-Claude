#!/bin/sh
# `probe-siege` with a server of its own.
#
# It reuses a listener on its `--port` and otherwise serves `dist/`, which is a build from
# whenever `vite build` last ran — its own header calls that "a stale pass is worse than a
# failure" and it is right. So it gets a server rather than a bare port number.
#
#   sh tools/judge/run-siege.sh [port]
PORT="${1:-5971}"
cd "$(dirname "$0")/../.."
ROOT="$(pwd)"
node tools/lib/vite-runner.mjs --port="$PORT" --root="$ROOT" --parent=$$ &
VITE=$!
trap 'kill $VITE 2>/dev/null' EXIT INT TERM
i=0
while [ $i -lt 120 ]; do
  curl -sf "http://127.0.0.1:$PORT/src/main.ts" >/dev/null 2>&1 && break
  i=$((i + 1)); sleep 1
done
echo "dev server on $PORT after ${i}s"
node tools/probe-siege.mjs --port="$PORT"
echo "######## probe-siege exit $? ########"
