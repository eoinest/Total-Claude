#!/bin/sh
# What is left of the gate, on the final tree: the probe that was measuring a stale build,
# the probe whose one regression this branch has now fixed, and the wall-command instrument
# re-run to confirm the verb still works after that fix.
#
#   sh tools/judge/run-rest.sh [port]
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
run node tools/probe-siege.mjs --port="$PORT"
run node tools/judge/jg-wallcmd.mjs --port=$((PORT + 1)) --map=campus-martius --seed=4265438264 --skiporders

echo; echo "######## rest finished, fail=$fail ########"
exit $fail
