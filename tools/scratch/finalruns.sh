#!/bin/sh
# The remaining browser verification, chained so it holds one queue ticket at a time.
#
# The owner-state ladder caps agents at one browser while he is at the keyboard, and both of
# these gates take two, so neither can start until he stops. Sequential rather than parallel for
# exactly that reason: two queued runs would take turns and neither would finish sooner.
#
# Ordered by what is worth most if only the first one gets to run.
set -u
cd "$(dirname "$0")/../.." || exit 1

echo "=== 1. qa-p2p --only=battle,desync,leave (the lockstep proof, three battles) ==="
node tools/qa-p2p.mjs --only=battle,desync,leave --json=/tmp/p2p-core.json 2>&1 | tail -110
echo "core exit=$?"

echo ""
echo "=== 2. qa-net --only=lan,lag (the WsSignal.send fix, and the relay latency arm) ==="
node tools/qa-net.mjs --only=lan,lag --json=/tmp/qanet-lan.json 2>&1 | tail -45
echo "lan exit=$?"

echo ""
echo "=== 3. qa-p2p --only=lag,ab (latency on a real channel, and the A/B) ==="
node tools/qa-p2p.mjs --only=lag,ab --json=/tmp/p2p-ab.json 2>&1 | tail -40
echo "ab exit=$?"
