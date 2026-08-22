#!/bin/sh
# Four extra seeds of the default field battle through the cross-engine arm.
set -u
cd "$(dirname "$0")/../.." || exit 1
export TC_VITE_CACHE_DIR="$PWD/.vite/xengine"
node tools/scratch/xe-seeds.mjs --seeds=11,22,33,44 --at=0,200,400 --port=5951 \
  > /tmp/xe-seeds.log 2>&1
echo "seeds exit=$?" >> /tmp/xe-seeds.log
echo ALLDONE >> /tmp/xe-seeds.log
