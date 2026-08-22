#!/bin/sh
# The definitive cross-engine sweep: three battles, seven checkpoints, firewall at birth and
# at the end of every tick.
set -u
cd "$(dirname "$0")/../.." || exit 1
export TC_VITE_CACHE_DIR="$PWD/.vite/xengine"
: > /tmp/xe-final.log

node tools/qa-xengine.mjs --port=5949 --json=/tmp/xe-field-final.json > /tmp/xe-field-final.log 2>&1
echo "field exit=$?" >> /tmp/xe-final.log

node tools/qa-xengine.mjs --port=5949 --battle='map=carthage&scenario=assault' \
  --json=/tmp/xe-carth-final.json > /tmp/xe-carth-final.log 2>&1
echo "carthage exit=$?" >> /tmp/xe-final.log

node tools/qa-xengine.mjs --port=5949 --battle='map=campus-martius&scenario=assault' \
  --json=/tmp/xe-rome-final.json > /tmp/xe-rome-final.log 2>&1
echo "rome exit=$?" >> /tmp/xe-final.log

echo ALLDONE >> /tmp/xe-final.log
