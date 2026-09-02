#!/usr/bin/env node
/**
 * `npm run host` — the game and the relay, on this machine, reachable from the next one.
 *
 * Usage:
 *   npm run host                       # print a URL to hand over and wait
 *   npm run host -- --port=5958 --relay-port=5959
 *   npm run host -- --lan=192.168.0.238    # when the ranking picks the wrong interface
 *   npm run host -- --loopback             # bind 127.0.0.1: no firewall prompt, no invite
 *   npm run host -- --open | --no-open     # open the lobby here (default: on a terminal)
 *   npm run host -- --json                 # one machine-readable line, then serve
 *
 * ## Why one command and not two
 *
 * The netcode has needed two processes since it existed — `npm run dev` and
 * `node tools/relay.mjs` — and every account of it has been written by somebody who already
 * knew that. Neither of them, on their defaults, binds an address another machine can reach:
 * Vite's config says `host: '127.0.0.1'` and the relay's `listen` said the same. So the
 * documented way to play a two-player game produced, exactly, a two-player game playable by
 * one person.
 *
 * ## Why the deployed site is not part of this
 *
 * Because a browser will not let it be, and it will not let it be twice over. Measured on the
 * live site — a real certificate, a real origin — against a real relay on this machine's en0
 * address, in Chromium 151: `ws://192.168.0.238:5959` fails in 1 ms with
 * `ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS`, and with that check switched off the
 * `WebSocket` constructor throws `SecurityError: An insecure WebSocket connection may not be
 * initiated from a page loaded over HTTPS` before a packet exists. The first is a permission
 * somebody could in principle grant; the second is not a permission at all.
 *
 * `docs/MULTIPLAYER.md` §10.2 has both transcripts and prices the three ways round it. They end
 * in either a certificate somebody has to install on both machines or a tunnel out to the
 * public internet, and the second of those is what `net/worker.ts` is already for.
 *
 * So: the host serves both halves, over plain HTTP, on the LAN. Which has a property the
 * deployed path does not — **both machines are loading the same bytes from the same server**,
 * so "same build" in `docs/MULTIPLAYER.md` §7.1 is true by construction rather than by
 * agreement, and a hash that differs afterwards is a difference between the two CPUs.
 *
 * ## Two ports, and one firewall prompt
 *
 * 5958 serves the game and 5959 is the relay, and they are two listeners rather than one behind
 * a Vite websocket proxy because two processes can be started, killed and diagnosed separately.
 *
 * The lobby used to have to *guess* the second number from the first —
 * `ws://<whatever host served this page>:5959` — which is why this pairing was once load-bearing
 * and why `--relay-port=` was a way to break the form. It is not any more: the Vite half writes
 * `<meta name="tc-relay">` naming the port it was given (see `relayPlaque` in
 * `tools/lib/vite-runner.mjs`), so `src/ui/NetLobby.ts` reads the relay's port rather than
 * assuming it, and any `--relay-port=` works. §11.2.
 *
 * It costs nothing at the firewall either way, because macOS's application firewall prompts per
 * *binary*, not per port: both listeners are the same `node`, so the dialog appears at most
 * once whatever this opens.
 *
 * It may not appear at all, which is worth knowing before writing a paragraph telling somebody
 * to expect it. Measured here: `socketfilterfw --getallowsigned` reports *"Automatically allow
 * downloaded signed software ENABLED"*, node 24.13.0 is Developer-ID signed with a valid
 * timestamp, and binding `0.0.0.0` raised no dialog and did not add the binary to
 * `--listapps`. The dialog is for an unsigned or locally-built node, or a machine with that
 * setting turned off. So the message below is conditional — *if* macOS asks — rather than an
 * instruction to go looking for a window that is not there.
 */

import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { startVite } from './lib/browser-budget.mjs';
import { lanCandidates } from './lib/lan-address.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');

const FLAGS = ['port', 'relay-port', 'lan', 'loopback', 'open', 'no-open', 'json', 'quiet',
  'turn-ms', 'delay'];
const args = new Map(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
}));
const bad = [...args.keys()].filter((k) => !FLAGS.includes(k));
if (bad.length) {
  console.error(`unknown flag(s): ${bad.map((k) => `--${k}`).join(', ')}`);
  console.error(`known: ${FLAGS.map((k) => `--${k}`).join(' ')}`);
  process.exit(2);
}

const PORT = Number(args.get('port') ?? 5958);
const RELAY_PORT = Number(args.get('relay-port') ?? 5959);
const LOOPBACK = args.has('loopback');
const JSON_OUT = args.has('json');
const QUIET = args.has('quiet');
/*
 * Open the host's own browser when this is a person at a terminal, and never when it is a
 * pipe. `tools/qa-net.mjs` runs this arm with its stdout captured and must not have a window
 * appear on the owner's screen; a person who typed `npm run host` wants the lobby.
 */
const OPEN = args.has('open') ? true : args.has('no-open') || JSON_OUT ? false : process.stdout.isTTY === true;
for (const [k, v] of [['port', PORT], ['relay-port', RELAY_PORT]]) {
  if (!Number.isFinite(v) || v <= 0 || v > 65535) {
    console.error(`--${k} must be a port number; got '${args.get(k)}'`);
    process.exit(2);
  }
}
if (PORT === RELAY_PORT) {
  console.error(`--port and --relay-port are both ${PORT}. The game and the relay are two `
    + 'listeners and cannot share one.');
  process.exit(2);
}
if (PORT === 5173 || RELAY_PORT === 5173) {
  console.error('5173 is the owner\'s playtest server. Pick another port.');
  process.exit(2);
}

const say = (...a) => { if (!QUIET && !JSON_OUT) console.log(...a); };

// ---------------------------------------------------------------------------
// Which address to hand over
// ---------------------------------------------------------------------------

const prefer = args.get('lan') ?? '';
const candidates = lanCandidates();
let chosen = null;
if (!LOOPBACK) {
  chosen = prefer
    ? candidates.find((c) => c.ip === prefer) ?? { ip: prefer, iface: '(given)', overridden: true }
    : candidates[0] ?? null;
  if (!chosen) {
    /*
     * A real state, and it must not be papered over with `127.0.0.1`.
     *
     * A Mac with Wi-Fi off and no cable has exactly `lo0`, and so does one whose only other
     * interface is a VPN tunnel — `lan-address.mjs` excludes `utun*` on purpose. Printing a
     * loopback URL here would hand the other player a link to their own machine, which is the
     * precise failure the lobby spent a pass learning to refuse.
     */
    console.error('No LAN address. This machine has no non-loopback IPv4 interface that another');
    console.error('machine could route to, so there is no URL to hand anybody.');
    console.error('');
    console.error('  - Wi-Fi off, or no cable?');
    console.error('  - On a VPN? utun* tunnels are excluded deliberately: the other laptop is not');
    console.error('    on the far end of one.');
    console.error('  - If you know the address, pass it: npm run host -- --lan=192.168.1.23');
    console.error('');
    console.error('  npm run host -- --loopback  serves both halves on 127.0.0.1 for a single');
    console.error('  machine. Two browser windows, one laptop, no invite link.');
    process.exit(1);
  }
}
const BIND = LOOPBACK ? '127.0.0.1' : '0.0.0.0';
const ADDR = LOOPBACK ? '127.0.0.1' : chosen.ip;
const MDNS = `${os.hostname().replace(/\.local\.?$/, '')}.local`;

// ---------------------------------------------------------------------------
// The firewall, said before it happens rather than after
// ---------------------------------------------------------------------------

if (!LOOPBACK) {
  say('');
  say('  Binding an address other than 127.0.0.1. If macOS asks whether');
  say(`  "${path.basename(process.execPath)}" may accept incoming network connections, say Allow —`);
  say('  the relay cannot hear the other machine otherwise. It often will not ask:');
  say('  a signed node is allowed automatically. It asks once per node binary,');
  say('  so an unsigned or freshly-built one can bring the dialog back.');
  say('');
}

// ---------------------------------------------------------------------------
// The two listeners
// ---------------------------------------------------------------------------

let relay = null;
let vite = null;
let stopping = false;

/**
 * Stop both listeners, and — when given a code — stop *here*, on this line.
 *
 * `process.exit` rather than a deferred one, because everything below this in the file is
 * written as if the two servers came up. An earlier version scheduled the exit for 150 ms
 * later and carried on, so a relay that failed to bind was followed by twenty seconds of
 * polling a game server that was in the middle of being killed. Nothing is lost by exiting
 * immediately: `child.kill` and `startVite`'s `close` both deliver their signal synchronously,
 * and both children watch this PID and close themselves within two seconds regardless.
 */
const stop = (code) => {
  if (stopping) return;
  stopping = true;
  try { relay?.kill('SIGTERM'); } catch { /* already gone */ }
  void vite?.close().catch(() => {});
  if (typeof code === 'number') process.exit(code);
};
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => stop(0));
process.on('exit', () => stop());

relay = spawn(process.execPath, [
  path.join(ROOT, 'tools/relay.mjs'),
  `--port=${RELAY_PORT}`, `--host=${BIND}`, `--parent=${process.pid}`,
  ...(args.has('turn-ms') ? [`--turn-ms=${args.get('turn-ms')}`] : []),
  ...(args.has('delay') ? [`--delay=${args.get('delay')}`] : []),
  '--quiet',
], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
let relayErr = '';
relay.stderr.on('data', (d) => { relayErr += String(d); });
relay.on('exit', (code) => {
  if (stopping) return;
  console.error(`\nThe relay exited (${code}). ${relayErr.trim() || 'It said nothing.'}`);
  console.error(`Something else may be on port ${RELAY_PORT}: try --relay-port=5969.`);
  stop(1);
});

/** Poll a URL until it answers. Both halves get the same wait, and both must clear it. */
const waitFor = async (url, ms) => {
  const end = Date.now() + ms;
  for (;;) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (r.ok) return await r.text();
    } catch { /* not yet */ }
    if (Date.now() > end) return null;
    await new Promise((r) => setTimeout(r, 200));
  }
};

const relayHealth = await waitFor(`http://127.0.0.1:${RELAY_PORT}/health`, 15000);
if (relayHealth === null) {
  console.error(`The relay did not answer on ${RELAY_PORT} within 15 s.`);
  console.error(relayErr.trim() || '(it printed nothing)');
  stop(1);
}

try {
  vite = await startVite({
    port: PORT,
    root: ROOT,
    host: BIND,
    relayPort: RELAY_PORT,
    lan: prefer,
    label: 'host-lan',
    cacheDir: process.env.TC_VITE_CACHE_DIR || `/tmp/tc-vite-host-${PORT}`,
  });
} catch (err) {
  console.error(`\n${err?.message ?? err}`);
  stop(1);
}

// ---------------------------------------------------------------------------
// Prove it from the address we are about to hand out, not from loopback
// ---------------------------------------------------------------------------

/*
 * The check that matters is *not* `http://127.0.0.1:5958` answering. That answers whether the
 * process is up, which was never in doubt. This asks the question the other machine will ask —
 * the same address, through the same interface — and it is the check that catches a bind that
 * silently stayed on loopback.
 *
 * What it cannot catch: the firewall. Traffic from this machine to its own en0 address is
 * short-circuited in the kernel and never crosses the filter, so a *reachable* here is a
 * necessary condition and not a sufficient one. The only instrument for the firewall is the
 * other laptop, which is the point of the whole exercise.
 */
const gameOk = await waitFor(`http://${ADDR}:${PORT}/`, 20000);
const relayOk = await waitFor(`http://${ADDR}:${RELAY_PORT}/health`, 8000);
const plaque = await fetch(`http://${ADDR}:${PORT}/__tc/lan`)
  .then((r) => (r.ok ? r.json() : null)).catch(() => null);

const gameUrl = `http://${ADDR}:${PORT}/`;
const lobbyUrl = `http://${ADDR}:${PORT}/?mp=1`;
const relayUrl = `ws://${ADDR}:${RELAY_PORT}`;

if (JSON_OUT) {
  console.log(JSON.stringify({
    tc: 'host-lan', ok: !!(gameOk && relayOk), bind: BIND, lan: ADDR,
    iface: chosen?.iface ?? 'lo0', mdns: LOOPBACK ? null : MDNS,
    gamePort: PORT, relayPort: RELAY_PORT, gameUrl, lobbyUrl, relayUrl,
    plaque, alternatives: candidates.filter((c) => c.ip !== ADDR),
    node: process.execPath, pid: process.pid,
  }));
} else {
  const rule = '─'.repeat(64);
  say(rule);
  if (LOOPBACK) {
    say('  Serving on 127.0.0.1 only. Nothing outside this machine can reach it,');
    say('  and the lobby will withhold the invite link and say so.');
    say('');
    say(`      ${lobbyUrl}`);
  } else {
    say('  Hand this to the other commander. They open it and they are in your room:');
    say('');
    say(`      ${lobbyUrl}`);
    say('');
    say(`  Or read out the room code from the CREATE A ROOM screen — that works from`);
    say('  any address and survives a phone call.');
  }
  say(rule);
  say(`  game    ${gameUrl}${gameOk ? '' : '   NOT ANSWERING'}`);
  say(`  relay   ${relayUrl}${relayOk ? '' : '   NOT ANSWERING'}`);
  if (!LOOPBACK) {
    say(`  also    http://${MDNS}:${PORT}/?mp=1`);
    say('          Mac to Mac. This name follows the machine across a DHCP lease');
    say('          change; the numbers above do not.');
    say(`  on      ${chosen.iface}${chosen.overridden ? ', given with --lan=' : ''}`);
    for (const c of candidates.filter((c) => c.ip !== ADDR)) {
      say(`          not chosen: ${c.ip} (${c.why}) — --lan=${c.ip} to use it instead`);
    }
  }
  say(rule);
  if (!LOOPBACK) {
    say('  Both machines must be on the same network. Same Wi-Fi is usually enough;');
    say('  a "guest" network, or one with client isolation on, is not — those exist');
    say('  specifically to stop two devices seeing each other, and nothing here can');
    say('  work round that.');
    say('  If the other machine cannot open it: check the firewall said Allow, and');
    say(`  that ${ADDR} is the address on the network they are on.`);
    say(rule);
  }
  say('  Ctrl-C stops both.');
  say('');
}

if (!gameOk || !relayOk) {
  console.error(`\n${!gameOk ? `The game did not answer at ${gameUrl}. ` : ''}`
    + `${!relayOk ? `The relay did not answer at ${relayUrl}. ` : ''}`
    + '\nThe bind reports success but the address does not respond, which usually means'
    + `\n${ADDR} is not this machine's address on the network it is actually on.`
    + '\nRun with --json to see every interface, or pass --lan= to pick one.');
  stop(1);
}

if (OPEN) {
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  spawn(opener, [lobbyUrl], { stdio: 'ignore', detached: true }).unref();
}

/*
 * Nothing after this. `startVite`'s child and the relay both hold the event loop open through
 * their pipes, and both watch this PID and exit when it goes — so a `kill -9` here still leaves
 * a bounded orphan lifetime rather than a listener owned by nobody.
 */
