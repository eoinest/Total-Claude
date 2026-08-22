#!/bin/sh
# Gather each arm's jg-shape record into the branch, next to the judge's own two baselines.
set -e
W=/Users/ernestmccarter/Documents/dev/Total-Claude/.claude/worktrees/agent-ad82a43c18e618daf
D=$W/screenshots/judge/shape
mkdir -p "$D"
for a in mainsrc:A-mainsrc boxes:B-boxes qsplit:C-qsplit rams:D-rams noinset:E-noinset oldcore:F-oldcore oldbox:G-oldbox; do
  arm=${a%%:*}; tag=${a##*:}
  for m in campus-martius-field carthage-assault campus-martius-assault; do
    f=/tmp/tc-fv-$arm/screenshots/judge/shape/shape-$m-$tag.json
    [ -f "$f" ] && cp "$f" "$D/" && echo "collected shape-$m-$tag.json"
  done
done
for a in rams:D-rams-carthage; do
  arm=${a%%:*}; tag=${a##*:}
  f=/tmp/tc-fv-$arm/screenshots/judge/shape/shape-carthage-assault-$tag.json
  [ -f "$f" ] && cp "$f" "$D/" && echo "collected shape-carthage-assault-$tag.json"
done
ls -la "$D"
