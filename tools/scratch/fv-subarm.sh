#!/bin/sh
# Three diagnostic arms that each undo ONE of the three things `0060874` changed, on top of
# `0060874`'s own src. Not shipping candidates -- `oldbox` puts 562 Roman and 182 Juthungi men
# back outside their own deployment boxes, which is the fault the merge was written to fix.
# They exist to answer "which of the three knobs removed the outcome variety", which a whole-
# commit bisect cannot answer and which decides whether there is a narrow fix at all.
#
#   noinset  standOnDeploymentGround stops insetting by box.feather   -> undoes the 80 m shift
#   oldcore  battleCoreMask back to (0,-30,540,360)                   -> undoes the corridor move
#   oldbox   DEPLOY_GROUND back to +-380 / +-250 about x 205           -> undoes the widening
set -e
W=/Users/ernestmccarter/Documents/dev/Total-Claude/.claude/worktrees/agent-ad82a43c18e618daf
SHARED=/Users/ernestmccarter/Documents/dev/Total-Claude

mk() {
  N=$1; A=/tmp/tc-fv-$N
  rm -rf "$A"; mkdir -p "$A"
  for f in index.html viewer.html vite.config.ts package.json package-lock.json tsconfig.json; do cp "$W/$f" "$A/$f"; done
  cp -R "$W/public" "$A/public"; mkdir -p "$A/tools"
  cp -R "$W/tools/judge" "$A/tools/judge"; cp -R "$W/tools/lib" "$A/tools/lib"
  ln -s "$SHARED/node_modules" "$A/node_modules"
  git -C "$W" archive 0060874 src | tar -x -C "$A"
}

report() {
  A=/tmp/tc-fv-$1
  H=$(cd "$A" && find src -type f \( -name '*.ts' -o -name '*.css' -o -name '*.glsl' \) -print0 | sort -z | xargs -0 cat | shasum -a 256 | cut -c1-16)
  printf 'arm %-8s srcHash %s  at %s\n' "$1" "$H" "$A"
}

mk noinset
perl -0pi -e 's/shift = Math\.max\(shift, box\.cx - box\.hx \+ box\.feather - westmost\);/shift = Math.max(shift, box.cx - box.hx - westmost);/' /tmp/tc-fv-noinset/src/sim/scenario.ts
grep -q 'box.cx - box.hx - westmost' /tmp/tc-fv-noinset/src/sim/scenario.ts || { echo 'noinset patch FAILED'; exit 1; }
report noinset

mk oldcore
perl -0pi -e 's/rectMask\(x, z, DEPLOY_AXIS_X, -30, 745, 360, 170\)/rectMask(x, z, 0, -30, 540, 360, 170)/' /tmp/tc-fv-oldcore/src/terrain/topography.ts
grep -q 'rectMask(x, z, 0, -30, 540, 360, 170)' /tmp/tc-fv-oldcore/src/terrain/topography.ts || { echo 'oldcore patch FAILED'; exit 1; }
report oldcore

mk oldbox
perl -0pi -e 's/north: \{ cx: 340, cz: -196, hx: 515, hz: 130, feather: DEPLOY_FEATHER \}/north: { cx: DEPLOY_AXIS_X, cz: -196, hx: 380, hz: 130, feather: DEPLOY_FEATHER }/' /tmp/tc-fv-oldbox/src/terrain/topography.ts
perl -0pi -e 's/south: \{ cx: 380, cz: 150, hx: 425, hz: 120, feather: DEPLOY_FEATHER \}/south: { cx: DEPLOY_AXIS_X, cz: 150, hx: 250, hz: 120, feather: DEPLOY_FEATHER }/' /tmp/tc-fv-oldbox/src/terrain/topography.ts
grep -q 'hx: 380, hz: 130' /tmp/tc-fv-oldbox/src/terrain/topography.ts || { echo 'oldbox north patch FAILED'; exit 1; }
grep -q 'hx: 250, hz: 120' /tmp/tc-fv-oldbox/src/terrain/topography.ts || { echo 'oldbox south patch FAILED'; exit 1; }
report oldbox
