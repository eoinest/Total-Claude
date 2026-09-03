#!/bin/sh
cd "$(dirname "$0")/../.." || exit 1
say() { printf '\n=== %s ===\n' "$1"; uptime; }

say "1. qa-p2p (full, one process)"
node tools/qa-p2p.mjs --json=/tmp/t-p2p.json > /tmp/t-p2p.log 2>&1
echo "p2p exit=$?"
grep -E '^  FAIL|checks passed' /tmp/t-p2p.log | tail -12

say "2. qa-net (full)"
node tools/qa-net.mjs --json=/tmp/t-net.json > /tmp/t-net.log 2>&1
echo "net exit=$?"
grep -E '^  FAIL|checks passed' /tmp/t-net.log | tail -12

say "done"
