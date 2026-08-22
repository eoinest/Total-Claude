#!/bin/sh
# The BEFORE half of every comparison on this branch, on the tree the branch starts from.
#
# There is one worktree, so `src/` is toggled with `git checkout <sha> -- src`. Never
# `git stash`: it is repo-global on this machine and would reach into every other agent's
# checkout. The trap restores the branch's own `src/` however this exits, including on a
# machine that falls over — which is the failure this repository has already paid for once.
#
# `tools/` is deliberately NOT reverted. The instruments are the same in both arms; only the
# product changes. That is the whole design of the comparison, and `jg-arms` records the
# `src/` hash on every run so the two halves can be proved to be two trees.
#
#   sh tools/judge/run-before.sh <base-sha> <branch-sha> [port]
set -e
BASE="$1"
FIX="$2"
PORT="${3:-5981}"
cd "$(dirname "$0")/../.."
ROOT="$(pwd)"
[ -n "$BASE" ] && [ -n "$FIX" ] || { echo "usage: run-before.sh <base-sha> <branch-sha> [port]"; exit 2; }

restore() { echo "--- restoring src/ to $FIX"; git checkout "$FIX" -- src; }
trap restore EXIT INT TERM

echo "=== src to $BASE ==="
git checkout "$BASE" -- src

node tools/lib/vite-runner.mjs --port="$PORT" --root="$ROOT" --parent=$$ &
VITE=$!
i=0
while [ $i -lt 120 ]; do
  curl -sf "http://127.0.0.1:$PORT/src/main.ts" >/dev/null 2>&1 && break
  i=$((i + 1)); sleep 1
done
echo "dev server on $PORT after ${i}s"

# The two probes that went red on the branch, run here so the adjudication is a measurement
# rather than an argument: were they already red before any of this?
echo; echo "######## qa-wallattack ON THE BASE TREE ########"
node tools/qa-wallattack.mjs --port="$PORT" --map=carthage || echo "(nonzero)"
echo; echo "######## qa-wallmatrix ON THE BASE TREE ########"
node tools/qa-wallmatrix.mjs --port="$PORT" || echo "(nonzero)"

kill $VITE 2>/dev/null || true

echo; echo "######## arms, base tree ########"
node tools/judge/jg-arms.mjs --arm=passive --tag=before --runs=12 --port=$((PORT + 1)) || echo "(nonzero)"
node tools/judge/jg-arms.mjs --arm=played  --tag=before --runs=12 --port=$((PORT + 1)) || echo "(nonzero)"

echo; echo "######## before half done ########"
