#!/bin/sh
# Scratch: block until the machine's one-minute load average falls below $1 (default 45).
#
# docs/HANDOFF.md records load 76-82 as the band that killed nine agents, and six other agents'
# Playwright runs had it at 144 while this pass was running. A browser gate started into that
# does not measure the tree, it measures the queue.
LIMIT="${1:-45}"
while :; do
  L=$(uptime | sed 's/.*load averages*: *//' | awk '{print int($1)}')
  [ "$L" -lt "$LIMIT" ] && { echo "load $L, clear"; exit 0; }
  sleep 30
done
