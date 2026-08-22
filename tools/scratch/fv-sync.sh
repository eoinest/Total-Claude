#!/bin/sh
# Copy the scratch probes into every arm, so each arm runs the same probe against its own src.
set -e
W=/Users/ernestmccarter/Documents/dev/Total-Claude/.claude/worktrees/agent-ad82a43c18e618daf
for d in mainsrc boxes qsplit rams noinset oldcore oldbox; do
  A=/tmp/tc-fv-$d
  [ -d "$A" ] || continue
  mkdir -p "$A/tools/scratch"
  cp "$W/tools/scratch/fv-relief.mjs" "$A/tools/scratch/fv-relief.mjs"
  cp "$W/tools/scratch/fv-terms.mjs" "$A/tools/scratch/fv-terms.mjs"
  echo "synced $A"
done
