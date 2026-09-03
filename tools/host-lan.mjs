#!/usr/bin/env node
/**
 * `npm run host` — the game and the relay, on this machine, reachable from the next one.
 *
 * Usage:
 *   npm run host                       # build if needed, then serve it; print a URL and wait
 *   npm run host -- --dev                  # the Vite dev server instead, with HMR
 *   npm run host -- --rebuild              # build even if dist/ looks current
 *   npm run host -- --no-build             # serve dist/ as it stands, and say if it is stale
 *   npm run host -- --port=5958 --relay-port=5959
 *   npm run host -- --lan=192.168.0.238    # when the ranking picks the wrong interface
 *   npm run host -- --loopback             # bind 127.0.0.1: no firewall prompt, no invite
 *   npm run host -- --open | --no-open     # open the room here (default: on a terminal)
 *   npm run host -- --no-qr                # no square in the terminal, just the URL
 *   npm run host -- --json                 # one machine-readable line, then serve
 *
 * ## Why this serves a build and not the dev server
 *
 * It served the dev server until now, and the person who paid for that was never the person who
 * typed the command. The host's browser is on loopback, warm, and holds every transform from
 * the last run; the guest on the other laptop gets `<script src="/@vite/client">`, **194
 * requests and 23.2 MB**, every module transformed on demand, none of it compressed, out of a
 * `public/` tree that is 214 MB on disk. Measured from a second browser over 192.168.1.77 on a
 * 30 Mbit/s Wi-Fi profile that was **6.8 seconds** of nothing, and the owner's friend reported
 * exactly that: *"takes wayyyy too long to load"*.
 *
 * The production build is the same game in one entry point and a handful of hashed chunks, and
 * `tools/optimize-assets.mjs` has already taken its textures from 164.9 MB to 4.6 MB. Nothing
 * about it is new — it is what `npm run deploy` has always shipped. It simply was not what the
 * guest was being handed. `tools/lib/static-runner.mjs` serves it, with the two meta tags the
 * lobby depends on injected into the built HTML; `tools/qa-hostload.mjs` is the instrument, and
 * prints both numbers.
 *
 * `--dev` keeps the old path exactly, for working on the game rather than playing it.
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
 * > **Read the correction below before the next two paragraphs.** Their conclusion is right and
 * > their mechanism is right only on WebKit; the second transcript does not describe what
 * > Chromium 151 does. They are kept because they are the original measurement.
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
 * **One correction to the paragraph above, measured 2 September 2026 — and it is engine-specific.**
 *
 *   - **Chromium 151** does not refuse this because of https as such. It refuses the reach from
 *     a *public* address space into a *private* one. From an https page whose own origin is a
 *     private address it opens `ws://192.168.1.77:5959` without complaint, and refuses only
 *     `ws://1.1.1.1`, as mixed content. The live site is refused because it is public reaching
 *     into private: `ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS`, the first of the two
 *     transcripts above and not the second.
 *   - **WebKit** has no such carve-out. The same page refuses all three targets — private,
 *     loopback and public — as plain mixed content, which is exactly what the paragraph above
 *     says. On Safari the original explanation was right all along.
 *
 * So the conclusion is unchanged on every engine and only the *reason* differs, which matters
 * because the owner is on a Mac and the likeliest guest device is an iPhone. §12.6 has the
 * table; `tools/qa-net.mjs`'s `https` arm reproduces the Chromium half with
 * `--ip-address-space-overrides`.
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
import { buildDist, distStatus } from './lib/dist-build.mjs';
import { DEFAULT_RELAY_PORT } from '../src/net/protocol.ts';
import { qrEncode, qrHalfBlocks } from '../src/net/qr.ts';
import { lanCandidates, mdnsName } from './lib/lan-address.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');

const FLAGS = ['port', 'relay-port', 'lan', 'loopback', 'open', 'no-open', 'json', 'quiet',
  'turn-ms', 'delay', 'no-qr', 'dev', 'rebuild', 'no-build'];
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
const RELAY_PORT = Number(args.get('relay-port') ?? DEFAULT_RELAY_PORT);
const LOOPBACK = args.has('loopback');
const JSON_OUT = args.has('json');
const QUIET = args.has('quiet');
/* A terminal that cannot draw half blocks, or a transcript that has to stay plain. */
const NO_QR = args.has('no-qr');
/*
 * `--dev` is the escape hatch and not the default, and the asymmetry is the point.
 *
 * Somebody working on the game wants HMR and knows to ask for it. Somebody handing a link to a
 * friend wants the friend's browser to be quick, and will not think to ask — so the fast path
 * is what happens when nobody says anything.
 *
 * `--rebuild` forces a build that the staleness check would have skipped, and `--no-build`
 * refuses to run one. The second is honest rather than silent: it still prints that the build
 * is stale, because serving yesterday's game without saying so is the failure this whole
 * section exists to avoid.
 */
const DEV = args.has('dev');
const REBUILD = args.has('rebuild');
const NO_BUILD = args.has('no-build');
if (DEV && (REBUILD || NO_BUILD)) {
  console.error('--dev serves the source directly; there is no build for --rebuild or --no-build to act on.');
  process.exit(2);
}
if (REBUILD && NO_BUILD) {
  console.error('--rebuild and --no-build ask for opposite things.');
  process.exit(2);
}
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
const MDNS = mdnsName();

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
// The build, if the source has moved since the last one
// ---------------------------------------------------------------------------

/*
 * Narration on **stderr**, always, and not through `say`.
 *
 * `--json` promises one machine-readable line on stdout and `tools/qa-net.mjs` parses it with
 * `out.match(/^\{.*\}$/m)`; a build's chatter on that stream is at best noise and at worst a
 * line that looks like the contract. On a terminal both streams land in the same window, so a
 * person watching sees it either way, which is the only reader this text is for.
 */
const narrate = (line) => { if (!QUIET) process.stderr.write(`${line}\n`); };

let build = null;
if (!DEV) {
  const status = await distStatus(ROOT);
  build = { mode: 'static', fresh: status.fresh, reason: status.reason, rebuilt: false, ms: 0 };
  if (status.fresh && !REBUILD) {
    narrate(`  build   current — ${status.reason}`);
  } else if (NO_BUILD) {
    /*
     * Stale and told not to fix it. This is a warning and not a refusal: `--no-build` is asked
     * for by somebody who knows what they have, and refusing to serve it would make the flag
     * useless. What must not happen is serving it *quietly* — the owner changing code and
     * wondering why nothing moved is the whole reason the check exists.
     */
    narrate(`  build   STALE and --no-build was given — ${status.reason}`);
    narrate('          The guest will load the previous build. Drop --no-build to fix it.');
    build.staleServed = true;
  } else {
    narrate(`  build   ${REBUILD && status.fresh ? 'rebuilding on request' : `out of date — ${status.reason}`}`);
    narrate('          Building the production bundle. This is once; the next start skips it.');
    const t0 = Date.now();
    const res = await buildDist(ROOT, { onLine: (l) => narrate(`          ${l}`) });
    build.ms = Date.now() - t0;
    build.rebuilt = true;
    if (!res.ok) {
      console.error(`\nThe build failed at ${res.step}. Nothing was served.`);
      console.error('Fix it, or run with --dev to serve the source through Vite instead.');
      process.exit(1);
    }
    build.builtByAnother = !!res.builtByAnother;
    narrate(res.builtByAnother
      ? `          another process in this tree built it while we waited (${(build.ms / 1000).toFixed(1)}s)`
      : `          done in ${(build.ms / 1000).toFixed(1)}s`);
  }
} else {
  build = { mode: 'dev', fresh: null, reason: 'the dev server reads the source on every request', rebuilt: false, ms: 0 };
  narrate('  build   skipped: --dev serves the source through Vite, with HMR');
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

/*
 * One call for both servers, and that is deliberate rather than convenient.
 *
 * `startVite` carries the port-theft refusal, the `/__tc/tree` identity check, `spawnOwned`'s
 * guard and registry entry, and the cleanup that survives this process being SIGKILLed — all of
 * it the accumulated answer to two orphan incidents and a stolen port. A static server that
 * opened its own `http.createServer` beside that would have had none of it, and would have been
 * the nineteen-orphan morning again with a new cause.
 */
try {
  vite = await startVite({
    port: PORT,
    root: ROOT,
    host: BIND,
    relayPort: RELAY_PORT,
    lan: prefer,
    label: 'host-lan',
    mode: DEV ? 'dev' : 'static',
    ...(DEV ? { cacheDir: process.env.TC_VITE_CACHE_DIR || `/tmp/tc-vite-host-${PORT}` } : {}),
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

// ---------------------------------------------------------------------------
// The room, opened here, so that the thing printed is a thing to scan
// ---------------------------------------------------------------------------

/*
 * ## Why the room is minted by the command and not by the browser
 *
 * A QR has to encode a code, and until this line ran there was no code: the lobby asked
 * `/new` when somebody pressed CREATE, which is after the terminal has finished printing. So
 * what the terminal could offer was a link to *the lobby* — a form, with a field, on the
 * guest's screen, waiting for five characters somebody would have to read out anyway. That is
 * the gap the owner was pointing at.
 *
 * `/new` is one HTTP request to a relay this process started four lines ago, and it is the
 * identical request the CREATE button makes. Having the code first turns three things from
 * intentions into printable facts: the code, the join URL that carries it, and the square.
 *
 * The host's browser is then opened on `?mp=1&room=…&create=1`, which claims *this* room by
 * name rather than opening a form. If the two disagreed — a browser that opened an empty lobby
 * and minted a second room on CREATE — the terminal's square would point at a room the host had
 * silently left, which is a worse failure than not printing one at all: it looks like it works.
 *
 * A relay that will not mint a room is not fatal. Everything below degrades to what this
 * command printed before: the lobby URL, no code and no square, with the reason said out loud.
 */
const minted = await fetch(`http://127.0.0.1:${RELAY_PORT}/new`, { signal: AbortSignal.timeout(4000) })
  .then((r) => (r.ok ? r.json() : null)).catch(() => null);
const ROOM = typeof minted?.room === 'string' ? minted.room : null;
const joinUrl = ROOM ? `http://${ADDR}:${PORT}/?room=${ROOM}` : null;
const hostUrl = ROOM ? `http://${ADDR}:${PORT}/?mp=1&room=${ROOM}&create=1` : lobbyUrl;
/*
 * No square on a loopback bind, and it is the same judgement the lobby makes about the invite
 * link. A QR of `http://127.0.0.1:5958/?room=ABCDE` scans perfectly and opens the *scanner's*
 * own machine, which is the single most confusing thing this command could put on a screen.
 */
const showQr = !!(joinUrl && !LOOPBACK && !NO_QR);

/*
 * The block is *built* before it is printed, and the square goes at the bottom.
 *
 * Two reasons, and the second is the one a reviewer had to find. The first: with the square in
 * the middle, this command printed 55 lines of which 22 came after the last row of it — so on
 * an 80x24 window the thing the other machine is supposed to photograph had scrolled off the
 * top by the time the command settled. The address, the interfaces and the network caveats are
 * reference material; the square and the line under it are the thing to act on, and the thing
 * to act on goes last, where a terminal leaves it.
 *
 * The second: building an array rather than printing as we go means the layout is a *fact this
 * command can report*. `--json` carries `lines` and `linesAfterQr`, so `tools/qa-net.mjs` can
 * assert the square is still on screen without running a terminal — which is the only way that
 * claim could be checked at all, since the JSON mode prints no square.
 */
const out = [];
const rule = '─'.repeat(64);
const put = (line = '') => out.push(line);
let qrEnd = -1;

put(rule);
put(`  game    ${gameUrl}${gameOk ? '' : '   NOT ANSWERING'}`);
put(`  relay   ${relayUrl}${relayOk ? '' : '   NOT ANSWERING'}`);
/*
 * Which of the two servers is behind that URL, said on screen.
 *
 * Not decoration. The two differ by about 23 MB and six seconds *for the other machine*, and
 * the person reading this is the one person who cannot feel the difference — his own browser
 * is on loopback and warm either way. A host who has left `--dev` on a shell alias would
 * otherwise have no way to know why his friend is still waiting.
 */
if (DEV) {
  put('  serves  the Vite dev server. The guest fetches ~200 source modules and pays');
  put('          for each one — 23.2 MB, and 6.8 s on Wi-Fi. Drop --dev for the build.');
} else {
  put(`  serves  the production build in dist/${build.rebuilt
    ? `, built just now in ${(build.ms / 1000).toFixed(1)}s` : ', already current'}`);
  if (build.staleServed) put('          and it is STALE: --no-build was given, so the guest gets the previous one.');
}
if (!LOOPBACK) {
  put(`  also    http://${MDNS}:${PORT}/${ROOM ? `?room=${ROOM}` : '?mp=1'}`);
  put('          Mac to Mac. This name follows the machine across a DHCP lease');
  put('          change; the numbers above do not.');
  put(`  on      ${chosen.iface}${chosen.overridden ? ', given with --lan=' : ''}`);
  for (const c of candidates.filter((c) => c.ip !== ADDR)) {
    put(`          not chosen: ${c.ip} (${c.why}) — --lan=${c.ip} to use it instead`);
  }
  put(rule);
  put('  Both machines must be on the same network. Same Wi-Fi is usually enough;');
  put('  a "guest" network, or one with client isolation on, is not — those exist');
  put('  specifically to stop two devices seeing each other, and nothing here can');
  put('  work round that.');
}
put(rule);
if (LOOPBACK) {
  put('  Serving on 127.0.0.1 only. Nothing outside this machine can reach it,');
  put('  and the lobby will withhold the invite link and say so.');
  put('');
  put(`      ${hostUrl}`);
} else if (joinUrl) {
  put(`  Room ${ROOM} is open. Read out this line, or point the other machine's`);
  put('  camera at the square under it. Either one puts them in the room.');
  put('');
  put(`      ${joinUrl}`);
  put('');
  put(`  The code on its own is ${ROOM}, for a phone call.`);
  if (OPEN) put('  Your own browser is opening on this room now.');
  else put(`  Open this room here: ${hostUrl}`);
  /*
   * Which terminals this actually scans in, said where somebody can act on it.
   *
   * Measured over 90 combinations of font, size and line spacing: **85 of them failed to
   * decode.** The square is drawn with U+2588 and friends, and most macOS monospace fonts —
   * SF Mono, which is Terminal.app's default, among them — leave a gap of up to 16% between
   * tiled block glyphs, which breaks the module grid. It scans in terminals that draw block
   * elements geometrically rather than from the font: iTerm2, kitty, Ghostty, WezTerm and VS
   * Code. So the line above comes first and is the one to rely on, and this says plainly that
   * the square is the convenience rather than the contract.
   */
  put('  If the square below will not scan, that line always works: most fonts leave');
  put('  gaps between block characters. iTerm2, Ghostty, kitty, WezTerm and VS Code');
  put('  draw them solid; Terminal.app\'s default font does not.');
  if (showQr) {
    /*
     * **Last.** The square is the thing to point a camera at, and a terminal leaves the last
     * thing it printed on the screen. With the square in the middle this command printed 55
     * lines of which 22 came after it, so on an 80x24 window it had scrolled off the top by
     * the time the command settled — a symbol that fits and cannot be seen.
     *
     * Both servers are up by this line and the room is open, so nothing here may be fatal.
     * `--lan=` accepts whatever it is given, and `qrEncode` throws by name past 213 bytes;
     * a command that has done its job must not die printing a decoration.
     */
    put('');
    try {
      for (const line of qrHalfBlocks(qrEncode(joinUrl)).split('\n')) put(`  ${line}`);
      qrEnd = out.length;
    } catch (err) {
      put(`  (no square: ${err?.message ?? err})`);
    }
  }
} else {
  put('  The relay would not open a room, so there is no code and no square to');
  put('  print. The lobby still works — press CREATE A ROOM there:');
  put('');
  put(`      ${lobbyUrl}`);
}
put('');
put('  Ctrl-C stops both.');

/** Lines printed after the last row of the square. The square must survive an 80x24 window. */
const linesAfterQr = qrEnd < 0 ? 0 : out.length - qrEnd;

if (JSON_OUT) {
  console.log(JSON.stringify({
    tc: 'host-lan', ok: !!(gameOk && relayOk), bind: BIND, lan: ADDR,
    iface: chosen?.iface ?? 'lo0', mdns: LOOPBACK ? null : MDNS,
    gamePort: PORT, relayPort: RELAY_PORT, gameUrl, lobbyUrl, relayUrl,
    room: ROOM, joinUrl, hostUrl, qr: showQr,
    served: DEV ? 'dev' : 'static', build,
    lines: out.length, linesAfterQr,
    plaque, alternatives: candidates.filter((c) => c.ip !== ADDR),
    node: process.execPath, pid: process.pid,
  }));
} else {
  for (const line of out) say(line);
}

if (!gameOk || !relayOk) {
  console.error(`\n${!gameOk ? `The game did not answer at ${gameUrl}. ` : ''}`
    + `${!relayOk ? `The relay did not answer at ${relayUrl}. ` : ''}`
    + '\nThe bind reports success but the address does not respond, which usually means'
    + `\n${ADDR} is not this machine's address on the network it is actually on.`
    + '\nRun with --json to see every interface, or pass --lan= to pick one.');
  stop(1);
}

/*
 * The host's own browser, on the room this command just opened.
 *
 * `hostUrl` and not `lobbyUrl`: see the note above `/new`. A browser landing on an empty form
 * would let the host mint a *second* room with one press, and the code in this terminal — and
 * in the square above it, and in whatever the guest has already scanned — would then be a room
 * nobody is in. The two must be the same room by construction, and they are because one of
 * them was minted first and the other is told which.
 */
if (OPEN) {
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  spawn(opener, [hostUrl], { stdio: 'ignore', detached: true }).unref();
}

/*
 * Nothing after this. `startVite`'s child and the relay both hold the event loop open through
 * their pipes, and both watch this PID and exit when it goes — so a `kill -9` here still leaves
 * a bounded orphan lifetime rather than a listener owned by nobody.
 */
