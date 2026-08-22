#!/bin/sh
set -u
cd "$(dirname "$0")/../.." || exit 1
export TC_VITE_CACHE_DIR="$PWD/.vite/gate3"
: > /tmp/xe-rome4.log
node tools/qa-xengine.mjs --port=5935 --battle='map=campus-martius&scenario=assault' \
  >> /tmp/xe-rome4.log 2>&1
echo "xe-rome exit=$?" >> /tmp/xe-rome4.log
node tools/qa-determinism.mjs --port=5936 >> /tmp/xe-rome4.log 2>&1
echo "det-field exit=$?" >> /tmp/xe-rome4.log
echo ALLDONE >> /tmp/xe-rome4.log
