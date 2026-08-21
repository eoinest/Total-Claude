#!/bin/sh
# The whole gate on the final tree, in one run, with the headcounts visible.
set -e
cd "$(dirname "$0")/../.."
echo "=== tsc ==="
npx tsc --noEmit && echo "tsc clean"
echo "=== lint ==="
npm run lint 2>&1 | grep -E "^(PASS|FAIL)"
echo "=== qa-deploy ==="
node tools/qa-deploy.mjs --port=5944 2>&1 | tail -2
echo "=== probe-seams ==="
node tools/probe-seams.mjs --port=5945 2>&1 | tail -2
echo "=== determinism: field battle ==="
node tools/qa-determinism.mjs --port=5946 2>&1 | tail -2
echo "=== determinism: campus-martius assault ==="
node tools/qa-determinism.mjs --port=5946 "--battle=map=campus-martius&scenario=assault" 2>&1 | tail -2
echo "=== determinism: carthage assault ==="
node tools/qa-determinism.mjs --port=5946 "--battle=map=carthage&scenario=assault" 2>&1 | tail -2
echo "=== done ==="
