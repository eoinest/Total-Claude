#!/bin/sh
# Throwaway: the gate as the brief asks for it, in one sequential chain so the machine
# never carries two browser gates at once. Do not edit while it is running.
cd "$(dirname "$0")/../.." || exit 1

say() { printf '\n=== %s ===\n' "$1"; uptime; }

say "1. qa-p2p (full)"
node tools/qa-p2p.mjs --json=/tmp/g-p2p.json > /tmp/g-p2p.log 2>&1
echo "p2p exit=$?"
grep -E '^  FAIL|checks passed' /tmp/g-p2p.log | tail -20

say "2. qa-net (full, run 1)"
node tools/qa-net.mjs --json=/tmp/g-net1.json > /tmp/g-net1.log 2>&1
echo "net1 exit=$?"
grep -E '^  FAIL|checks passed' /tmp/g-net1.log | tail -20

say "3. determinism, field"
node tools/qa-determinism.mjs --json=/tmp/g-det1.json > /tmp/g-det1.log 2>&1
echo "det1 exit=$?"
tail -6 /tmp/g-det1.log

say "4. determinism, campus-martius assault"
node tools/qa-determinism.mjs --battle='map=campus-martius&scenario=assault' --json=/tmp/g-det2.json > /tmp/g-det2.log 2>&1
echo "det2 exit=$?"
tail -6 /tmp/g-det2.log

say "5. determinism, carthage assault"
node tools/qa-determinism.mjs --battle='map=carthage&scenario=assault' --json=/tmp/g-det3.json > /tmp/g-det3.log 2>&1
echo "det3 exit=$?"
tail -6 /tmp/g-det3.log

say "6. qa-net (full, run 2 -- the same-battle distribution)"
node tools/qa-net.mjs --json=/tmp/g-net2.json > /tmp/g-net2.log 2>&1
echo "net2 exit=$?"
grep -E '^  FAIL|checks passed' /tmp/g-net2.log | tail -20

say "done"
