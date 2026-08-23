#!/bin/sh
# The played arm on both trees with the symmetric script, plus the after passive re-taken on
# the final tree so all three records come from code that shipped.
#
# `src/` is toggled with `git checkout <sha> -- src` and restored by a trap however this
# exits. Never `git stash`: it is repo-global on this machine and would reach into every
# other agent's checkout. `tools/` is deliberately not toggled — the instrument is the same
# in both arms and only the product changes, which is the whole design of the comparison.
#
#   sh tools/judge/run-played.sh <base-sha> <branch-sha> [port]
BASE="$1"
FIX="$2"
PORT="${3:-5991}"
cd "$(dirname "$0")/../.."
[ -n "$BASE" ] && [ -n "$FIX" ] || { echo "usage: run-played.sh <base-sha> <branch-sha> [port]"; exit 2; }
restore() { echo "--- restoring src/ to $FIX"; git checkout "$FIX" -- src; }
trap restore EXIT INT TERM

echo "=== src to $BASE — the played arm on the base tree ==="
git checkout "$BASE" -- src
node tools/judge/jg-arms.mjs --arm=played --tag=before --runs=12 --port="$PORT" || echo "(nonzero)"

echo "=== src to $FIX — both arms on the branch ==="
git checkout "$FIX" -- src
node tools/judge/jg-arms.mjs --arm=passive --tag=after --runs=12 --port="$PORT" || echo "(nonzero)"
node tools/judge/jg-arms.mjs --arm=played  --tag=after --runs=12 --port="$PORT" || echo "(nonzero)"

echo "######## played halves done ########"
