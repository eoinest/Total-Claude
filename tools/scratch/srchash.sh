#!/bin/sh
# srcHash exactly as jg-shape computes it, for an arbitrary rev, without checking it out.
set -e
W=/Users/ernestmccarter/Documents/dev/Total-Claude/.claude/worktrees/agent-ad82a43c18e618daf
T=/tmp/tc-srchash-$$
for rev in "$@"; do
  rm -rf "$T"; mkdir -p "$T"
  git -C "$W" archive "$rev" src | tar -x -C "$T"
  h=$(cd "$T" && find src -type f \( -name '*.ts' -o -name '*.css' -o -name '*.glsl' \) -print0 | sort -z | xargs -0 cat | shasum -a 256 | cut -c1-16)
  printf '%s  %s  %s\n' "$h" "$rev" "$(git -C "$W" log -1 --format=%s "$rev" | cut -c1-70)"
done
rm -rf "$T"
