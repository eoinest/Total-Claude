#!/bin/sh
# One authoritative green on the exact committed tree: the whole gate, then the cross-engine arm
# on all three battles.
set -u
cd "$(dirname "$0")/../.." || exit 1
export TC_VITE_CACHE_DIR="$PWD/.vite/final"
: > /tmp/tc-final.log

npx tsc --noEmit >> /tmp/tc-final.log 2>&1; echo "tsc exit=$?" >> /tmp/tc-final.log
npm run lint >> /tmp/tc-final.log 2>&1; echo "lint exit=$?" >> /tmp/tc-final.log
node tools/qa-deploy.mjs >> /tmp/tc-final.log 2>&1; echo "deploy exit=$?" >> /tmp/tc-final.log
node tools/probe-seams.mjs >> /tmp/tc-final.log 2>&1; echo "seams exit=$?" >> /tmp/tc-final.log
node tools/qa-replay.mjs >> /tmp/tc-final.log 2>&1; echo "replay exit=$?" >> /tmp/tc-final.log
node tools/qa-determinism.mjs --port=5961 >> /tmp/tc-final.log 2>&1
echo "det-field exit=$?" >> /tmp/tc-final.log
node tools/qa-determinism.mjs --port=5961 --battle='map=campus-martius&scenario=assault' \
  >> /tmp/tc-final.log 2>&1
echo "det-rome exit=$?" >> /tmp/tc-final.log
node tools/qa-determinism.mjs --port=5961 --battle='map=carthage&scenario=assault' \
  >> /tmp/tc-final.log 2>&1
echo "det-carthage exit=$?" >> /tmp/tc-final.log

node tools/qa-xengine.mjs --port=5962 >> /tmp/tc-final.log 2>&1
echo "xe-field exit=$?" >> /tmp/tc-final.log
node tools/qa-xengine.mjs --port=5962 --battle='map=carthage&scenario=assault' \
  >> /tmp/tc-final.log 2>&1
echo "xe-carthage exit=$?" >> /tmp/tc-final.log
node tools/qa-xengine.mjs --port=5962 --battle='map=campus-martius&scenario=assault' \
  >> /tmp/tc-final.log 2>&1
echo "xe-rome exit=$?" >> /tmp/tc-final.log

echo ALLDONE >> /tmp/tc-final.log
