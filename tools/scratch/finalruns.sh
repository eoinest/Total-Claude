#!/bin/sh
# The remaining browser verification, chained so it holds one queue ticket at a time.
#
# The owner-state ladder caps agents at one browser while he is at the keyboard, and both of
# these gates take two, so neither can start until he stops. Sequential rather than parallel for
# exactly that reason: two queued runs would take turns and neither would finish sooner.
set -u
cd "$(dirname "$0")/../.." || exit 1

echo "=== qa-net --only=lan (confirming the WsSignal.send fix end to end) ==="
node tools/qa-net.mjs --only=lan --json=/tmp/qanet-lan.json 2>&1 | tail -40
echo "lan exit=$?"

echo ""
echo "=== qa-p2p --only=battle,desync,leave (the lockstep proof, three battles) ==="
node tools/qa-p2p.mjs --only=battle,desync,leave --json=/tmp/p2p-core.json 2>&1 | tail -90
echo "core exit=$?"

echo ""
echo "=== qa-p2p --only=lag,ab (latency, and the A/B against the relay) ==="
node tools/qa-p2p.mjs --only=lag,ab --json=/tmp/p2p-ab.json 2>&1 | tail -40
echo "ab exit=$?"
