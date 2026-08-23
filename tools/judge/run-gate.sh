#!/bin/sh
# The gate this branch is held to, in one serialised pass.
#
# Four of the probes start their own dev server through `startVite` and four do not, so this
# starts one for the second group with `tools/lib/vite-runner.mjs` — which dies with its
# parent within two seconds, so a killed gate does not leave a server on the port. Never
# `npx vite`: the handle that gives you is the npx wrapper, not Vite, and SIGTERM to it
# leaves the port held. Nineteen servers were swept off this machine in one morning that way.
#
#   sh tools/judge/run-gate.sh [port]
PORT="${1:-5951}"
cd "$(dirname "$0")/../.."
ROOT="$(pwd)"
fail=0
run() { echo; echo "######## $* ########"; "$@" || { echo "!!!! nonzero exit: $*"; fail=1; }; }

echo "######## tsc ########"; npx tsc --noEmit || fail=1
echo "######## lint ########"; npm run lint || fail=1

node tools/lib/vite-runner.mjs --port="$PORT" --root="$ROOT" --parent=$$ &
VITE=$!
trap 'kill $VITE 2>/dev/null' EXIT INT TERM
# The runner prints TC_VITE_READY when it is listening; give it a bounded wait either way.
i=0
while [ $i -lt 120 ]; do
  curl -sf "http://127.0.0.1:$PORT/src/main.ts" >/dev/null 2>&1 && break
  i=$((i + 1)); sleep 1
done
echo "dev server on $PORT after ${i}s"

run node tools/probe-seams.mjs --port=$((PORT + 1)) --maps=campus-martius,carthage
run node tools/qa-deploy.mjs --port=$((PORT + 2))
run node tools/qa-replay.mjs --port=$((PORT + 3))
# `probe-siege` **reuses** a server on its `--port` and falls through to serving `dist/`
# when none answers — its own header says a stale pass is worse than a failure, and that
# is exactly what a fresh port bought it here: "no dev server; serving dist/ (which may be
# stale)". It goes at the one server this script actually started.
run node tools/probe-siege.mjs --port="$PORT"
run node tools/qa-wallorder.mjs --port="$PORT"
run node tools/qa-wallattack.mjs --port="$PORT" --map=carthage
run node tools/qa-siegecommand.mjs --port="$PORT"
run node tools/qa-wallmatrix.mjs --port="$PORT"

echo; echo "######## gate finished, fail=$fail ########"
exit $fail
