#!/bin/sh
# `probe-siege` on the base tree, so its seven red assertions can be adjudicated as
# measurements rather than argued about. The brief's own warning is the reason this exists:
# *"probe-siege has had assertions that were wrong about the world, so if one fails, say
# whether it or the build is wrong."* The only way to say is to run the same probe on the
# tree the branch starts from.
#
#   sh tools/judge/run-siege-base.sh <base-sha> <branch-sha> [port]
BASE="$1"
FIX="$2"
PORT="${3:-5985}"
cd "$(dirname "$0")/../.."
ROOT="$(pwd)"
[ -n "$BASE" ] && [ -n "$FIX" ] || { echo "usage: run-siege-base.sh <base-sha> <branch-sha> [port]"; exit 2; }
restore() { echo "--- restoring src/ to $FIX"; git checkout "$FIX" -- src; }
trap restore EXIT INT TERM

git checkout "$BASE" -- src
node tools/lib/vite-runner.mjs --port="$PORT" --root="$ROOT" --parent=$$ &
VITE=$!
i=0
while [ $i -lt 120 ]; do
  curl -sf "http://127.0.0.1:$PORT/src/main.ts" >/dev/null 2>&1 && break
  i=$((i + 1)); sleep 1
done
echo "dev server on $PORT after ${i}s — src at $BASE"
node tools/probe-siege.mjs --port="$PORT"
echo "######## probe-siege ON THE BASE TREE exit $? ########"
kill $VITE 2>/dev/null
