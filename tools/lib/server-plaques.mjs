#!/usr/bin/env node
/**
 * The two facts a server states about itself, spelled once for both servers that state them.
 *
 * `npm run host` now has two backends — `tools/lib/vite-runner.mjs` for `--dev` and
 * `tools/lib/static-runner.mjs` for the production build it serves by default — and both have
 * to write the same two meta tags into the document, because `src/ui/NetLobby.ts` reads them
 * and refuses to guess when they are absent. Two servers writing "the same" tag from two copies
 * of the code is the shape of the `.local` bug: `vite-runner.mjs` and `tools/host-lan.mjs` each
 * derived the Bonjour name from `os.hostname()`, under a comment claiming it was spelled once
 * *because* two places had to agree — and they agreed on `Mac.attlocal.net.local`, which
 * resolves to nothing. So this is the one spelling, and both runners import it.
 *
 * ## The plaque, and why it is `null` so often
 *
 * `<meta name="tc-lan">` answers *what address does the machine next door use for this server*,
 * and it can only be answered on a non-loopback bind. Bound to `127.0.0.1` the tag is **absent**
 * rather than empty, and that absence is load-bearing: it is what keeps `npm run dev` honest
 * about not being reachable, and it is what the `dev` and `static` arms of `tools/qa-net.mjs`
 * assert.
 *
 * ## The relay port, which is smaller and holds on every bind
 *
 * `<meta name="tc-relay">` answers *a relay was started beside this server, on this port*. It
 * is written on a loopback bind too, so `npm run host -- --loopback` gets an answer the plaque
 * could never give it, and it is absent under `npm run dev`. A port and not a URL: the host
 * part is `location.hostname`, so the same document composes `ws://127.0.0.1:5959` in the
 * host's tab and `ws://192.168.1.77:5959` in the guest's, and both are right at once.
 *
 * A page must still check. This says a relay was *asked for*, not that one is listening — the
 * two halves are separate processes and either can die alone. `relayAnswers()` in the lobby
 * probes `/health` before it believes any of this.
 */

import { isLoopbackHost, lanAddress, mdnsName } from './lan-address.mjs';

/**
 * `mdnsName()` shells out to `scutil` on darwin, so it is asked once per process.
 *
 * The static server calls `lanPlaqueFor` on every `/__tc/lan` and on every document, which
 * would otherwise be an `execFileSync` per request — 3 ms of a page load spent asking the
 * system a question whose answer cannot change while the process lives.
 */
let mdnsCache = null;
const mdns = () => (mdnsCache ??= mdnsName());

/**
 * `<meta name="tc-lan">`'s payload, or `null` on a loopback bind or a machine with no LAN.
 *
 * `relayUrl` is only stated when a relay port was given. A page that gets `relayPort: null`
 * must not go on to invent `ws://<lan>:5959`: that would be guessing at a process nobody
 * started, which is exactly the wrong answer `defaultRelay()` used to give on the deployed
 * site.
 */
export const lanPlaqueFor = ({ host, port, relayPort = 0, prefer = '' }) => {
  if (isLoopbackHost(host)) return null;
  const pick = lanAddress({ prefer });
  if (!pick) return null;
  return {
    tc: 'host-lan',
    lan: pick.ip,
    iface: pick.iface,
    mdns: mdns(),
    gamePort: port,
    gameUrl: `http://${pick.ip}:${port}/`,
    relayPort: relayPort || null,
    relayUrl: relayPort ? `ws://${pick.ip}:${relayPort}` : null,
  };
};

/** `<meta name="tc-relay">`'s content: the port, as a string, or `null` if there is no relay. */
export const relayPlaqueFor = (relayPort) => (relayPort ? String(relayPort) : null);
