#!/bin/sh
# Were the pins green BEFORE this branch touched anything?
#
# A drift is only evidence about my change if the pin was green without it. `docs/HANDOFF.md`
# says the gate was green at f694ad6 and this worktree is one docs commit later — but four
# commits touched `src/` after the last pin was recorded, including a three-branch merge, so
# "green" is a claim to check rather than inherit. Re-recording someone else's movement is the
# thing the standing rules forbid by name.
set -u
cd "$(dirname "$0")/../.." || exit 1
git diff --quiet -- src || {
  echo "REFUSING: src/ is modified. Run: python3 tools/scratch/src-toggle.py head"
  exit 2
}
git diff --quiet -- tools/determinism-baseline.json || {
  echo "REFUSING: the baseline is modified. Run: git checkout tools/determinism-baseline.json"
  exit 2
}
export TC_VITE_CACHE_DIR="$PWD/.vite/phase0"
: > /tmp/tc-phase0.log

node tools/qa-determinism.mjs --port=5955 --soft-units >> /tmp/tc-phase0.log 2>&1
echo "field exit=$?" >> /tmp/tc-phase0.log
node tools/qa-determinism.mjs --port=5955 --soft-units \
  --battle='map=campus-martius&scenario=assault' >> /tmp/tc-phase0.log 2>&1
echo "rome exit=$?" >> /tmp/tc-phase0.log
node tools/qa-determinism.mjs --port=5955 --soft-units \
  --battle='map=carthage&scenario=assault' >> /tmp/tc-phase0.log 2>&1
echo "carthage exit=$?" >> /tmp/tc-phase0.log
echo ALLDONE >> /tmp/tc-phase0.log
