#!/bin/sh
# Passive against played, on the base tree and then on this branch's tree.
#
# The two arms have to be measured on two trees and there is only one worktree, so `src/` is
# toggled between them with `git checkout <sha> -- src`. Never `git stash`: it is repo-global
# on this machine and would reach into every other agent's checkout.
#
# Serialised on purpose. Four twelve-seed runs is the exact shape that tempts parallelism and
# the shape that took this machine to load 160; `jg-arms` goes through the browser budget, so
# the cap holds even if this script is wrong, but the script is not going to be wrong.
#
#   sh tools/judge/run-arms.sh <base-sha> <fix-sha> [runs]
set -e
BASE="$1"
FIX="$2"
RUNS="${3:-12}"
PORT="${PORT:-5944}"
cd "$(dirname "$0")/../.."
[ -n "$BASE" ] && [ -n "$FIX" ] || { echo "usage: run-arms.sh <base-sha> <fix-sha> [runs]"; exit 2; }

restore() { echo "--- restoring src/ to $FIX"; git checkout "$FIX" -- src; }
trap restore EXIT INT TERM

echo "=== BEFORE: src at $BASE ==="
git checkout "$BASE" -- src
node tools/judge/jg-arms.mjs --arm=passive --tag=before --runs="$RUNS" --port="$PORT"
node tools/judge/jg-arms.mjs --arm=played  --tag=before --runs="$RUNS" --port="$PORT"

echo "=== AFTER: src at $FIX ==="
git checkout "$FIX" -- src
node tools/judge/jg-arms.mjs --arm=passive --tag=after --runs="$RUNS" --port="$PORT"
node tools/judge/jg-arms.mjs --arm=played  --tag=after --runs="$RUNS" --port="$PORT"

echo "=== comparison ==="
node tools/judge/jg-armcmp.mjs \
  screenshots/judge/arms/campus-martius-passive-before.json \
  screenshots/judge/arms/campus-martius-played-before.json \
  screenshots/judge/arms/campus-martius-passive-after.json \
  screenshots/judge/arms/campus-martius-played-after.json
