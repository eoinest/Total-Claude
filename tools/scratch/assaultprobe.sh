#!/bin/sh
# One battle, the one that failed: campus-martius/assault over a peer connection.
#
# The three-battle arm passed campus-martius/field on every check and then timed out waiting for
# the assault's two sides to leave the lobby phase, with nothing in the log about why. This runs
# that one battle with the handshake diagnostic in place.
set -u
cd "$(dirname "$0")/../.." || exit 1
node tools/qa-p2p.mjs --only=battle --battles=campus-martius/assault \
  --json=/tmp/p2p-assault.json > /tmp/p2p-assault.log 2>&1
echo "assault exit=$?"
tail -60 /tmp/p2p-assault.log
