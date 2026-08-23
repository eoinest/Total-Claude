#!/bin/sh
# Every scratch tool this pass added or relied on, run for its exit code only.
#
# `e/city/rome-transtiberim` found that `rome-wayscan.mjs` had thrown on every invocation since
# the phase-4 pass deleted a symbol it imported, and nobody noticed because nobody read past the
# first line. A tool that cannot start is worse than one that is wrong: it is silent.
set -u
fail=0
for t in fill-audit fill-plate seam-probe wet-probe whoblocks blockq seam-blocks rome-blockcheck; do
  printf '%-18s ' "$t"
  if node --experimental-transform-types --import ./tools/lib/ts-resolve.mjs \
      "tools/scratch/$t.mjs" >/dev/null 2>"/tmp/tc-toolcheck-$t.txt"; then
    echo OK
  else
    echo FAIL
    tail -4 "/tmp/tc-toolcheck-$t.txt"
    fail=1
  fi
done
exit "$fail"
