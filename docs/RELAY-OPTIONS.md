# Where the relay runs

A browser tab cannot accept an incoming connection. Two players therefore need a third
thing that both can dial, and the only question is where it lives. This file records the
two answers, what each costs, and why the owner picked the one they picked on 2 Sep 2026.

## The constraint that decides everything

An `https` page may not open a `ws://` connection. Browsers block it as mixed content and
there is no flag, no header and no permission prompt that changes it. The deployed site is
`https://total-claude.vercel.app`. A home-network address has no certificate and cannot get
one. **So the deployed site can never talk to a LAN relay** — not as a bug, as the rule.

Everything below follows from that one sentence.

## Option A — LAN, chosen

The host runs `npm run host`. Their machine serves the game over plain `http` and runs the
relay beside it, so the page and the relay share a scheme and the block never applies.

The guest's first page must therefore come from the host's machine. That is the whole cost
of this option, and it cannot be designed away — a code alone cannot conjure a page. What a
code *can* do is carry everything after that, which is what the QR is for: it encodes the
join URL and the room, so the guest scans and is in the room having typed nothing.

Nothing leaves the house, nothing is billed, and the latency is a switch rather than a
continent.

## Option B — a Cloudflare Durable Object, not chosen

`net/worker.ts` and `net/wrangler.toml` have been sitting in this repository unbuilt since
23 Aug 2026. `docs/MULTIPLAYER.md` §4.3 explains why a Durable Object is the target:
`idFromName(roomCode)` gives a globally unique object reachable from anywhere, which is the
routing primitive Vercel Functions do not have at any price.

With it deployed, both players open the public site, one clicks Create, reads out five
characters, and the other types them. No terminal, no URL, no same-network requirement.

### What it would cost, researched 2 Sep 2026

Verified against `developers.cloudflare.com`, with the inferences marked as inferences.

**Directly quoted from the docs:**

- "Durable Objects are available both on Workers Free and Workers Paid plans."
- "Workers Free plan: Only Durable Objects with SQLite storage backend are available."
  Which means the migration must be `new_sqlite_classes`. "Classes introduced through
  `new_classes` use `legacy-kv`", and creating new KV-backed namespaces "is no longer
  supported for accounts without an existing key-value-backed namespace" — so the
  legacy path is not merely worse, it is unavailable to a new account.
- Free daily ceilings: **100,000 Workers requests, 100,000 DO requests, 13,000 GB-s of
  duration**, resetting at 00:00 UTC. "If you exceed any one of the free tier limits,
  further operations of that type will fail with an error."
- Incoming WebSocket messages are billed at **20:1** — 100 messages count as 5 requests.
  Outgoing messages and protocol pings are not charged. The ratio is billing-only and does
  not affect the analytics numbers.
- "Billable Duration (GB-s) charges do not accrue during hibernation", and an object that
  is merely idle and hibernation-eligible is not billed either.
- Every account, Free included, gets a `workers.dev` subdomain.

**Inferred, and flagged as such by the agent that looked:** that the WebSocket Hibernation
API and WebSockets generally are Free-plan usable. No page says they are not, and Durable
Objects themselves are Free-eligible, but no sentence says so outright. Likewise that
`wrangler dev` needs no login — local-by-default is documented and no auth requirement is
stated anywhere, but there is no explicit guarantee.

**No documented ceiling exists on concurrent WebSocket connections per object.** The limits
page's "6 simultaneous outgoing connections" is about outbound subrequests, not clients.
Forum posts citing "~150" are hearsay and are recorded here only so nobody mistakes them
for documentation later.

**The practical number.** Two players exchanging turn packets, billed at 20:1, against
either the 100,000-request or the 13,000 GB-s ceiling, both land in the same place: roughly
**eighty twenty-minute matches a day, free.** For two people this is not a constraint. The
honest caveat is that a free-tier overage fails the operation rather than charging for it,
so the failure mode is a match that will not start rather than a bill.

`wrangler` is dual-licensed `MIT OR Apache-2.0` — verified through the npm registry API,
because npmjs.com returns 403 to automated fetches.

## Why LAN was chosen anyway

The owner picked LAN on 2 Sep 2026 knowing the relay path existed. Free-tier headroom was
confirmed after the choice, and the choice stood: LAN needs no account, no deploy and no
dependency on a third party staying free, and for two people in one house the traffic has
no reason to cross the internet at all.

If that ever changes, Option B is not a rewrite. The room logic is a pure state machine in
`src/net/room.ts` with thin adapters over it, and the second adapter is already written.
The work is a deploy, an env var pointing the build at the `wss://` address, and proving
the DO adapter has not drifted from the state machine — that last one is unmeasured and
should not be assumed.
