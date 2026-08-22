#!/bin/sh
# Arm H -- the candidate narrow fix, built shipping-shaped rather than as a revert.
#
# `0060874` did three things. Two of them are the owner's decision and are wanted: the boxes
# widened east, and the ground under the widened part prepared. The third is a side effect of
# *how* the second was implemented -- `standOnDeploymentGround` was made to inset its west
# anchor by `box.feather`, which moves the whole battle 80 m east (271.146 -> 351.146 m), and
# it was introduced to fix **14 men**: the four leftmost files of the left-wing equites standing
# on the contour where the west mask reads 0.00.
#
# The same requirement -- every man inside the mask's full-strength core -- is satisfied by
# giving each box 80 m more rectangle on its WEST side instead, leaving the core where it is:
#
#   north  cx 340 hx 515  ->  cx 300 hx 555   rect -255..855, core -175..775
#   south  cx 380 hx 425  ->  cx 340 hx 465   rect -125..805, core  -45..725
#
# The east edges (855, 805) and the cores' east ends (775, 725) are exactly the numbers
# `6d572a8` solved for, `cx - hx + feather` is back to the old west edge, so the placement rule
# computes the old 271.146 m shift with the inset still in the code, and no man is outside his
# box or on its soft edge. Cost: 80 m of *fractionally* flattened, tree-cleared ground added on
# each box's west side, which is toward the Tiber -- the south box's rectangle edge goes to
# x -125 where the shipped -45 clears the funnel's standing water by 23 m. That is the one thing
# this arm cannot settle and `probe-ground` plus the river's own acceptance must.
set -e
W=/Users/ernestmccarter/Documents/dev/Total-Claude/.claude/worktrees/agent-ad82a43c18e618daf
SHARED=/Users/ernestmccarter/Documents/dev/Total-Claude
A=/tmp/tc-fv-westbox
rm -rf "$A"; mkdir -p "$A"
for f in index.html viewer.html vite.config.ts package.json package-lock.json tsconfig.json; do cp "$W/$f" "$A/$f"; done
cp -R "$W/public" "$A/public"; mkdir -p "$A/tools"
cp -R "$W/tools/judge" "$A/tools/judge"; cp -R "$W/tools/lib" "$A/tools/lib"
cp -R "$W/tools/scratch" "$A/tools/scratch"
ln -s "$SHARED/node_modules" "$A/node_modules"
git -C "$W" archive 0060874 src | tar -x -C "$A"
perl -0pi -e 's/north: \{ cx: 340, cz: -196, hx: 515, hz: 130, feather: DEPLOY_FEATHER \}/north: { cx: 300, cz: -196, hx: 555, hz: 130, feather: DEPLOY_FEATHER }/' "$A/src/terrain/topography.ts"
perl -0pi -e 's/south: \{ cx: 380, cz: 150, hx: 425, hz: 120, feather: DEPLOY_FEATHER \}/south: { cx: 340, cz: 150, hx: 465, hz: 120, feather: DEPLOY_FEATHER }/' "$A/src/terrain/topography.ts"
grep -q 'cx: 300, cz: -196, hx: 555' "$A/src/terrain/topography.ts" || { echo 'north patch FAILED'; exit 1; }
grep -q 'cx: 340, cz: 150, hx: 465' "$A/src/terrain/topography.ts" || { echo 'south patch FAILED'; exit 1; }
H=$(cd "$A" && find src -type f \( -name '*.ts' -o -name '*.css' -o -name '*.glsl' \) -print0 | sort -z | xargs -0 cat | shasum -a 256 | cut -c1-16)
printf 'arm westbox  srcHash %s  at %s\n' "$H" "$A"
