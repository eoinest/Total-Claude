#!/bin/sh
# Copy the gameplay-owned sources into an isolated worktree so the balance harnesses
# can run while other agents are mid-edit in src/city and src/ui. Everything not listed
# here stays at the committed revision.
set -e
SRC=/Users/ernestmccarter/Documents/dev/Total-Claude
DST=${1:-/tmp/tc-gp}
cp -R "$SRC/src/sim" "$DST/src/"
cp -R "$SRC/src/ai" "$DST/src/"
cp "$SRC/src/units/roster.ts" "$DST/src/units/roster.ts"
cp "$SRC/tools/"*.mjs "$DST/tools/"
echo "synced gameplay sources to $DST"
