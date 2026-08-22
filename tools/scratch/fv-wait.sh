#!/bin/sh
# Block until every named log has produced N `seed` lines. One notification, then exits.
#   sh fv-wait.sh <n-per-log> <log> [<log> ...]
N=$1; shift
while :; do
  done_all=1
  for f in "$@"; do
    c=$(grep -c '^seed' "$f" 2>/dev/null || echo 0)
    [ "$c" -ge "$N" ] || done_all=0
  done
  [ "$done_all" -eq 1 ] && break
  sleep 15
done
for f in "$@"; do printf '%s %s\n' "$(grep -c '^seed' "$f")" "$f"; done
date +%H:%M:%S
