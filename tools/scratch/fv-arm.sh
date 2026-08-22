#!/bin/sh
# Build a bisect arm: a plain copy of the checkout whose src/ is one revision's src/.
#
# Not a git worktree on purpose. This agent is isolation-locked to its own worktree, and the
# rule is "copy src aside, never stash". Each arm gets its own directory, its own vite cache
# and its own port, so three of them can run at once without sharing a dependency cache or a
# listener. srcHash, recorded by jg-shape itself, is what proves which arm was measured --
# `git rev-parse HEAD` is deliberately not relied on here.
#
#   sh tools/scratch/fv-arm.sh <rev> <name>
set -e
W=/Users/ernestmccarter/Documents/dev/Total-Claude/.claude/worktrees/agent-ad82a43c18e618daf
SHARED=/Users/ernestmccarter/Documents/dev/Total-Claude
REV="$1"; NAME="$2"
A="/tmp/tc-fv-$NAME"
rm -rf "$A"
mkdir -p "$A"
# everything but src/ from the branch (so the judge rig is the same rig in every arm)
for f in index.html viewer.html vite.config.ts package.json package-lock.json tsconfig.json; do
  cp "$W/$f" "$A/$f"
done
cp -R "$W/public" "$A/public"
mkdir -p "$A/tools"
cp -R "$W/tools/judge" "$A/tools/judge"
cp -R "$W/tools/lib" "$A/tools/lib"
ln -s "$SHARED/node_modules" "$A/node_modules"
# src/ from the revision under test
git -C "$W" archive "$REV" src | tar -x -C "$A"
H=$(cd "$A" && find src -type f \( -name '*.ts' -o -name '*.css' -o -name '*.glsl' \) -print0 | sort -z | xargs -0 cat | shasum -a 256 | cut -c1-16)
printf 'arm %s  rev %s  srcHash %s  at %s\n' "$NAME" "$REV" "$H" "$A"
