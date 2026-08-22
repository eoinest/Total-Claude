#!/bin/sh
# The three wall probes that need a server somebody else started.
#
# Split out of `run-gate.sh` after a lesson worth writing down: `sh` reads a script
# incrementally from a byte offset, so editing `run-gate.sh` *while it was running* shifted
# everything under the interpreter — it printed `e: command not found` and then jumped back
# to a stage it had already passed. A running shell script is not a file you may edit.
#
#   sh tools/judge/run-wallprobes.sh [port]
PORT="${1:-5961}"
cd "$(dirname "$0")/../.."
ROOT="$(pwd)"
fail=0
run() { echo; echo "######## $* ########"; "$@" || { echo "!!!! nonzero exit: $*"; fail=1; }; }

node tools/lib/vite-runner.mjs --port="$PORT" --root="$ROOT" --parent=$$ &
VITE=$!
trap 'kill $VITE 2>/dev/null' EXIT INT TERM
i=0
while [ $i -lt 120 ]; do
  curl -sf "http://127.0.0.1:$PORT/src/main.ts" >/dev/null 2>&1 && break
  i=$((i + 1)); sleep 1
done
echo "dev server on $PORT after ${i}s"

run node tools/qa-wallattack.mjs --port="$PORT" --map=carthage
run node tools/qa-siegecommand.mjs --port="$PORT"
run node tools/qa-wallmatrix.mjs --port="$PORT"

echo; echo "######## wall probes finished, fail=$fail ########"
exit $fail
