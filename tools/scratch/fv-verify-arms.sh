#!/bin/sh
# The guard jg-shape could not give me.
#
# `jg-shape` computes `head` and `srcHash` in one try block, so in a copied arm with no `.git`
# the `git rev-parse` throws first and BOTH come out `?`. That is precisely the "a bisect step
# that silently measured the previous tree" hazard, so the identity of each arm is verified
# here instead, by the same formula, before and after every run. Four distinct hashes for four
# arms is the claim; anything else invalidates the run that produced it.
set -e
for A in /tmp/tc-fv-mainsrc /tmp/tc-fv-boxes /tmp/tc-fv-qsplit /tmp/tc-fv-rams; do
  H=$(cd "$A" && find src -type f \( -name '*.ts' -o -name '*.css' -o -name '*.glsl' \) -print0 | sort -z | xargs -0 cat | shasum -a 256 | cut -c1-16)
  printf '%s  %s\n' "$H" "$A"
done
