#!/bin/sh
# Throwaway: the rest of the gate after the review fixes, one thing at a time.
cd "$(dirname "$0")/../.." || exit 1
say() { printf '\n=== %s ===\n' "$1"; uptime; }

say "1. qa-net (full)"
node tools/qa-net.mjs --json=/tmp/r-net.json > /tmp/r-net.log 2>&1
echo "net exit=$?"
grep -E '^  FAIL|checks passed' /tmp/r-net.log | tail -20

say "2. determinism, field"
node tools/qa-determinism.mjs --json=/tmp/r-det1.json > /tmp/r-det1.log 2>&1
echo "det1 exit=$?"
tail -3 /tmp/r-det1.log

say "3. determinism, campus-martius assault"
node tools/qa-determinism.mjs --battle='map=campus-martius&scenario=assault' --json=/tmp/r-det2.json > /tmp/r-det2.log 2>&1
echo "det2 exit=$?"
tail -3 /tmp/r-det2.log

say "4. determinism, carthage assault"
node tools/qa-determinism.mjs --battle='map=carthage&scenario=assault' --json=/tmp/r-det3.json > /tmp/r-det3.log 2>&1
echo "det3 exit=$?"
tail -3 /tmp/r-det3.log

say "5. inject-p2p --all-fast"
node tools/scratch/inject-p2p.mjs --all-fast > /tmp/r-inject.log 2>&1
echo "inject exit=$?"
tail -2 /tmp/r-inject.log

say "done"
