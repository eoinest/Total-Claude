#!/bin/sh
# The verification the WsSignal receive-path fix makes possible, and the two arms that never ran.
#
# Not a pipeline: `$?` after `cmd | tail` is tail's status, which is always 0.
set -u
cd "$(dirname "$0")/../.." || exit 1

echo "=== 1. qa-net --only=lan (the receive-path fix, end to end on a plain-http LAN origin) ==="
node tools/qa-net.mjs --only=lan --json=/tmp/qanet-lan.json > /tmp/qanet-lan.log 2>&1
echo "lan exit=$?"
tail -30 /tmp/qanet-lan.log

echo ""
echo "=== 2. qa-p2p --only=battle,desync,leave (all three battles, with the handshake diagnostic) ==="
node tools/qa-p2p.mjs --only=battle,desync,leave --json=/tmp/p2p-core.json > /tmp/p2p-core.log 2>&1
echo "core exit=$?"
tail -120 /tmp/p2p-core.log

echo ""
echo "=== 3. qa-p2p --only=lag,ab,nodirect ==="
node tools/qa-p2p.mjs --only=lag,ab,nodirect --json=/tmp/p2p-ab.json > /tmp/p2p-ab.log 2>&1
echo "ab exit=$?"
tail -60 /tmp/p2p-ab.log
