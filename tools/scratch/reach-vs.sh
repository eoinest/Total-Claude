#!/bin/zsh
# Is condition A reachable, or merely unreached?
#
# The shipped garrison is eight wall units — 810 men — and across twelve seeded runs the
# storm never cleared a single bay of them, so a campaign on the shipped order of battle
# cannot tell "the rule is still impossible" from "this assault is not good enough". The
# menu lets a player compose the garrison, so this walks it down and reports the point at
# which the escalade does take a stretch of wall and hold it. Same seed, same storm, same
# map: the only thing that moves is how many men are standing on the parapet.
set -e
cd "$(dirname "$0")/../.."
PORT=${PORT:-5484}
for spec in \
  '8 wall units (shipped)|{"ballistarii":5,"wall-slingers":3,"carroballista":2,"legio-cohort":2}' \
  '6 wall units|{"ballistarii":4,"wall-slingers":2,"carroballista":2,"legio-cohort":2}' \
  '4 wall units|{"ballistarii":3,"wall-slingers":1,"carroballista":2,"legio-cohort":2}' \
  '3 wall units|{"ballistarii":2,"wall-slingers":1,"carroballista":2,"legio-cohort":2}' \
  '2 wall units|{"ballistarii":1,"wall-slingers":1,"carroballista":2,"legio-cohort":2}' \
  '1 wall unit|{"ballistarii":1,"carroballista":2,"legio-cohort":2}' \
; do
  label="${spec%%|*}"; rome="${spec#*|}"
  print -n "  $label"
  node tools/scratch/campaign-vs.mjs --port=$PORT --runs=1 --label="$label" \
    --rome="$rome" --json="/tmp/vs-reach-${label// /_}.json" 2>&1 | grep -E '^  ' || true
done
