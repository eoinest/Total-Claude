#!/bin/sh
# Re-record all three battles' pins. Only ever run in the same commit as the change that moved
# them, and say why in the message — here, src/sim/quantise.ts.
set -u
cd "$(dirname "$0")/../.." || exit 1
export TC_VITE_CACHE_DIR="$PWD/.vite/qadet"
: > /tmp/tc-rerecord.log

node tools/qa-determinism.mjs --port=5952 --record >> /tmp/tc-rerecord.log 2>&1
echo "field exit=$?" >> /tmp/tc-rerecord.log
node tools/qa-determinism.mjs --port=5952 --record \
  --battle='map=campus-martius&scenario=assault' >> /tmp/tc-rerecord.log 2>&1
echo "rome exit=$?" >> /tmp/tc-rerecord.log
node tools/qa-determinism.mjs --port=5952 --record \
  --battle='map=carthage&scenario=assault' >> /tmp/tc-rerecord.log 2>&1
echo "carthage exit=$?" >> /tmp/tc-rerecord.log
echo ALLDONE >> /tmp/tc-rerecord.log
