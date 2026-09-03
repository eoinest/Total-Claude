#!/bin/sh
# The three determinism invocations, in one run, so a report can quote all three from one log.
# Sequential on purpose: they take a browser slot each and the machine has four.
set -u
cd "$(dirname "$0")/../.." || exit 1
echo "=== ARM 1: default (the Campus Martius field battle, 8,632) ==="
node tools/qa-determinism.mjs --port=5971 2>&1 | tail -24
echo ""
echo "=== ARM 2: map=campus-martius&scenario=assault (3,072) ==="
node tools/qa-determinism.mjs --port=5972 --battle='map=campus-martius&scenario=assault' 2>&1 | tail -24
echo ""
echo "=== ARM 3: map=carthage&scenario=assault (3,440) ==="
node tools/qa-determinism.mjs --port=5973 --battle='map=carthage&scenario=assault' 2>&1 | tail -24
