#!/usr/bin/env node
/**
 * QA: two clients, one relay, one battle — driven through the real menu with a real mouse.
 *
 * Usage: node tools/qa-net.mjs [--port=5937] [--relay=5989] [--json=path] [--shots=dir]
 *                              [--only=proto,battle,siege,lobby,lan,dev,static,badcode,norelay,
 *                                      drop,dup,swap,ulp,late,leave,lag,xengine]
 *                              [--lan-port=5938] [--lan-relay=5984]
 *                              [--dev-port=5939] [--static-port=5940]
 *                              [--all] [--seconds=70] [--keep] [--xsize=ultra] [--xticks=1500]
 *
 * Sixteen arms by default. `xengine` — two full-scale battles in two browser engines — is
 * opt-in; see `DEFAULT_ARMS`.
 *
 * An unknown flag, or an unknown `--only=` arm, exits 2 rather than quietly running nothing —
 * `tools/qa-replay.mjs` explains why at length and the reason is that this project has shipped
 * a gate that could be pointed at nothing and still report success.
 *
 * ## What this is for
 *
 * `tools/qa-replay.mjs` proves one machine replays its own battle. It is structurally unable to
 * say anything about two machines, because both of its runs are the same page. This boots two
 * browser contexts against one relay, drives both through the front door with real mouse
 * events, has both players lay out an army and fight, and then demands that:
 *
 *   - every checkpoint the two clients exchanged agreed, bit for bit, on all four layers;
 *   - both clients end at the same tick with the same pool hash, `uf64`, `uctl` and survivors;
 *   - both clients' *merged order logs* are byte-identical, which is the claim that the relay
 *     delivered one total order and not two;
 *   - and `BattleFlow.result` is the same battle.
 *
 * ## And then it breaks it on purpose, six ways
 *
 * A gate that has never gone red is a decoration. `tools/relay.mjs --fault=` corrupts one
 * client's view of the canonical stream, and each of the four corruptions is a real relay
 * failure: a lost frame (`drop`), a retransmit that was not idempotent (`dup`), a reordering
 * across a coalescing proxy (`swap`), and — the one that matters most — a **one-ULP
 * perturbation of a `UnitGroupState` float64 field** (`ulp`), which is the magnitude
 * `docs/MULTIPLAYER.md` §1.4 measured for a real libm disagreement. Two more break the session
 * rather than the stream: a third client arriving mid-battle, and a client vanishing.
 *
 * Every one of those arms **fails if the session does not notice**. There is no arm here whose
 * pass condition is "nothing happened".
 *
 * ## And the lobby, which for weeks it could not see
 *
 * Every arm listed above waits for `phase === 'battle'` before it asserts anything, and
 * `bootMatch` gets there by writing `?net=…&room=…` itself. So for as long as this file has
 * existed, **not one check had ever loaded `?mp=1`** — the page a player actually starts from,
 * which was meanwhile unusable by a mouse in three separate ways and had a CREATE A ROOM button
 * that had never once succeeded. Thirty-eight green checks behind a door nobody could open.
 *
 * `lobby`, `badcode` and `norelay` close that. The first types a code and presses the buttons;
 * the other two press them at a room nobody opened and at an address nothing is listening on,
 * and pass only if the failure is *named*, with a way out, and without a `pageerror`.
 *
 * ## And the address, which every arm above quietly assumed
 *
 * Every one of them runs on `127.0.0.1`, and so did both defaults in the product: Vite's config
 * says `host: '127.0.0.1'` and the relay's `listen` said the same. So the whole gate — 54
 * checks, two clients, five injected faults — had been measuring a two-player game that only
 * one machine could reach, and reporting it green.
 *
 * `lan` runs `tools/host-lan.mjs`, asks for the game and the relay **at the address that
 * command prints** rather than at loopback, has the lobby build an invite out of it, and gives
 * the second client nothing but that link. Its last check is the one that matters most: with no
 * LAN server, the link is still withheld and still says why. See the arm.
 *
 * ## And which server sent the page, because the lobby now answers differently to each
 *
 * The relay address used to be a field the player was expected to look at, filled in by a
 * *guess* — `ws://<whatever host served this page>:5959` — which is right under `npm run host`
 * and points at nothing under `npm run dev`. Three arms hold the three answers apart, and each
 * of them asserts which document it was actually given rather than inferring it:
 *
 *   - `lan`     served by `npm run host`, relay live: no address on screen, no refusal, and
 *               `lan-lobby-says-nothing-about-transport` goes red if one comes back.
 *   - `dev`     `"dev": "vite"`'s own binary, no relay: empty field, behind a disclosure, and a
 *               refusal naming `npm run host`. Then it types a relay's address into that
 *               disclosure and opens a room, so the demotion is not a deletion.
 *   - `static`  a non-loopback origin that has said nothing about itself, which is the deployed
 *               site's shape. Same refusal, different sentence, and the origin is in the pass
 *               condition — see the arm on why that is not a formality.
 *
 * ## Ports
 *
 * 5937 for vite and 5985-5999 for the relays. Never 5173. The relay band is deliberately at
 * the very top of the 5900s because six other agents' vite servers were scattered through the
 * rest of it, and one of them took a port between two runs of the same arm — which is why
 * `startRelay` reads the response body rather than trusting a 200, and why the tree-identity
 * check below reads a string literal out of the bundle before anything is measured.
 *
 * ## The browser budget: two clients are two slots
 *
 * Added 22 Aug 2026, when the cap in `tools/lib/browser-budget.mjs` landed on `main` after this
 * file was written. The first version booted **both** clients as two pages of one Chromium, and
 * that would have passed the cap while costing the machine two of everything that matters —
 * two renderer processes, two WebGL contexts, two 8,632-man battles. `check-browser-budget`
 * says so itself under "not covered": *a tool that takes one slot and then opens ten contexts
 * inside it.* Counting one there would have been the budget lying on this file's behalf.
 *
 * So the host and the challenger each get their own `launchBrowser`, and this gate holds **two
 * of the four slots** for as long as it runs. `--only=xengine` swaps the challenger's Chromium
 * for a Firefox and peaks at three. Anything else on this machine queues behind it, which is
 * the intended behaviour and not a fault: `node tools/browsers.mjs` says who is holding what.
 *
 * The exit handlers below are installed **before** the first slot is taken, on purpose. The
 * budget installs its own `uncaughtException` hook when it takes a slot, and node runs those
 * listeners in registration order — register second and its `process.exit(1)` fires first and
 * this file's relays are never killed.
 */

import { launchBrowser } from './lib/browser-budget.mjs';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { lanAddress } from './lib/lan-address.mjs';
import { bootThroughMenu, driveMenu, ensureServer, waitForServer } from './lib/menu-boot.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const ARMS = ['proto', 'battle', 'siege', 'lobby', 'lan', 'dev', 'static', 'badcode', 'norelay',
  'drop', 'dup', 'swap', 'ulp', 'late', 'leave', 'lag', 'xengine'];
/**
 * `xengine` is opt-in, and that is a judgement rather than an omission.
 *
 * It runs two full-scale battles in two different browser engines at once, and Firefox
 * software-rendering 8,632 soldiers is the most expensive thing in this repository. On a shared
 * machine — six other agents' Playwright runs had the load average at 144 while this was being
 * written — it times out on `page.goto`, and **a gate that goes red because the laptop is busy
 * teaches people to ignore it**. What it measures is cross-engine determinism, which
 * `tools/qa-determinism.mjs` owns and asserts against pinned hashes; what this file uniquely
 * owns is the *session*, and the `ulp` arm covers detect-attribute-end with a real one-ULP
 * fault that costs nothing.
 *
 * Run it deliberately, on a quiet machine: `--only=xengine`, or `--all`.
 */
const DEFAULT_ARMS = ARMS.filter((a) => a !== 'xengine');
const FLAGS = ['port', 'relay', 'json', 'shots', 'only', 'seconds', 'keep', 'xsize', 'xticks',
  'all', 'siege-map', 'siege-scenario', 'siege-seconds', 'lan-port', 'lan-relay', 'dev-port',
  'static-port'];

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
const ONLY = args.get('only') ?? null;
if (ONLY) {
  const unknown = ONLY.split(',').filter((a) => !ARMS.includes(a));
  if (unknown.length) {
    console.error(`unknown arm(s) in --only: ${unknown.join(', ')}`);
    console.error(`known arms: ${ARMS.join(', ')}`);
    process.exit(2);
  }
}
const PORT = Number(args.get('port') ?? 5937);
const RELAY_PORT = Number(args.get('relay') ?? 5989);
const SECONDS = Number(args.get('seconds') ?? 70);
const JSON_OUT = args.get('json') ?? null;
const SHOT_DIR = args.get('shots') ? path.resolve(ROOT, args.get('shots')) : null;
const KEEP = args.has('keep');
/*
 * The cross-engine arm wants the *big* battle, and separately from the rest.
 *
 * The escape `docs/MULTIPLAYER.md` §1.1 measured at t+205.5 is on the 8,632-man field battle,
 * and the mechanism is a stochastic boundary crossing (§7.2) — so the number of men is the
 * number of chances for one to happen. A 2,337-man battle ran bit-identically in Chromium and
 * Firefox to t+300 on the first attempt, which is a real result and is *not* evidence that the
 * pairing holds at full scale.
 */
const XSIZE = args.get('xsize') ?? 'ultra';
const XTICKS = Number(args.get('xticks') ?? 1500);
/*
 * The siege arm's map, and why it is `campus-martius` rather than `carthage`.
 *
 * Both ship an `assault`, and either would exercise the wall systems. Rome is the one whose
 * `(map, scenario)` pair is *also* pinned in `tools/determinism-baseline.json`, so when this
 * arm and `qa-determinism.mjs --battle="map=campus-martius&scenario=assault"` disagree about
 * the same battle there is a second instrument to ask. Carthage has no such counterpart here.
 * `--siege-map=carthage` runs the other one.
 */
const SIEGE_MAP = args.get('siege-map') ?? 'campus-martius';
/*
 * `--siege-scenario` exists so that `net-coverage` can be made to go red.
 *
 * It is a real knob — it points this arm at any `(map, scenario)` the product ships — but the
 * reason it is spelled out rather than hard-coded to `assault` is the standing rule that a
 * check nobody can make fail has not been tested. Run
 * `--only=battle,siege --siege-scenario=field` and both matches are field battles, so the
 * coverage claim is false and the check that guards it says so by name.
 */
const SIEGE_SCENARIO = args.get('siege-scenario') ?? 'assault';
const SIEGE_SECONDS = Number(args.get('siege-seconds') ?? 45);
/*
 * The `lan` arm's own pair of ports, outside both bands the rest of this file uses.
 *
 * They cannot be shared with anything: `tools/host-lan.mjs` binds `0.0.0.0`, and a listener on
 * `0.0.0.0` and one on `127.0.0.1` are the same address from this machine and different
 * addresses from the next one. `startVite` refuses to hand a loopback server to a caller who
 * asked for a LAN bind for exactly that reason, and a shared port here would turn that refusal
 * into a red arm about port allocation rather than about the product.
 */
const LAN_PORT = Number(args.get('lan-port') ?? 5938);
const LAN_RELAY = Number(args.get('lan-relay') ?? 5984);
/*
 * The two arms that run `npm run dev`'s own binary get their own ports, for the same reason the
 * `lan` arm does and one more.
 *
 * `startVite` cannot be used for either of them, because what they measure is *the absence of
 * `tools/lib/vite-runner.mjs`*: no `/__tc/tree`, no `<meta name="tc-lan">`, and — the whole
 * point — no `<meta name="tc-relay">`. Reusing the runner would put the tag under test into the
 * document that is supposed to prove what happens without it. So they spawn `vite` directly and
 * cannot share a port with a runner-managed server, which would be refused as an unidentified
 * listener anyway.
 *
 * 5940 binds `0.0.0.0` and is reached at the LAN address; see the `static` arm.
 */
const DEV_PORT = Number(args.get('dev-port') ?? 5939);
const STATIC_PORT = Number(args.get('static-port') ?? 5940);
if (!Number.isFinite(SECONDS) || SECONDS < 20) {
  console.error(`--seconds must be at least 20; got '${args.get('seconds')}'`);
  process.exit(2);
}
if (!Number.isFinite(SIEGE_SECONDS) || SIEGE_SECONDS < 15) {
  console.error(`--siege-seconds must be at least 15; got '${args.get('siege-seconds')}'`);
  process.exit(2);
}
const W = 1280;
const H = 800;
const ALL = args.has('all');
const wanted = (n) => (ONLY ? ONLY.split(',').includes(n) : ALL || DEFAULT_ARMS.includes(n));

const results = [];
const measured = {};
let failed = 0;
function record(name, pass, what, changed, note = '') {
  results.push({ name, pass, what, changed, note });
  if (!pass) failed++;
  console.log(`${pass ? '  PASS' : '  FAIL'}  ${name.padEnd(22)} ${what}`);
  console.log(`        → ${changed}${note ? `  [${note}]` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Servers. Everything this starts, this kills — including on the way out of a throw.
// ---------------------------------------------------------------------------

const relays = [];
/**
 * Start a relay and wait for it to answer.
 *
 * Its own process per fault arm rather than one relay reconfigured, because a `Room` that has
 * already refused a pairing or declared a desync stays refused — that is the correct behaviour
 * and it makes a shared relay a shared fixture between arms. A node process is 40 ms.
 */
async function startRelay(port, extra = [], attempt = 0) {
  /*
   * `pipe`, not `ignore`, and a retry — both earned in one run.
   *
   * `stdio: 'ignore'` threw "relay did not start on 5992" and said nothing else, when the real
   * story was that the previous arm's relay on that port was still inside its SIGTERM while the
   * new one tried to bind, so the new one exited on EADDRINUSE and the old one had already
   * stopped answering. A gate that cannot say *why* a server did not start is a gate somebody
   * reruns until it works.
   */
  // `--parent`: the relay closes itself within two seconds of losing us. `stop()` below is the
  // normal path; this is the one for the run that is SIGKILLed or the machine that falls over,
  // which would otherwise leave a listener in the band the next run wants, owned by nobody.
  const p = spawn('node', [path.join(ROOT, 'tools', 'relay.mjs'), `--port=${port}`,
    `--parent=${process.pid}`, ...extra],
  { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  p.stderr?.on('data', (d) => { stderr += String(d); });
  relays.push(p);
  /*
   * Wait for *this relay*, not for "something answering on that port".
   *
   * `waitForServer` accepts any 2xx, and a vite dev server answers 200 with `index.html` for
   * every unknown path — so a port already held by another agent's server passes that check and
   * the arm then opens WebSockets against a game bundle. Six of those were on the 5900s while
   * this was being written and one of them took a port between two runs of the same arm. The
   * body says `relay ok`; nothing else does.
   */
  const end = Date.now() + 15000;
  let ok = false;
  while (Date.now() < end && !ok) {
    const body = await fetch(`http://127.0.0.1:${port}/health`)
      .then((r) => r.text()).catch(() => '');
    if (body.startsWith('relay ok')) ok = true;
    else if (body) throw new Error(`port ${port} is answering, but not as a relay: `
      + `'${body.slice(0, 60).replace(/\s+/g, ' ')}' — somebody else's server has it`);
    else await sleep(200);
  }
  if (!ok) {
    const at = relays.indexOf(p);
    if (at >= 0) relays.splice(at, 1);
    try { p.kill('SIGKILL'); } catch { /* already gone */ }
    if (attempt < 2) {
      console.log(`  relay on ${port} did not come up (${stderr.trim().slice(0, 80) || 'no output'})`
        + `; retrying in 1.5 s`);
      await sleep(1500);
      return startRelay(port, extra, attempt + 1);
    }
    throw new Error(`relay did not start on ${port} after 3 attempts: `
      + `${stderr.trim().slice(0, 200) || 'it printed nothing'}`);
  }
  /*
   * Each relay stops itself, and there is no blanket "stop them all" inside an arm.
   *
   * There was, and it cost two arms. `late` and `leave` reuse the long-running match the
   * `battle` arm left open, and the four fault arms in between each ended by killing *every*
   * relay — so the third client found nothing to be refused by and the survivor was never told
   * its peer had gone. Both arms passed in isolation and failed in the full run, which is the
   * shape of bug a gate is supposed to have none of.
   */
  const stop = () => {
    const at = relays.indexOf(p);
    if (at >= 0) relays.splice(at, 1);
    try { p.kill('SIGTERM'); } catch { /* already gone */ }
  };
  return { port, base: `ws://127.0.0.1:${port}`, http: `http://127.0.0.1:${port}`, proc: p, stop };
}
const stopRelays = () => { for (const p of relays.splice(0)) { try { p.kill('SIGTERM'); } catch { /* gone */ } } };

/**
 * `tools/host-lan.mjs` processes, which own *two* listeners each and must be reaped as one.
 *
 * Kept separate from `relays` because the handle here is the host command, not either server:
 * it spawns a relay and a `vite-runner`, both of them watching its PID, so a SIGTERM to this
 * one and a two-second wait is the whole shutdown. Splitting them into `relays` would kill the
 * relay and leave a Vite on a LAN port with nobody's name on it.
 */
const hosts = [];
const stopHosts = () => { for (const p of hosts.splice(0)) { try { p.kill('SIGTERM'); } catch { /* gone */ } } };

/**
 * Start `npm run host`'s tool and read the line it prints about itself.
 *
 * `--json` rather than parsing the human block, and `--no-open` because a gate must never put
 * a browser window on the owner's screen. The JSON is the arm's whole view of what the command
 * decided: the address, the interface, the two ports, and whether both of them answered *at
 * that address* rather than at loopback.
 */
async function startHostLan(port, relayPort) {
  const p = spawn('node', [path.join(ROOT, 'tools', 'host-lan.mjs'),
    `--port=${port}`, `--relay-port=${relayPort}`, '--json', '--no-open'],
  { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  hosts.push(p);
  let out = '';
  let err = '';
  p.stdout.on('data', (d) => { out += String(d); });
  p.stderr.on('data', (d) => { err += String(d); });
  const end = Date.now() + 150000;
  let said = null;
  while (Date.now() < end && !said) {
    const m = out.match(/^\{.*\}$/m);
    if (m) { try { said = JSON.parse(m[0]); } catch { /* half a line */ } }
    if (!said && p.exitCode !== null) break;
    if (!said) await sleep(300);
  }
  const stop = () => {
    const at = hosts.indexOf(p);
    if (at >= 0) hosts.splice(at, 1);
    try { p.kill('SIGTERM'); } catch { /* already gone */ }
  };
  if (!said) {
    stop();
    throw new Error(`host-lan did not report itself on ${port}/${relayPort}: `
      + `${(err || out).trim().slice(0, 400) || 'it printed nothing'}`);
  }
  return { ...said, proc: p, stop, stderr: () => err };
}

/**
 * `node_modules/vite/bin/vite.js`, found by walking up from whatever `vite` resolves to.
 *
 * Not joined onto `ROOT`: an agent worktree has no `node_modules` of its own and reaches the
 * main checkout's through node's resolution, so a path built from `ROOT` names a file that does
 * not exist and the arm dies with `MODULE_NOT_FOUND`. Not `require.resolve('vite/bin/vite.js')`
 * either — vite's `exports` map does not publish the bin, and that throws too.
 */
const VITE_BIN = (() => {
  let d = path.dirname(createRequire(import.meta.url).resolve('vite'));
  while (path.basename(d) !== 'vite' && d !== path.dirname(d)) d = path.dirname(d);
  return path.join(d, 'bin', 'vite.js');
})();

const vites = [];
const stopVites = () => {
  for (const p of vites.splice(0)) {
    try { process.kill(-p.pid, 'SIGTERM'); } catch {
      try { p.kill('SIGTERM'); } catch { /* gone */ }
    }
  }
};

/**
 * `npm run dev`, as itself, for the two arms whose subject is what that command *does not* do.
 *
 * Every other server in this file comes from `tools/lib/browser-budget.mjs`'s `startVite`, and
 * that is right for every other arm. It is wrong for these two: `startVite` runs
 * `tools/lib/vite-runner.mjs`, which writes `<meta name="tc-relay">` into the document whenever
 * it was told a relay port and `<meta name="tc-lan">` on a LAN bind. What `dev` and `static`
 * measure is the lobby's behaviour in a document with **neither tag in it**, which is what a
 * player gets from `npm run dev` and from the deployed upload, so the runner cannot be the
 * thing under test and the thing providing the fixture at once.
 *
 * `package.json` says `"dev": "vite"`, so this is that binary with a port on it. Spawned as
 * `node <bin>` rather than through `npm` or `npx` for the reason `vite-runner.mjs` opens with:
 * the wrapper's PID is not the PID holding the port, and SIGTERM to a wrapper leaves a server
 * running for a day. `detached: true` puts it in its own group so `kill(-pid)` takes it and
 * anything it spawned; `stopVites` runs from `cleanup()`, which runs from both the ordinary
 * exit and `unhandledRejection`.
 *
 * Its own `TC_VITE_CACHE_DIR` per port because `vite.config.ts` spends a paragraph on two
 * servers sharing one optimiser cache through a worktree's `node_modules` symlink, and the
 * failure that produces is a page that loads perfectly while serving another branch's modules.
 */
function startDevVite(port, extra = []) {
  const p = spawn(process.execPath,
    [VITE_BIN, '--port', String(port), '--strictPort', ...extra],
    {
      cwd: ROOT,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, TC_NO_HMR: '1', TC_VITE_CACHE_DIR: `/tmp/tc-qanet-dev-${port}` },
    });
  vites.push(p);
  let log = '';
  p.stdout.on('data', (d) => { log += String(d); });
  p.stderr.on('data', (d) => { log += String(d); });
  const stop = () => {
    const at = vites.indexOf(p);
    if (at >= 0) vites.splice(at, 1);
    try { process.kill(-p.pid, 'SIGTERM'); } catch {
      try { p.kill('SIGTERM'); } catch { /* gone */ }
    }
  };
  return { proc: p, port, stop, log: () => log };
}

/*
 * Cleanup first, resources second — and that ordering is the whole point.
 *
 * `ensureServer` takes the first budget-managed resource in this file, and taking one installs
 * `browser-budget.mjs`'s own `uncaughtException` handler. Node runs those listeners in the
 * order they were registered and the budget's ends in `process.exit(1)`, so anything
 * registered after it never runs. This block used to sit below the first `chromium.launch`;
 * there it was dead code on exactly the paths it existed for.
 */
const browsers = [];
let server = null;
function cleanup() {
  stopRelays();
  stopHosts();
  stopVites();
  for (const b of browsers.splice(0)) { void b.close().catch(() => { /* already gone */ }); }
  if (server && !KEEP) server.kill('SIGTERM');
}
/*
 * Both handlers, and the second one is the one that was missing.
 *
 * A `throw` inside this file's top-level `await` is an **unhandled rejection**, not an uncaught
 * exception — so when Firefox timed out on `page.goto`, `cleanup()` never ran and two browsers
 * and a relay were left holding CPU on a machine that already had six other agents on it. An
 * agent that starts a server owns killing it, and that has to include the paths where it fails.
 */
const die = (e) => { console.error(e); cleanup(); process.exit(1); };
process.on('uncaughtException', die);
process.on('unhandledRejection', die);

const startedServer = await ensureServer({
  port: PORT,
  root: ROOT,
  cacheDir: path.join(ROOT, '.vite-cache', `qa-net-${PORT}`),
});
const base = startedServer.base;
server = startedServer.server;
console.log(`server ${base}${server ? ' (started here)' : ' (already up)'}`);
/*
 * Tree identity, before anything is measured.
 *
 * `ensureServer` reuses a listener that is already on the port, and with several agents live
 * that listener may be serving somebody else's branch — `docs/MAP-METHOD.md` §3 records a
 * determinism pin recorded against another agent's tree from exactly this. `src/net/room.ts`
 * exists only here, so fetching it off the server under test is a one-request proof that the
 * server is standing in this worktree.
 */
{
  const probe = await fetch(`${base}/src/net/protocol.ts`).then((r) => r.text()).catch(() => '');
  // A *string literal*, not a comment. Vite's transform keeps `protocol.ts`'s leading JSDoc and
  // drops `room.ts`'s, which is the kind of difference a marker must not depend on. The room
  // code alphabet is a value the module cannot run without.
  if (!probe.includes('ABCDEFGHJKLMNPQRSTUVWXYZ23456789')) {
    console.error(`\nThe server on ${PORT} is not serving this worktree — no src/net/protocol.ts.`);
    console.error('Kill it, or pass --port= for one nobody else is using. Measuring another');
    console.error("agent's tree is how a pin gets recorded against a branch nobody chose.");
    if (server) server.kill('SIGTERM');
    process.exit(2);
  }
}
if (SHOT_DIR) await mkdir(SHOT_DIR, { recursive: true });

/*
 * One browser per client, two slots, and the GPU flags come from the budget.
 *
 * `launchBrowser` defaults `--use-gl=angle --use-angle=metal --enable-unsafe-swiftshader
 * --ignore-gpu-blocklist` and merges `args` on top, so the four that used to be spelled out
 * here are gone and cannot drift from the rest of the repository. Without `--use-angle=metal`
 * Chromium rasterises this scene in SwiftShader — minutes per boot, silently.
 */
const chrome = await launchBrowser({
  label: 'qa-net/host', engine: 'chromium', args: ['--hide-scrollbars'], port: PORT, root: ROOT,
});
browsers.push(chrome);
const chromeGuest = await launchBrowser({
  label: 'qa-net/guest', engine: 'chromium', args: ['--hide-scrollbars'], port: PORT, root: ROOT,
});
browsers.push(chromeGuest);

// ---------------------------------------------------------------------------
// Page-side readers. Read-only: every order below goes through page.mouse.
// ---------------------------------------------------------------------------

const INSTALL = () => {
  const g = window.__game;
  const ctx = g.engine.context;
  const V = new (ctx.camera.position.constructor)();
  window.__proj = (x, y, z) => {
    V.set(x, y, z).project(ctx.camera);
    if (V.z > 1) return null;
    return { x: (V.x * 0.5 + 0.5) * ctx.viewW, y: (-V.y * 0.5 + 0.5) * ctx.viewH };
  };
  window.__net = () => (g.net ? {
    ...g.net.status(),
    desync: g.net.desync,
    perturbed: g.net.perturbedUnit,
    lastCheckpoint: g.net.lastCheckpoint,
    lat: g.net.latencies(),
  } : null);
  window.__tick = () => g.engine.time.tick;
  /**
   * The tick and the state, in **one** evaluate.
   *
   * Not two, and not three. A live frame lands between a driver's round trips and carries up to
   * `maxStepsPerFrame = 5` ticks with it, so reading the tick and then reading the hash reports
   * the hash of a *different* tick — measured elsewhere in this project as two runs both asked
   * for tick 6,000 and arriving at 6,000 and 6,004. Nothing about that looks like a harness
   * fault from the outside; it looks like the engine being sloppy. One evaluate, one tick.
   */
  window.__mark = () => ({ tick: g.engine.time.tick, sim: g.simTime(), ...g.hashes() });
  window.__rec = () => g.replay.record();
  window.__flow = () => ctx.tryGet('battleFlow')?.result ?? null;
  window.__dep = () => {
    const d = g.deployment;
    return d ? { active: d.active, committed: d.committed, own: d.ownUnits().length } : null;
  };
  window.__bare = () => {
    const out = [];
    for (const fy of [0.42, 0.5, 0.58, 0.36]) {
      for (const fx of [0.3, 0.45, 0.6, 0.7, 0.38]) {
        const x = Math.round(window.innerWidth * fx);
        const y = Math.round(window.innerHeight * fy);
        const el = document.elementFromPoint(x, y);
        if (el && el.id === 'viewport') out.push({ x, y });
      }
    }
    return out;
  };
  /** A regiment of *this client's* faction, projected to the screen, camera parked on it. */
  window.__unitAt = (i) => {
    const mine = g.net ? g.net.myFaction : 0;
    const own = g.battle.units.filter((u) => !u.destroyed && u.faction === mine && u.alive > 0);
    const u = own[i % Math.max(1, own.length)];
    if (!u) return null;
    g.setCamera(u.x, u.z, 0.55, 0);
    const p = g.battle.pool;
    let n = 0, sx = 0, sy = 0, sz = 0;
    for (const k of u.members) {
      if (p.hp[k] <= 0) continue;
      n++; sx += p.x[k]; sy += p.y[k]; sz += p.z[k];
    }
    if (!n) return null;
    const q = window.__proj(sx / n, sy / n + 0.5, sz / n);
    return q ? { id: u.id, ...q } : null;
  };
  window.__selection = () => ctx.tryGet('hud')?.controller.model.selection.slice() ?? [];
};

const newPage = async (browser) => {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const errs = [];
  page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(`console.error: ${m.text()}`); });
  page.__errs = errs;
  return page;
};
const shot = async (page, name) => {
  if (SHOT_DIR) await page.screenshot({ path: path.join(SHOT_DIR, `${name}.png`) });
};

/**
 * What the lobby is showing *about transport*, which is the whole subject of three arms.
 *
 * **`checkVisibility()` and hit-testing, not a bounding box.** Measured while writing this:
 * Chromium gives an `<input>` inside a closed `<details>` a full 550×40 box at a real `y`, so
 * `getClientRects().length` and Playwright's own `isVisible()` both call it visible. It is not:
 * `checkVisibility()` returns false, `elementFromPoint` over the middle of that box returns
 * something else, and `innerText` leaves its label and its hint out. A check written on the
 * rectangle would have passed for a field sitting open on the screen.
 *
 * `text` is `innerText` for the same reason — it is the rendered text, so it is what the player
 * can actually read, which makes `/wss?:\/\//` over it a real claim about what is on screen.
 */
const lobbyFace = (page) => page.evaluate(() => {
  const sheet = document.querySelector('.tc-sheet');
  const relay = document.querySelector('#tc-relay');
  const adv = document.querySelector('#tc-adv');
  const blocked = document.querySelector('#tc-no-relay');
  const shown = (el) => !!el && el.checkVisibility();
  const flat = (el) => (el?.innerText ?? '').replace(/\s+/g, ' ').trim();
  const reaches = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    const t = document.elementFromPoint(Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2));
    return !!t && (t === el || el.contains(t));
  };
  return {
    origin: location.origin,
    // The server's own claims about itself, read back so an arm can prove which fixture it got.
    metaLan: document.querySelector('meta[name="tc-lan"]')?.getAttribute('content') ?? null,
    metaRelay: document.querySelector('meta[name="tc-relay"]')?.getAttribute('content') ?? null,
    text: flat(sheet),
    relayValue: relay ? relay.value : null,
    relayShown: shown(relay),
    relayReaches: reaches(relay),
    advPresent: !!adv,
    advOpen: !!adv?.open,
    blockedShown: shown(blocked),
    blockedText: shown(blocked) ? flat(blocked) : '',
    createDisabled: document.querySelector('#tc-host')?.disabled ?? null,
    joinDisabled: document.querySelector('#tc-join')?.disabled ?? null,
  };
});

/**
 * Open the transport disclosure, the way somebody who wanted it would.
 *
 * A real click on the summary, and then a wait on `details.open` — `page.fill('#tc-relay')`
 * needs the field rendered, and Playwright's actionability check for `fill` correctly refuses a
 * field inside a closed `<details>`. Every arm below that types an address goes through here,
 * which means the demoted capability is exercised by five checks rather than asserted by one.
 */
const openAdvanced = async (page) => {
  await page.click('#tc-adv-summary');
  await page.waitForFunction(() => document.querySelector('#tc-adv')?.open === true,
    null, { timeout: 10000 });
};

// ---------------------------------------------------------------------------
// Booting a match
// ---------------------------------------------------------------------------

let roomSeq = 0;
const nextRoom = () => `QA${String(++roomSeq).padStart(3, '0')}`.slice(0, 5)
  .replace(/0/g, 'Q').replace(/1/g, 'R');

/** Every `(map, scenario)` a match in this run actually stood in. See `net-coverage`. */
const covered = [];

/**
 * Two clients in one room, both booted the way a player boots.
 *
 * The host goes through the front door and the setup sheet with real clicks — `bootThroughMenu`
 * is the same driver `tools/qa-replay.mjs` and the playability rig use, so there is one menu
 * sequence in this repository rather than three that drift. The challenger has no menu: it is
 * given the host's battle over the wire, which is the whole point of `setup` arriving before
 * either client has an army.
 */
async function bootMatch(relay, {
  room = nextRoom(), deploy = true, guestBrowser = chromeGuest, shots = null, size = 'small',
  autoplay = 0, map = 'campus-martius', scenario = 'field',
} = {}) {
  const q = `net=${encodeURIComponent(relay.base)}&room=${room}`
    + `&autoplay=${autoplay}&deploy=${deploy ? 1 : 0}`;
  const host = await newPage(chrome);
  await bootThroughMenu(host, {
    base,
    map,
    scenario,
    tier: 'high',
    size,
    query: q,
    onSetup: shots ? (p) => shot(p, `${shots}-01-setup`) : undefined,
  });
  const guest = await newPage(guestBrowser);
  await guest.goto(`${base}/?${q}&host=0`, { waitUntil: 'domcontentloaded' });
  await guest.waitForFunction(() => window.__game?.ready === true, null, { timeout: 300000 });
  await host.evaluate(INSTALL);
  await guest.evaluate(INSTALL);
  // Both sides in the same phase before anybody clicks anything.
  for (const p of [host, guest]) {
    await p.waitForFunction(
      () => ['deploy', 'battle'].includes(window.__net()?.phase),
      null,
      { timeout: 90000 }
    );
  }
  /*
   * Coverage is read off the **challenger**, and that is the whole point of reading it.
   *
   * What this run asked for is `map`/`scenario` above; what the guest is standing in arrived
   * over the wire in `MsgSetup.cfg`, because the challenger never sees a menu. Recording the
   * argument would prove nothing — recording what the second client actually built proves the
   * config crossed the relay intact, which is the claim, and it is the reading `net-coverage`
   * below is allowed to be satisfied by.
   */
  const got = await guest.evaluate(() => {
    const c = window.__rec()?.cfg;
    return c ? { map: c.map, scenario: c.scenario } : null;
  });
  covered.push(got ?? { map: '(unreadable)', scenario: '(unreadable)' });
  return { host, guest, room, cfg: got };
}

/** Lay out an army with the plaque and the mouse, then press BEGIN BATTLE. */
async function deployWith(page, tag) {
  const d = await page.evaluate(() => window.__dep());
  if (!d?.active) return [];
  const done = [];
  await shot(page, `${tag}-02-deploy`);
  /*
   * Wait for the plaque rather than clicking straight at it.
   *
   * The panel is attached on `deploymentBegan`, which fires inside `boot()` — but the HUD
   * root fades in over two frames and `bootThroughMenu` returns on `window.__game.ready`,
   * which is the frame before that. A bare `page.click` on a page whose plaque has not been
   * attached yet reports "waiting for locator" thirty seconds later and says nothing about
   * which of the two clients it was.
   */
  try {
    await page.waitForSelector('.dep-add', { timeout: 30000 });
  } catch {
    const why = await page.evaluate(() => ({
      hud: document.querySelector('.hud')?.className ?? '(no .hud)',
      dep: window.__dep(),
      net: window.__net(),
      panels: Array.from(document.querySelectorAll('.hud > *')).map((e) => e.className),
    }));
    throw new Error(`${tag}: no deployment plaque — ${JSON.stringify(why)}`);
  }
  await page.click('.dep-add');
  await sleep(220);
  /*
   * The first row whose `+` is *enabled*, not simply the first row.
   *
   * This cost the siege arm its first run and it is the second time this repository has paid
   * for it. `tools/lib/menu-boot.mjs` says it at length: a bare `page.click` on a disabled
   * button waits thirty seconds and then throws, and it stopped `qa-replay`'s matrix arm dead
   * on its second battle. The identical hazard was sitting here, invisible, because every arm
   * in this file booted `campus-martius / field` — where every row can be added to. On the
   * assault the establishment is fixed and `tower-assault`'s `+` ships disabled, so the driver
   * hung on the challenger and took the arm out with a `TimeoutError` naming a locator.
   *
   * Skipped rather than fatal: "this battle does not let you buy another one of those" is a
   * fact about the product. But it is *recorded* — a driver that quietly declines to do what
   * it was asked is how six playability scripts spent two days unable to reach a setup sheet.
   */
  const rows = await page.evaluate(() => Array.from(document.querySelectorAll('.dep-row'))
    .map((r) => ({
      unit: r.dataset.unit,
      addable: !r.querySelector('[data-d="1"]')?.disabled,
    })));
  const addable = rows.find((r) => r.addable);
  if (addable) {
    await page.click(`.dep-row[data-unit="${addable.unit}"] [data-d="1"]`);
    done.push(`palette +1 ${addable.unit}`);
    await sleep(320);
  } else if (rows.length) {
    done.push(`palette +1 skipped (all ${rows.length} rows at their establishment)`);
  }
  const cards = await page.$$('.cardbar .card:not(.foe)');
  if (cards.length) {
    const box = await cards[0].boundingBox();
    if (box) { await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2); await sleep(260); }
  }
  const spots = await page.evaluate(() => window.__bare());
  if (spots.length >= 2) {
    await page.mouse.move(spots[0].x, spots[0].y);
    await sleep(140);
    await page.mouse.down({ button: 'right' });
    await page.mouse.move(spots[1].x, spots[1].y, { steps: 8 });
    await sleep(200);
    await page.mouse.up({ button: 'right' });
    await sleep(420);
    done.push('right-drag place');
  }
  /*
   * BEGIN, and a legible error rather than another thirty-second locator timeout.
   *
   * Same lesson as the palette row above: if this button is ever disabled — an army below its
   * minimum, a phase that has already ended under us — a bare click reports a selector and
   * nothing about which client, which battle or why. Ask first, and say all three.
   */
  const beginState = await page.evaluate(() => {
    const b = document.querySelector('.dep-begin');
    return b ? { present: true, disabled: !!b.disabled } : { present: false, disabled: false };
  });
  if (!beginState.present || beginState.disabled) {
    const why = await page.evaluate(() => ({ dep: window.__dep(), net: window.__net() }));
    throw new Error(`${tag}: BEGIN BATTLE is ${beginState.present ? 'disabled' : 'absent'}`
      + ` after ${done.length} gesture(s) — ${JSON.stringify(why)}`);
  }
  await page.click('.dep-begin');
  done.push('BEGIN BATTLE');
  await sleep(400);
  return done;
}

/** One burst of orders: select a regiment, move it, change its gait. */
async function burst(page, i) {
  let u = null;
  for (let k = 0; k < 4 && !u; k++) {
    await page.evaluate((n) => window.__unitAt(n), i * 3 + k);
    await sleep(200);
    const qq = await page.evaluate((n) => window.__unitAt(n), i * 3 + k);
    if (qq && qq.x > 40 && qq.x < W - 40 && qq.y > 180 && qq.y < H - 220) u = qq;
  }
  if (!u) return [];
  const acts = [];
  await page.mouse.move(u.x, u.y);
  await sleep(160);
  await page.mouse.click(u.x, u.y);
  await sleep(240);
  const sel = await page.evaluate(() => window.__selection());
  if (!sel.length) return acts;
  acts.push(`select ${sel.join(',')}`);
  const spots = await page.evaluate(() => window.__bare());
  if (spots.length) {
    const p = spots[(i + 1) % spots.length];
    await page.mouse.move(p.x, p.y);
    await sleep(110);
    await page.mouse.down({ button: 'right' });
    await sleep(190);
    await page.mouse.up({ button: 'right' });
    await sleep(260);
    acts.push('right-click move');
  }
  await page.keyboard.press('KeyR');
  await sleep(180);
  acts.push('R gait');
  return acts;
}

/**
 * Two move orders on the same regiment, fast enough to land in one 100 ms turn.
 *
 * The `swap` arm needs exactly this and nothing else will do: `applyOrder` mutates only the
 * units an order names, so two orders on *different* regiments commute and exchanging them
 * proves nothing. §4.1's claim is about two orders touching one unit, and two right-clicks a
 * few tens of milliseconds apart on one selection is what a player does when they change their
 * mind — which is also, not coincidentally, the gesture that a reordering breaks.
 */
async function doubleOrder(page, i) {
  let u = null;
  for (let k = 0; k < 4 && !u; k++) {
    await page.evaluate((n) => window.__unitAt(n), i * 2 + k);
    await sleep(200);
    const qq = await page.evaluate((n) => window.__unitAt(n), i * 2 + k);
    if (qq && qq.x > 40 && qq.x < W - 40 && qq.y > 180 && qq.y < H - 220) u = qq;
  }
  if (!u) return false;
  await page.mouse.click(u.x, u.y);
  await sleep(240);
  const sel = await page.evaluate(() => window.__selection());
  if (!sel.length) return false;
  const spots = await page.evaluate(() => window.__bare());
  if (spots.length < 2) return false;
  /*
   * Three, not two, and 25 ms apart.
   *
   * The relay closes a turn every 100 ms, and two clicks straddling a boundary land in two
   * different turns — at which point there is no pair in one packet for the swap to exchange
   * and the arm passes by never having fired. Three clicks inside 75 ms cannot all straddle
   * one boundary, so at least two of them share a turn whatever the phase of the relay's clock.
   */
  for (const p of [spots[0], spots[1], spots[0]]) {
    await page.mouse.move(p.x, p.y);
    await page.mouse.down({ button: 'right' });
    await sleep(25);
    await page.mouse.up({ button: 'right' });
    await sleep(25);
  }
  return true;
}

/** Wait until both clients sit on the same tick, or the session ends. Never longer than `ms`. */
async function settleTogether(host, guest, ms = 40000, relay = null) {
  /*
   * Stop the relay's turn clock before asking whether the two clients agree.
   *
   * They never go static on their own: the relay closes a turn every 100 ms for as long as it is
   * running, so both clients keep advancing and "poll until the two ticks are equal and
   * unchanged" is a race that this arm won for four runs and then lost — reporting ticks 2,615
   * and 2,638 as a failed comparison while the relay's own checkpoint stream had agreed all the
   * way to 2,640. The clients were right and the instrument was wrong.
   *
   * SIGSTOP rather than a protocol message, because the protocol should not grow a pause verb
   * for a test's convenience. SIGCONT afterwards, because the `late` and `leave` arms reuse
   * this match.
   *
   * ## And one SIGSTOP is not enough, which cost this arm two red runs on a busy machine
   *
   * The paragraph that used to be here said the two clients "drain to the ceiling of the same
   * last turn and stop there, at the same tick, by construction rather than by luck", on the
   * grounds that SIGSTOP stops the process and not the kernel's socket buffers. That is true of
   * the *kernel's* buffer and false of node's. `sock.write` returns false when the kernel buffer
   * is full and node queues the remainder in the process; a frozen process never flushes it. The
   * two sockets fill at different rates, because the two pages read at different rates, so a
   * relay frozen mid-backlog can leave one client holding three turns the other will now never
   * receive — and no amount of waiting converges them, because the thing that would send them
   * is stopped.
   *
   * Measured on this tree, four runs of `--only=battle` on a machine at load 4: two settled
   * (2,106 and 2,115, every layer identical) and two reported *"they stopped at different
   * ticks: 2,112 and 2,117"* — with `checkpoints-agreed` green in both failures and no hash
   * ever compared, because the comparison never got that far. A red that means "the laptop was
   * busy" is the thing this file's own header says teaches people to ignore a gate.
   *
   * So when both clients have gone static *and are apart*, the relay is let go for a quarter of
   * a second and stopped again. That flushes whatever was stuck to whichever client was short,
   * and the next stop finds them level. Bounded, because a loop that could run for ever is a
   * different way to fail. The comparison itself is untouched: equal ticks are still required
   * and the five layers are still compared bit for bit.
   */
  const stop = () => { try { relay?.proc.kill('SIGSTOP'); } catch { /* already gone */ } };
  const go = () => { try { relay?.proc.kill('SIGCONT'); } catch { /* already gone */ } };
  stop();
  const t0 = Date.now();
  let last = [-1, -2];
  let nudges = 0;
  while (Date.now() - t0 < ms) {
    const a = await host.evaluate(() => window.__mark().tick);
    const b = await guest.evaluate(() => window.__mark().tick);
    const na = await host.evaluate(() => window.__net());
    if (a === b && a === last[0] && b === last[1]) {
      go();
      return { tick: a, ended: na?.ended ?? '', nudges };
    }
    if (na?.ended) {
      // An ended session stops moving; one more read confirms it.
      await sleep(400);
      const a2 = await host.evaluate(() => window.__tick());
      const b2 = await guest.evaluate(() => window.__tick());
      go();
      return { tick: Math.min(a2, b2), ended: na.ended, apart: a2 !== b2, nudges };
    }
    // Both static, and apart: the laggard is missing turns nothing is going to send it.
    if (a !== b && a === last[0] && b === last[1] && nudges < 6) {
      nudges++;
      go();
      await sleep(250);
      stop();
      last = [-1, -2];
      continue;
    }
    last = [a, b];
    await sleep(350);
  }
  const a = await host.evaluate(() => window.__tick());
  const b = await guest.evaluate(() => window.__tick());
  go();
  return { tick: Math.min(a, b), ended: '', timedOut: true, apart: a !== b, nudges };
}

/** Both clients' final state, for comparison. */
async function readBoth(host, guest) {
  const rd = async (p) => {
    // The tick and the hashes together, in one evaluate: see `__mark`. Reading them separately
    // lets a live frame put five ticks between the number and the state it is supposed to
    // describe, and the comparison below is bit-for-bit.
    const mark = await p.evaluate(() => window.__mark());
    return {
      net: await p.evaluate(() => window.__net()),
      tick: mark.tick,
      simTime: mark.sim,
      hashes: mark,
      rec: await p.evaluate(() => window.__rec()),
      flow: await p.evaluate(() => window.__flow()),
      errs: p.__errs.slice(),
    };
  };
  return { a: await rd(host), b: await rd(guest) };
}

/** First event that differs between two merged order logs, spelled out. */
/**
 * Are these two clients at the same tick of the same battle?
 *
 * Returns `null` when they are, and the term that failed when they are not — because a
 * comparison of six things that prints only four of them costs an hour the first time it goes
 * red, and it did.
 *
 * **`simTime` is deliberately *not* compared across the two clients.** It used to be, with the
 * reasoning that "equal hashes at unequal sim times would mean the comparison had been taken at
 * two moments". That reasoning is sound and the implementation did not follow from it.
 * `Time.beginFrame` accumulates `simTime += steps * fixedDt`, so the value depends on how the
 * frame loop *grouped* its ticks — five in one frame or one in five — and float addition is not
 * associative. Two clients that ran the identical 1,365 ticks therefore hold sim times
 * 3.6e-14 apart whenever the machine paced their frames differently, which is whenever the
 * machine is busy. Measured on the siege arm: tick, pool, `uf64`, `uctl`, count and alive all
 * identical, and this check red on 4 parts in 1e15 of an accumulator the simulation never
 * reads. It is a property of the wall clock, not of the battle.
 *
 * What the original intent actually needs is that each client's *own* mark is self-consistent —
 * that the tick and the state in it came from the same moment — and `window.__mark()` already
 * guarantees that by reading both in one `evaluate`. The tolerance check below is the belt to
 * that brace: it catches a clock that has been re-baselined out from under its tick counter,
 * which is a real bug this codebase has the machinery for (`Time.resync`, `tickCeiling`), and
 * it does so per client, where the question is well posed.
 */
const TICK_HZ = 30;
function markDisagreement(a, b) {
  if (a.tick !== b.tick) return `they stopped at different ticks: ${a.tick} and ${b.tick}`;
  for (const [tag, m] of [['host', a], ['guest', b]]) {
    const want = m.tick / TICK_HZ;
    if (Math.abs(m.hashes.sim - want) > 1e-6) {
      return `${tag}'s own clock disagrees with its own tick: sim ${m.hashes.sim} at tick `
        + `${m.tick} (expected ${want})`;
    }
  }
  for (const layer of ['hash', 'uf64', 'uctl', 'alive', 'count']) {
    if (a.hashes[layer] !== b.hashes[layer]) {
      return `${layer} differs at tick ${a.tick}: ${a.hashes[layer]} against ${b.hashes[layer]}`;
    }
  }
  return null;
}

function logDiff(a, b) {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = JSON.stringify(a[i] ?? null);
    const y = JSON.stringify(b[i] ?? null);
    if (x !== y) return `event ${i}: host ${x} vs guest ${y}`;
  }
  return null;
}

const relayStatus = async (relay) =>
  fetch(`${relay.http}/status`).then((r) => r.json()).catch(() => null);

// ---------------------------------------------------------------------------
// Arm: the protocol, headless, with two synthetic clients
// ---------------------------------------------------------------------------

if (wanted('proto')) {
  console.log('\n=== the room state machine, over a real socket ===');
  const relay = await startRelay(5991);
  const open = (room, want) => new Promise((ok, no) => {
    const ws = new WebSocket(`${relay.base}/room/${room}?want=${want}&v=1`);
    ws.log = [];
    ws.onmessage = (e) => ws.log.push(JSON.parse(e.data));
    ws.onopen = () => ok(ws);
    ws.onerror = () => no(new Error('socket error'));
    setTimeout(() => no(new Error('open timeout')), 5000);
  });
  const waitFor = (ws, k, ms = 5000) => new Promise((ok, no) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      const m = ws.log.find((x) => x.k === k);
      if (m) { clearInterval(iv); ok(m); }
      else if (Date.now() - t0 > ms) { clearInterval(iv); no(new Error(`no ${k}`)); }
    }, 10);
  });
  const put = (ws, m) => ws.send(JSON.stringify(m));
  const print = (over = {}) => ({
    cfgKey: '{"map":"pydna"}', quality: 'high', unitScale: 1, count0: 100, tick0: 0,
    hash: 'aaaa1111', uf64: 'bbbb2222', uctl: 'cccc3333',
    libm: 'deadbeef', ua: 'Mozilla/5.0 Chrome/151.0.0.0', deployPhase: false, ...over,
  });

  const A = await open('AQAQA', 'host');
  await waitFor(A, 'welcome');
  put(A, { k: 'setup', cfg: { map: 'pydna' }, deployPhase: false });
  const B = await open('AQAQA', 'join');
  const wb = await waitFor(B, 'welcome');
  const cfgMsg = await waitFor(B, 'config');
  record('proto-slots', A.log[0].slot === 0 && wb.slot === 1 && !!cfgMsg.cfg,
    'the host takes slot 0 and the challenger is handed the battle before it loads one',
    `slots ${A.log[0].slot}/${wb.slot}, config ${JSON.stringify(cfgMsg.cfg)}`,
    'want decides the slot, not arrival order: slot 0 is a side, not a queue position');

  put(A, { k: 'ready', print: print(), cfg: { map: 'pydna' }, factions: [0, 1] });
  put(B, { k: 'ready', print: print(), cfg: { map: 'pydna' }, factions: [0, 1] });
  await waitFor(A, 'start');
  put(B, { k: 'ops', ev: [['B1']] });
  put(A, { k: 'ops', ev: [['A1']] });
  put(A, { k: 'ops', ev: [['A2']] });
  await sleep(800);
  const turnsA = A.log.filter((m) => m.k === 'turn' && m.ops.length);
  const turnsB = B.log.filter((m) => m.k === 'turn' && m.ops.length);
  const flat = turnsA.flatMap((t) => t.ops.map((o) => `${o.s}:${o.e[0]}`)).join(',');
  record('proto-order', flat === '0:A1,0:A2,1:B1',
    'ops arriving out of order come back stamped (turn, slot, seq)',
    `guest sent first; the packet reads ${flat}`,
    'applyOrder mutates as it iterates, so sequence is the battle — §4.1');
  record('proto-same-packet',
    JSON.stringify(turnsA.map((t) => [t.n, t.t, t.ops]))
      === JSON.stringify(turnsB.map((t) => [t.n, t.t, t.ops])),
    'and both clients get the identical packet, execution tick included',
    `${turnsA.length} non-empty turn(s), first at n=${turnsA[0]?.n} t=${turnsA[0]?.t}`);

  put(A, { k: 'hash', tick: 30, hash: 'h', uf64: 'u', uctl: 'c', alive: 9 });
  put(B, { k: 'hash', tick: 30, hash: 'h', uf64: 'u', uctl: 'c', alive: 9 });
  await sleep(150);
  put(A, { k: 'hash', tick: 60, hash: 'h', uf64: 'u2', uctl: 'c', alive: 9 });
  put(B, { k: 'hash', tick: 60, hash: 'h', uf64: 'uX', uctl: 'c', alive: 9 });
  const ds = await waitFor(A, 'desync');
  await waitFor(A, 'wantProbe');
  put(A, { k: 'probe', tick: 60, units: [[1, 'p'], [2, 'q']] });
  put(B, { k: 'probe', tick: 60, units: [[1, 'p'], [2, 'r']] });
  const at = await waitFor(A, 'attrib');
  const en = await waitFor(A, 'end');
  record('proto-desync',
    ds.layer === 'uf64' && ds.tick === 60 && ds.lastAgreedTick === 30
      && JSON.stringify(at.units) === '[2]' && en.why === 'desync' && en.atTick === 30,
    'a hash that disagrees is detected on uf64, attributed to a unit, and ends the match',
    `${ds.layer}@${ds.tick}, last agreed ${ds.lastAgreedTick}, `
      + `units ${JSON.stringify(at.units)}, end ${en.why}@${en.atTick}`,
    'uf64 first because it moves thousands of ticks before the float32 pool hash does');
  A.close(); B.close();

  /*
   * Two Chromiums on different libm generations, under the strict posture.
   *
   * `--unknown=refuse` rather than the default, because the default flipped to `allow` once the
   * quantisation firewall made every measured pairing hold for a whole battle: refusing a
   * pairing that would have worked became the likelier and the worse mistake. What still has to
   * work is the *mechanism*, and both postures are checked here — strict refuses by name, and
   * the default plays and says the pairing is unlisted.
   */
  const strict = await startRelay(5990, ['--unknown=refuse', '--quiet']);
  const openOn = (r, room, want) => new Promise((ok, no) => {
    const ws = new WebSocket(`${r.base}/room/${room}?want=${want}&v=1`);
    ws.log = [];
    ws.onmessage = (e) => ws.log.push(JSON.parse(e.data));
    ws.onopen = () => ok(ws);
    ws.onerror = () => no(new Error('socket error'));
    setTimeout(() => no(new Error('open timeout')), 5000);
  });
  const C = await openOn(strict, 'BQBQB', 'host');
  await waitFor(C, 'welcome');
  put(C, { k: 'setup', cfg: { map: 'pydna' }, deployPhase: false });
  const D = await openOn(strict, 'BQBQB', 'join');
  await waitFor(D, 'welcome');
  put(C, { k: 'ready', print: print(), cfg: { map: 'pydna' }, factions: [0, 1] });
  put(D, { k: 'ready', print: print({ libm: '0badf00d' }), cfg: { map: 'pydna' }, factions: [0, 1] });
  const ref = await waitFor(C, 'refuse');
  record('proto-pair-refused', ref.why === 'libm' && ref.detail.includes('149'),
    'under --unknown=refuse, two Chromium generations are refused by name before a tick runs',
    ref.detail.slice(0, 150),
    'a generation is a fingerprint class, not a version range: 143/147/149 are identical on '
      + 'all 14 functions and 149 to 151 changes twelve of them');
  C.close(); D.close();
  strict.stop();

  const P = await open('PQPQP', 'host');
  await waitFor(P, 'welcome');
  put(P, { k: 'setup', cfg: { map: 'pydna' }, deployPhase: false });
  const Q = await open('PQPQP', 'join');
  await waitFor(Q, 'welcome');
  put(P, { k: 'ready', print: print(), cfg: { map: 'pydna' }, factions: [0, 1] });
  put(Q, { k: 'ready', print: print({ libm: '0badf00d' }), cfg: { map: 'pydna' }, factions: [0, 1] });
  const stU = await waitFor(P, 'start');
  record('proto-pair-unlisted', stU.willFork === true && stU.pairNote.includes('unlisted'),
    'and under the default it plays, having said that nothing is known about the pairing',
    stU.pairNote.slice(0, 130),
    'refusing a pairing that would have worked is now the likelier and the worse mistake');
  P.close(); Q.close();

  const E = await open('CQCQC', 'host');
  await waitFor(E, 'welcome');
  put(E, { k: 'setup', cfg: { map: 'pydna' }, deployPhase: false });
  const F = await open('CQCQC', 'join');
  await waitFor(F, 'welcome');
  put(E, { k: 'ready', print: print(), cfg: { map: 'pydna' }, factions: [0, 1] });
  put(F, {
    k: 'ready',
    print: print({ libm: 'feedface', ua: 'Mozilla/5.0 Firefox/153.0' }),
    cfg: { map: 'pydna' }, factions: [0, 1],
  });
  const st = await waitFor(E, 'start');
  record('proto-pair-allowed', st.willFork === false && st.pairNote.includes('t+400'),
    'chromium against firefox is a listed pairing, with its measurement attached',
    st.pairNote.slice(0, 150),
    'a policy table, not a flag: this answer moved three times on the day it was written');
  E.close(); F.close();

  /*
   * A client that announces from a tick other than 0 is refused before the battle starts.
   *
   * This arm exists because the invariant is invisible: `main.ts` calls `engine.start()` and
   * then sets `ready = true`, so a client with no deployment phase to pause its clock runs
   * ticks for as long as its opponent takes to load. Two clients that announced from different
   * ticks are not desynced, they were never synced, and the symptom is a `uctl` difference at
   * t+0 — a control-flow disagreement before a tick was supposed to have run, which rounding
   * cannot produce. `NetSession.init` pins the tick ceiling to 0; this is what happens if a
   * future change unpins it.
   */
  const T1 = await open('TQTQT', 'host');
  await waitFor(T1, 'welcome');
  put(T1, { k: 'setup', cfg: { map: 'pydna' }, deployPhase: false });
  const T2 = await open('TQTQT', 'join');
  await waitFor(T2, 'welcome');
  put(T1, { k: 'ready', print: print(), cfg: { map: 'pydna' }, factions: [0, 1] });
  put(T2, { k: 'ready', print: print({ tick0: 7 }), cfg: { map: 'pydna' }, factions: [0, 1] });
  const tref = await waitFor(T1, 'refuse');
  record('proto-tick-zero', tref.why === 'tick' && tref.detail.includes('tick 0'),
    'a client that announces from a tick other than 0 is refused before the battle starts',
    tref.detail.slice(0, 150),
    'every checkpoint exchanged afterwards would be comparing different points in one battle');
  T1.close(); T2.close();

  const G = await open('DQDQD', 'host');
  await waitFor(G, 'welcome');
  put(G, { k: 'setup', cfg: { map: 'pydna' }, deployPhase: false });
  const Hs = await open('DQDQD', 'join');
  await waitFor(Hs, 'welcome');
  put(G, { k: 'ready', print: print(), cfg: { map: 'pydna' }, factions: [0, 1] });
  put(Hs, { k: 'ready', print: print(), cfg: { map: 'pydna' }, factions: [0, 1] });
  await waitFor(G, 'start');
  Hs.close();
  const end2 = await waitFor(G, 'end');
  record('proto-peer-left', end2.why === 'peerLeft',
    'a socket that goes away ends the match at a stated tick rather than hanging',
    end2.detail.slice(0, 120));
  G.close();
  relay.stop();
}

// ---------------------------------------------------------------------------
// Arm: the real thing
// ---------------------------------------------------------------------------

let mainMatch = null;
if (wanted('battle')) {
  console.log('\n=== two clients, one battle, real menu, real mouse ===');
  const relay = await startRelay(RELAY_PORT);
  const { host, guest, room } = await bootMatch(relay, { shots: 'net' });
  const n0 = await host.evaluate(() => window.__net());
  const n1 = await guest.evaluate(() => window.__net());
  measured.factions = { host: n0.myFaction, guest: n1.myFaction, slots: [n0.slot, n1.slot] };
  /*
   * The invariant every hash exchanged afterwards depends on.
   *
   * `main.ts` calls `engine.start()` and then sets `ready = true`, so the frame loop is live
   * before anything downstream knows the page exists — and a client with no deployment phase to
   * pause its clock will run ticks for as long as its opponent takes to load. Two clients that
   * announced from different ticks are not desynced; they were never synced, and the symptom is
   * a `uctl` difference at t+0, which is a control-flow disagreement before a tick was supposed
   * to have run and is not a shape rounding can take. `NetSession.init` pins the ceiling to 0;
   * this is the assertion that it worked.
   */
  record('joined-at-tick-zero', n0.tick0 === 0 && n1.tick0 === 0,
    'both clients announced themselves from tick 0, so every later checkpoint compares the '
      + 'same moment of the same battle',
    `host announced from tick ${n0.tick0}, guest from ${n1.tick0}`,
    'the relay refuses the pairing outright if either is not 0 — see BootPrint.tick0');

  record('two-factions', n0.myFaction !== n1.myFaction && n0.slot === 0 && n1.slot === 1,
    'the two clients command different armies',
    `slot 0 commands faction ${n0.myFaction}, slot 1 commands faction ${n1.myFaction}`,
    'PLAYER_FACTION was a compile-time constant — §1.10, "the second player cannot be '
      + 'anything but Rome"');

  const gestures = { host: await deployWith(host, 'net-host'), guest: await deployWith(guest, 'net-guest') };
  await sleep(1200);
  const phase = await host.evaluate(() => window.__net().phase);
  const dh = await host.evaluate(() => window.__dep());
  const dg = await guest.evaluate(() => window.__dep());
  record('two-deployments', phase === 'battle' && dh?.committed === true && dg?.committed === true,
    'both players laid out an army and the clock started once both had committed',
    `phase '${phase}'; host ${dh?.own} units committed=${dh?.committed}, `
      + `guest ${dg?.own} units committed=${dg?.committed}`,
    'deployment.add mints unit ids before forking the RNG, so both clients apply one '
      + 'canonical sequence of operations — §4.1');

  const bursts = Math.max(3, Math.round(SECONDS / 18));
  for (let i = 0; i < bursts; i++) {
    gestures.host.push(...await burst(host, i));
    gestures.guest.push(...await burst(guest, i + 1));
    await sleep(1600);
  }
  await shot(host, 'net-03-host');
  await shot(guest, 'net-04-guest');
  // Let it run to the length asked for, then let both clients settle on one tick.
  const target = Math.round(SECONDS * 30);
  const t0 = Date.now();
  while (Date.now() - t0 < SECONDS * 1200) {
    const t = await host.evaluate(() => window.__tick());
    if (t >= target) break;
    await sleep(700);
  }
  const settled = await settleTogether(host, guest, 40000, relay);
  const { a, b } = await readBoth(host, guest);
  const rs = await relayStatus(relay);
  measured.battle = {
    ticks: settled.tick, hostTick: a.tick, guestTick: b.tick,
    relay: rs?.rooms?.[0] ?? null,
    gestures, hostStatus: a.net, guestStatus: b.net,
    hashes: { host: a.hashes, guest: b.hashes },
  };

  const disagreement = markDisagreement(a, b);
  record('same-battle', disagreement === null,
    'both clients are at the same tick with the same state, bit for bit',
    disagreement
      ?? `tick ${a.tick}: pool ${a.hashes.hash}/${b.hashes.hash}, uf64 ${a.hashes.uf64}/${b.hashes.uf64}, `
        + `uctl ${a.hashes.uctl}/${b.hashes.uctl}, alive ${a.hashes.alive}/${b.hashes.alive}`,
    `${a.hashes.count} men. Five layers plus the tick; each client's sim clock is checked `
      + 'against its own tick rather than against the other\'s, because that accumulator is '
      + 'frame-grouped and the simulation never reads it — see markDisagreement');

  const agreed = rs?.rooms?.[0]?.lastAgreedTick ?? -1;
  record('checkpoints-agreed', agreed >= Math.min(a.tick, b.tick) - 60 && agreed > 0
    && !a.net.desync && !b.net.desync,
    'every checkpoint the two exchanged agreed, all the way to the end',
    `the relay's last agreed tick is ${agreed} against a final tick of ${a.tick}`,
    'one checkpoint a second on four layers, uf64 first');

  const ld = logDiff(a.rec.events, b.rec.events);
  record('one-order-log', ld === null && a.rec.events.length > 2,
    'both clients hold the identical merged order log — one total order, not two',
    ld ?? `${a.rec.events.length} events, byte-identical on both clients`,
    'this is the claim the relay exists to make');

  record('same-result', JSON.stringify(a.flow) === JSON.stringify(b.flow),
    'and the same verdict',
    a.flow ? `${a.flow.reason}, victor ${a.flow.victor}` : 'battle still running on both');

  const lat = [...(a.net.lat ?? []), ...(b.net.lat ?? [])];
  const mean = (xs) => (xs.length ? xs.reduce((p, c) => p + c, 0) / xs.length : 0);
  measured.inputDelay = {
    samples: lat.length,
    meanRttMs: +mean(lat.map((l) => l.rttMs)).toFixed(1),
    meanDelayTicks: +mean(lat.map((l) => l.delayTicks)).toFixed(2),
    maxDelayTicks: lat.length ? Math.max(...lat.map((l) => l.delayTicks)) : 0,
    stalls: [a.net.stalls, b.net.stalls],
    stalledMs: [a.net.stalledMs, b.net.stalledMs],
  };
  /*
   * The delay has a floor as well as a ceiling, and the floor is the interesting assertion.
   *
   * Two turns of scheduled delay is six ticks, and an op lands in `max(turn + 1, turn + 2)` of
   * a turn counter that has already advanced past the one it was sent during — so 3 to 6 ticks
   * is the whole legal range. **Anything below 3 would mean an order reached the simulation
   * without going through the relay**, which is the one failure this design cannot survive and
   * the one a passing hash comparison would not necessarily catch: a locally-applied order on
   * both clients in the same frame looks identical until the frames stop lining up.
   */
  record('input-delay', lat.length >= 3
    && measured.inputDelay.meanDelayTicks >= 3 && measured.inputDelay.maxDelayTicks <= 12,
    'every order took the relay\'s full scheduled delay and no order skipped it',
    `${lat.length} battle orders: mean ${measured.inputDelay.meanDelayTicks} ticks `
      + `(${(measured.inputDelay.meanDelayTicks * 33.3).toFixed(0)} ms), `
      + `max ${measured.inputDelay.maxDelayTicks} ticks, `
      + `mean round trip ${measured.inputDelay.meanRttMs} ms`,
    'the floor is what matters: 3 ticks is the next scheduled turn, so under 3 means an '
      + 'order reached the simulation without going through the relay. The ceiling is soft — an '
      + 'op arriving after a turn boundary lands a turn later — so this refuses above 12.');

  record('battle-console', a.errs.length === 0 && b.errs.length === 0,
    'neither page raised a console error',
    [...a.errs, ...b.errs].slice(0, 3).join(' ; ') || 'clean');

  mainMatch = { relay, host, guest, room };
  if (!wanted('late') && !wanted('leave')) {
    await host.close(); await guest.close(); relay.stop(); mainMatch = null;
  }
}

// ---------------------------------------------------------------------------
// Arms that break it on purpose. Each fails if the session does NOT notice.
// ---------------------------------------------------------------------------

/**
 * Run a short match with a fault injected and report what the session did about it.
 *
 * The fault fires from battle turn 30 (about three seconds in), which is late enough that both
 * clients are past the deployment phase and early enough that the arm is quick.
 */
async function faultArm(name, kind, port, what, why, opts = {}) {
  console.log(`\n=== breaking it on purpose: ${what} ===`);
  const relay = await startRelay(port, [
    `--fault=${kind}`, '--fault-slot=1', '--quiet',
    `--fault-from=${opts.fromTurn ?? 20}`,
    `--fault-phase=${opts.phase ?? 'battle'}`,
  ]);
  const { host, guest } = await bootMatch(relay);
  await deployWith(host, `${name}-h`);
  await deployWith(guest, `${name}-g`);
  await sleep(1200);
  // Orders, so the drop/dup/swap arms have something to corrupt. Two in one burst from one
  // client, so `swap` has a pair to exchange that touches the same regiments.
  /*
   * Keep issuing orders until the fault has bitten, or until the rounds run out.
   *
   * The corruption is armed but only fires on a turn it can actually corrupt — `swap` needs two
   * orders from one player inside one 100 ms turn, and real mouse input does not guarantee that
   * on any particular attempt. Polling between rounds rather than after them means a run that
   * needs six attempts is slower than one that needs one, and neither is a flake.
   */
  let seen = null;
  const rounds = opts.rounds ?? (opts.pairs ? 8 : 4);
  for (let i = 0; i < rounds && !seen; i++) {
    if (opts.pairs) { await doubleOrder(host, i); await doubleOrder(guest, i + 1); }
    else { await burst(host, i); await burst(guest, i + 2); }
    for (let k = 0; k < 4 && !seen; k++) {
      const n = await host.evaluate(() => window.__net());
      if (n?.desync || n?.ended) seen = n;
      else await sleep(350);
    }
  }
  const t0 = Date.now();
  while (Date.now() - t0 < 30000 && !seen) {
    const n = await host.evaluate(() => window.__net());
    if (n?.desync || n?.ended) { seen = n; break; }
    await sleep(400);
  }
  const ng = await guest.evaluate(() => window.__net());
  const rs = await relayStatus(relay);
  const d = seen?.desync ?? null;
  measured[name] = {
    detected: !!d, ended: seen?.ended ?? '', guestEnded: ng?.ended ?? '',
    desync: d, relay: rs?.rooms?.[0] ?? null,
    perturbed: [seen?.perturbed ?? -1, ng?.perturbed ?? -1],
  };
  record(name, !!d && d.tick >= 0,
    what,
    d ? `caught at tick ${d.tick} on ${d.layer} (${d.mine} against ${d.theirs}); `
      + `last agreed tick ${d.lastAgreedTick}; ${d.note}`
      : 'NOT DETECTED — the two clients diverged and the session said nothing',
    why);
  if (d) {
    record(`${name}-both`, (seen?.ended ?? '') === 'desync' && (ng?.ended ?? '') === 'desync',
      'and both clients stopped, rather than one of them playing on alone',
      `host ended '${seen?.ended}', guest ended '${ng?.ended}'`);
  }
  await host.close(); await guest.close();
  relay.stop();
  return d;
}

if (wanted('drop')) {
  await faultArm('dropped-order', 'drop', 5992,
    'one order dropped from one client\'s turn packet',
    'a lost frame. The client that kept it fights a different battle from the one that did not');
}
if (wanted('dup')) {
  await faultArm('duplicated-order', 'dup', 5993,
    'one deployment operation delivered twice to one client',
    'a retransmit, against the sharpest hazard in the design: deployment.add runs '
      + 'nextUnitId++ before rng.fork(\'unit\' + id), so one extra add on one client mints a '
      + 'regiment the other has not got and shifts every unit id after it',
    { phase: 'deploy', fromTurn: 0 });
}
if (wanted('swap')) {
  await faultArm('reordered-pair', 'swap', 5994,
    'two orders in one turn delivered in the opposite sequence to one client',
    'the total-order claim itself: §4.1 says two orders touching one unit in a different '
      + 'sequence are a different battle, and this is the arm that shows it',
    { pairs: true });
}
if (wanted('ulp')) {
  const d = await faultArm('one-ulp', 'ulp', 5995,
    'one UnitGroupState float64 field moved by a single ULP on one client',
    'the magnitude §1.4 measured for a real libm disagreement. Nothing about the order '
      + 'stream is wrong here — the arithmetic is');
  if (d) {
    record('one-ulp-layer', d.layer === 'uf64',
      'and it is caught on the float64 unit layer, which is why that layer is the detector',
      `caught on '${d.layer}' at tick ${d.tick}`,
      'the float32 pool has a quantisation firewall with ~29 bits of headroom; '
        + 'UnitGroupState has none');
    record('one-ulp-attributed', d.units.length >= 1 && d.units.length <= 4,
      'and attributed to the regiment it happened to, not to the whole field',
      `${d.units.length} unit(s): ${d.units.join(', ')} — ${d.note}`,
      'per-unit digests are hashed from a fresh state each, so a one-unit fault names one unit');
  }
}

// ---------------------------------------------------------------------------
// The blind spot this gate inherited
// ---------------------------------------------------------------------------

/*
 * A siege, relayed, because a gate that only ever plays one battle has only ever tested one.
 *
 * `tools/qa-replay.mjs` shipped for weeks reporting 21/21 while **no siege record had ever been
 * through it**: it only ever recorded `campus-martius / field`, and every siege replay in the
 * project was meanwhile being refused by its own t+0 checkpoint. That was found on 21 Aug and
 * fixed in `bb2eb84`, which added the `matrix` arm — and this file was written the same day
 * with exactly the same hole in it. Every arm above boots `campus-martius / field`.
 *
 * The hole matters more here than it did there, and the reason is specific rather than
 * decorative. A siege is where this design's stated hazards are densest: `Siege.ts` mutates
 * private maps outside the tick, the wall and gate systems add control flow that `uctl` is the
 * only layer watching, and the challenger never sees a menu — its whole battle, siege included,
 * arrives as `MsgSetup.cfg` over the relay. If a siege config does not cross the wire and build
 * identically on both clients, nothing above would ever have said so.
 *
 * This arm is deliberately shorter than `battle`: what is new here is the map, not the length.
 */
if (wanted('siege')) {
  console.log('\n=== the same two clients, but a siege ===');
  // 5998: 5995 is the `ulp` fault arm's, and two arms on one port is how `late` and `leave`
  // were broken by the four arms between them. Free in the band: 5988 and 5998.
  const relay = await startRelay(5998);
  const m = await bootMatch(relay, {
    map: SIEGE_MAP, scenario: SIEGE_SCENARIO, shots: 'siege',
  });
  record('siege-config-crossed', m.cfg?.map === SIEGE_MAP && m.cfg?.scenario === SIEGE_SCENARIO,
    'the challenger built the host\'s siege from the config that came over the wire',
    `the guest is standing in ${m.cfg?.map} / ${m.cfg?.scenario}`,
    'the challenger has no menu — MsgSetup.cfg is the only way it can know what battle this is');

  const g = { host: await deployWith(m.host, 'siege-host'), guest: await deployWith(m.guest, 'siege-guest') };
  await sleep(1200);
  for (let i = 0; i < 3; i++) {
    g.host.push(...await burst(m.host, i));
    g.guest.push(...await burst(m.guest, i + 1));
    await sleep(1600);
  }
  const target = Math.round(SIEGE_SECONDS * 30);
  const t0 = Date.now();
  while (Date.now() - t0 < SIEGE_SECONDS * 1400) {
    const t = await m.host.evaluate(() => window.__tick());
    if (t >= target) break;
    await sleep(700);
  }
  const settled = await settleTogether(m.host, m.guest, 40000, relay);
  const { a, b } = await readBoth(m.host, m.guest);
  const rs = await relayStatus(relay);
  measured.siege = {
    cfg: m.cfg, ticks: settled.tick, hostTick: a.tick, guestTick: b.tick,
    gestures: g, hashes: { host: a.hashes, guest: b.hashes },
    relay: rs?.rooms?.[0] ?? null,
  };

  const siegeDisagreement = markDisagreement(a, b);
  record('siege-same-battle', siegeDisagreement === null,
    'both clients are at the same tick of the same siege, bit for bit',
    siegeDisagreement
      ?? `tick ${a.tick}: pool ${a.hashes.hash}/${b.hashes.hash}, uf64 ${a.hashes.uf64}/${b.hashes.uf64}, `
        + `uctl ${a.hashes.uctl}/${b.hashes.uctl}, alive ${a.hashes.alive}/${b.hashes.alive}`,
    `${a.hashes.count} men. uctl is the layer that earns its keep here: a wall, a gate and a `
      + 'ladder queue are control flow, and control flow is the one thing rounding cannot excuse');

  const agreed = rs?.rooms?.[0]?.lastAgreedTick ?? -1;
  record('siege-checkpoints-agreed',
    agreed >= Math.min(a.tick, b.tick) - 60 && agreed > 0 && !a.net.desync && !b.net.desync,
    'every checkpoint the two exchanged during the siege agreed',
    `the relay's last agreed tick is ${agreed} against a final tick of ${a.tick}`);

  const ld = logDiff(a.rec.events, b.rec.events);
  record('siege-one-order-log', ld === null && a.rec.events.length > 2,
    'and both hold the identical merged order log',
    ld ?? `${a.rec.events.length} events, byte-identical on both clients`);

  record('siege-console', a.errs.length === 0 && b.errs.length === 0,
    'neither page raised a console error during the siege',
    [...a.errs, ...b.errs].slice(0, 3).join(' ; ') || 'clean');

  await m.host.close(); await m.guest.close(); relay.stop();
}

// ---------------------------------------------------------------------------
// Session-level failures
// ---------------------------------------------------------------------------

if (wanted('late')) {
  console.log('\n=== a third client arrives mid-battle ===');
  const relay = mainMatch?.relay ?? await startRelay(5996);
  const m = mainMatch ?? await bootMatch(relay);
  if (!mainMatch) { await deployWith(m.host, 'late-h'); await deployWith(m.guest, 'late-g'); await sleep(1500); }
  const room = m.room;
  const said = await new Promise((ok) => {
    const ws = new WebSocket(`${relay.base}/room/${room}?want=join&v=1`);
    let got = null;
    ws.onmessage = (e) => { got = JSON.parse(e.data); };
    ws.onclose = () => ok(got);
    ws.onerror = () => ok(got);
    setTimeout(() => { try { ws.close(); } catch { /* gone */ } ok(got); }, 4000);
  });
  measured.late = said;
  record('late-join-refused', !!said && said.k === 'refuse',
    'a third client is refused by name, and told which kind of refusal it is',
    said ? `${said.why}: ${said.detail}` : 'NOT REFUSED — it was let into a live battle',
    '§4.5 refuses reconnection into a live battle; the refusal has to be legible');
}

if (wanted('leave')) {
  console.log('\n=== one client disappears ===');
  const relay = mainMatch?.relay ?? await startRelay(5997);
  const m = mainMatch ?? await bootMatch(relay);
  if (!mainMatch) { await deployWith(m.host, 'leave-h'); await deployWith(m.guest, 'leave-g'); await sleep(1500); }
  const before = await m.host.evaluate(() => window.__net());
  /*
   * Where the session strip sits, measured against the bar it used to sit on top of.
   *
   * `.tc-net` was `top: 8px` and `.topbar` is `top: 0.8em` in a HUD whose em is
   * `10px * var(--ui-scale)`: the same strip, centred the same way, so the room code and the
   * link status were drawn straight over the turn clock and both armies' strength. Checked
   * here because this is the only arm that has a live battle, a HUD and a session at once.
   */
  const strips = await m.host.evaluate(() => {
    const r = (s) => {
      const el = document.querySelector(s);
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { top: Math.round(b.top), bottom: Math.round(b.bottom),
        left: Math.round(b.left), right: Math.round(b.right) };
    };
    return { net: r('.tc-net'), bar: r('.topbar') };
  });
  const overlap = strips.net && strips.bar
    && strips.net.top < strips.bar.bottom && strips.net.bottom > strips.bar.top
    && strips.net.left < strips.bar.right && strips.net.right > strips.bar.left;
  measured.stripPlacement = strips;
  record('session-strip-clears-the-hud', !!strips.net && !!strips.bar && !overlap,
    'the session strip parks under the top bar instead of on top of it',
    strips.net && strips.bar
      ? `strip ${strips.net.top}–${strips.net.bottom}, top bar ${strips.bar.top}–${strips.bar.bottom}`
      : `strip ${strips.net ? 'found' : 'MISSING'}, top bar ${strips.bar ? 'found' : 'MISSING'}`,
    'measured from the bar rather than written down, because the bar moves with --ui-scale');

  await m.guest.close();
  let after = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 20000) {
    after = await m.host.evaluate(() => window.__net());
    if (after?.ended) break;
    await sleep(300);
  }
  const stopped = await m.host.evaluate(() => window.__tick());
  await sleep(1200);
  const still = await m.host.evaluate(() => window.__tick());
  measured.leave = { before: before?.phase, ended: after?.ended, message: after?.message, stopped, still };
  record('peer-left', after?.ended === 'peerLeft',
    'the surviving client is told, by name, at a stated tick',
    after?.ended ? `${after.ended}: ${after.message}` : 'the survivor was never told anything',
    'a lockstep client with no peer looks exactly like a frozen game unless something says so');
  record('peer-left-halts', still === stopped,
    'and it stops rather than running on into a battle nobody else is in',
    `tick ${stopped} then ${still} a second later`);

  /*
   * And the screen the survivor is left looking at, which is the owner's second decision:
   * halt, state the result, offer a way out — and record no result at all.
   *
   * `peer-left` above proves the *session* knows. It proved nothing about the person, who until
   * this pass got an eleven-point line of red text above the top bar over a battle that would
   * never move again, and whose only exit was the browser's back button.
   */
  await sleep(600);
  const over = await m.host.evaluate(() => {
    const el = document.querySelector('.tc-over');
    if (!el) return null;
    return {
      title: (el.querySelector('h2')?.textContent ?? '').trim(),
      body: (el.textContent ?? '').replace(/\s+/g, ' ').trim(),
      menu: el.querySelector('#tc-over-menu')?.getAttribute('href') ?? null,
      save: !!el.querySelector('#tc-over-save'),
      haveRecord: !!window.__game?.net?.record(),
    };
  });
  await shot(m.host, 'leave-01-peer-left-screen');
  measured.leaveScreen = { ...(over ?? {}), errs: m.host.__errs.slice(0, 4) };
  if (!over && m.host.__errs.length) console.log(`  page said: ${m.host.__errs.join(' ; ')}`);
  record('peer-left-has-a-screen',
    !!over && /left/i.test(over.title) && /The battle stood at t\+\d+/.test(over.body)
      && !!over.menu,
    'the survivor gets a sheet that says the opponent left, where the battle stood, and a way out',
    over ? `${over.title} — ${over.body.slice(0, 150)}` : 'there is no sheet; the strip is all there is',
    'the owner\'s shape for it: "The battle stood at t+337, turn 101."');
  record('peer-left-records-no-result',
    !!over && /No result has been recorded/.test(over.body)
      && !/\b(VICTORY|DEFEAT|Victory|Defeat)\b/.test(over.body),
    'and it does not manufacture a verdict out of an abandoned battle',
    over ? over.body.slice(-180) : 'no sheet',
    'BattleFlow\'s dispatch is deliberately not reused: that card exists to print a verdict');
  record('peer-left-offers-the-record-only-if-there-is-one',
    !!over && over.save === over.haveRecord,
    'Save the replay is offered exactly when there is a record to save',
    over ? `record ${over.haveRecord ? 'present' : 'absent'}, button ${over.save ? 'shown' : 'absent'}`
      : 'no sheet',
    'a button that fails when a stranded player presses it is worse than an absent one');
  await m.host.close();
  mainMatch = null;
  relay.stop();
}

// ---------------------------------------------------------------------------
// The window every other arm in this file has looked straight past
// ---------------------------------------------------------------------------

/*
 * Two clients who find each other through the form, with nobody hand-building a URL.
 *
 * **This is the blind spot, and it is structural rather than an oversight.** Every net arm
 * above waits for `phase === 'battle'` before it asserts anything, and `bootMatch` reaches that
 * phase by writing `?net=…&room=…` itself. So not one of them has ever loaded `?mp=1`, and the
 * lobby in front of a working netcode was free to be anything at all. It was: the panel took
 * `hud.css`'s `.card` rule and rendered 135 px wide with every control below y=1059 on a page
 * that could not scroll, `#menu-root`'s `pointer-events: none` meant no click could land on any
 * of them anyway, and CREATE A ROOM had never once succeeded because `/new` came back without
 * an `Access-Control-Allow-Origin`. Thirty-eight green checks over a front door nobody could
 * open.
 *
 * The pass condition is deliberately the whole flow and not a geometry assertion: type a code,
 * press CREATE, the other client types the same code and presses JOIN, and a battle happens.
 * A regression in any one of the three faults above breaks it, and so does a fourth nobody has
 * thought of yet.
 *
 * 5988 is the last free port in the band (see the `siege` arm's note); the three lobby arms run
 * one after another and each stops its own relay, so they share it.
 */
if (wanted('lobby')) {
  console.log('\n=== two clients through the real form ===');
  const relay = await startRelay(5988);
  const room = nextRoom();
  const host = await newPage(chrome);
  /*
   * In through the front door, not at `?mp=1`.
   *
   * The one URL this arm is allowed to type is the site's own root. Everything after it — the
   * lobby, the host's `?net=…&room=…&menu=battle`, the challenger's `&host=0` — is written by
   * the product, which is the entire claim being made.
   */
  await host.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
  await host.waitForSelector('.menu.at-home .dest-multiplayer', { timeout: 60000 });
  await host.click('.menu-home .dest-multiplayer');
  await host.waitForSelector('.tc-lobby', { timeout: 30000 });

  /*
   * The transport panel, opened first, because this arm's relay is one this test started.
   *
   * `base` is an ordinary dev server with no relay beside it, so the lobby correctly refuses on
   * arrival and both buttons are disabled — that refusal is the `dev` arm's subject and is
   * asserted there. What this arm owns from here on is the *demoted* capability: a host who
   * has a relay somewhere else opens the disclosure, types its address, and everything below
   * proceeds exactly as it did when the field was on the front of the panel.
   *
   * Filling it before the geometry read is also what keeps that read honest. With the refusal
   * on screen and the disclosure open the sheet is ~765 px tall in an 800 px viewport, and the
   * back link would leave the fold — so the check would go red about a layout that is fine.
   */
  await openAdvanced(host);
  await host.fill('#tc-relay', relay.base);

  /*
   * Geometry and hit-testing first, because it is the measurement that named the bug.
   *
   * Not decoration on top of the flow test: a panel that is 135 px wide and cannot be clicked
   * *also* fails the flow test, but it fails it as a thirty-second Playwright timeout with
   * "waiting for locator" and no indication of why. This turns that into a sentence.
   */
  const geo = await host.evaluate(() => {
    const at = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return { missing: true, reaches: false, blockedBy: 'no such element' };
      const r = el.getBoundingClientRect();
      const cx = Math.round(r.x + r.width / 2);
      const cy = Math.round(r.y + r.height / 2);
      const inView = cx >= 0 && cy >= 0 && cx < innerWidth && cy < innerHeight;
      const top = inView ? document.elementFromPoint(cx, cy) : null;
      return {
        w: Math.round(r.width), h: Math.round(r.height), y: Math.round(r.y), inView,
        pe: getComputedStyle(el).pointerEvents,
        reaches: !!top && (top === el || el.contains(top)),
        blockedBy: top ? `${top.tagName.toLowerCase()}${top.id ? `#${top.id}` : ''}` : 'nothing',
      };
    };
    return {
      sheet: at('.tc-sheet'), room: at('#tc-room'), create: at('#tc-host'),
      join: at('#tc-join'), relay: at('#tc-relay'), back: at('.tc-back'),
    };
  });
  const unreachable = ['room', 'create', 'join', 'relay', 'back'].filter((k) => !geo[k].reaches);
  measured.lobby = { geo };
  record('lobby-is-clickable', unreachable.length === 0 && geo.sheet.w >= 480,
    'every control in the lobby is where it says it is and a real mouse reaches it, the relay '
      + 'field included once its disclosure is open',
    unreachable.length
      ? `${unreachable.join(', ')} — elementFromPoint returns `
        + unreachable.map((k) => `${k}:${geo[k].blockedBy}`).join(', ')
      : `panel ${geo.sheet.w}x${geo.sheet.h}, all five controls hit-test to themselves`,
    'hud.css .card clamped this panel to 135x210 and #menu-root swallowed every click');

  /*
   * The field used to delete a character and say nothing. `O` is the one people type.
   *
   * Typed at 30 ms a key, which is the measurement that mattered: the first fix wrote the
   * explanation on the keystroke that caused it and the *next* keystroke overwrote it with
   * "3 more characters", so the sentence existed for a fifth of a second and nobody saw it.
   */
  await host.click('#tc-room');
  await host.type('#tc-room', 'ROMEX', { delay: 30 });
  const filtered = await host.inputValue('#tc-room');
  const hintText = ((await host.textContent('#tc-room-hint')) ?? '').replace(/\s+/g, ' ').trim();
  record('lobby-names-the-character-it-dropped',
    filtered === 'RMEX' && hintText.includes('“O”') && /read aloud/.test(hintText),
    'a character the alphabet does not have is removed and *named*, not removed in silence',
    `typing ROMEX leaves ${filtered} and the field says: ${hintText.slice(0, 120)}`,
    'the alphabet exists because codes get read aloud, which is exactly why O is what gets typed');

  await host.fill('#tc-room', '');
  await host.type('#tc-room', room, { delay: 20 });
  await shot(host, 'lobby-01-form');
  await host.click('#tc-host');
  await host.waitForSelector('#tc-code', { timeout: 20000 });
  const shown = ((await host.textContent('#tc-code')) ?? '').trim();
  const rs0 = await relayStatus(relay);
  await shot(host, 'lobby-02-room-open');
  record('lobby-create-opens-the-room-asked-for',
    shown === room && !!rs0?.rooms?.some((r) => r.code === room),
    'CREATE A ROOM reaches the relay, and the code on screen is the one that was typed',
    `the sheet reads ${shown || '(nothing)'}; the relay holds `
      + `${(rs0?.rooms ?? []).map((r) => r.code).join(', ') || 'no rooms'}`,
    'before CORS this fetch always rejected and the lobby blamed a relay that had just answered');

  await host.click('#tc-begin');
  await driveMenu(host, { map: 'campus-martius', scenario: 'field', tier: 'high', size: 'small' });

  const guest = await newPage(chromeGuest);
  await guest.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
  await guest.waitForSelector('.menu.at-home .dest-multiplayer', { timeout: 60000 });
  await guest.click('.menu-home .dest-multiplayer');
  await guest.waitForSelector('.tc-lobby', { timeout: 30000 });
  await openAdvanced(guest);
  await guest.fill('#tc-relay', relay.base);
  await guest.click('#tc-room');
  await guest.type('#tc-room', room, { delay: 20 });
  await shot(guest, 'lobby-03-guest-form');
  await guest.click('#tc-join');
  await guest.waitForFunction(() => window.__game?.ready === true, null, { timeout: 300000 });
  // `window.__net` and the rest of the readers live in `INSTALL`; `bootMatch` runs it and this
  // arm does not go through `bootMatch`, which is the whole point of it.
  await host.evaluate(INSTALL);
  await guest.evaluate(INSTALL);
  for (const p of [host, guest]) {
    await p.waitForFunction(() => ['deploy', 'battle'].includes(window.__net()?.phase),
      null, { timeout: 90000 });
  }
  const nh = await host.evaluate(() => window.__net());
  const ng = await guest.evaluate(() => window.__net());
  await shot(host, 'lobby-04-host-in-battle');
  await shot(guest, 'lobby-05-guest-in-battle');
  measured.lobby.met = { room, host: nh, guest: ng };
  record('lobby-two-clients-meet',
    nh.room === room && ng.room === room && nh.slot === 0 && ng.slot === 1
      && nh.myFaction !== ng.myFaction,
    'two people find each other by typing a code, and end up on opposite sides of one battle',
    `room ${room}: host is slot ${nh.slot} commanding ${nh.myFaction}, `
      + `challenger is slot ${ng.slot} commanding ${ng.myFaction}`,
    'the only URL this test typed is the site root; the product wrote both of the others');

  /*
   * A host alone in a room, watched past six seconds.
   *
   * The exact clock the false verdict fired on: `Room.tick` returned `none()` in the lobby, so
   * `NetLink.gapMs` never left 0, `linkFault`'s threshold collapsed to its `LINK_SILENT_S`
   * floor, and a healthy session ended at 6.0 s with the socket open. It belongs here rather
   * than in a fault arm because nothing had to go wrong for it to fire: it needed a player to
   * take longer than six seconds to read a code out.
   */
  record('lobby-alone-is-not-a-dead-link',
    !nh.ended && !ng.ended && nh.got > 1,
    'a host who waited alone in the room was not told the link had died',
    `host ended='${nh.ended || 'not ended'}' after ${nh.got} frames in; `
      + `challenger ended='${ng.ended || 'not ended'}'`,
    'the lobby now beats once a second, so the silence test measures silence and not a phase');

  record('lobby-console', host.__errs.length === 0 && guest.__errs.length === 0,
    'and neither page raised a console error anywhere in the flow',
    [...host.__errs, ...guest.__errs].slice(0, 3).join(' ; ') || 'clean');

  await host.close(); await guest.close();
  relay.stop();
}

/*
 * One command, an address the machine next door can reach, and a link that carries it.
 *
 * ## What this can prove on one machine, and what it cannot
 *
 * It cannot prove the firewall. Traffic from this machine to its own en0 address is
 * short-circuited before the packet filter sees it, so `fetch('http://192.168.0.238:5938/')`
 * succeeding here says nothing about whether the laptop on the sofa gets through. That is the
 * one thing in this arm that needs a second machine, and `docs/MULTIPLAYER.md` §10.4 is the
 * five-minute procedure for it.
 *
 * What it *can* prove is everything up to that line, and every one of those had never been
 * asserted: that the bind is not loopback, that both halves answer **at the address that is
 * about to be handed out** rather than merely at `127.0.0.1`, that the lobby builds an invite
 * out of that address, that the invite works when it is the only thing the second client is
 * given — and, the check that keeps the previous pass's honesty intact, that a server with no
 * LAN address still withholds the link and still says why.
 *
 * That last one is why the arm ends where it does rather than at the battle. Making the link
 * appear is easy; the risk this whole change carries is that "withheld honestly" quietly
 * becomes "usually works", and the only defence against it is a check that goes red when a
 * link shows up somewhere it cannot work.
 */
if (wanted('lan')) {
  console.log('\n=== one command, and a link the other machine can open ===');
  const lan = await startHostLan(LAN_PORT, LAN_RELAY);
  const lanBase = `http://${lan.lan}:${lan.gamePort}`;

  /*
   * Reached over the wire at the advertised address, not over loopback.
   *
   * `waitForServer(base)` on `127.0.0.1` was the check the first draft had and it is the check
   * that cannot fail: the process is up, which was never the question. The question is whether
   * the *bind* took, and the only local instrument for that is asking the same interface the
   * other machine will ask.
   */
  const game = await fetch(`${lanBase}/`, { signal: AbortSignal.timeout(8000) })
    .then((r) => r.status).catch((e) => `${e.name}: ${e.message}`);
  const health = await fetch(`http://${lan.lan}:${lan.relayPort}/health`, { signal: AbortSignal.timeout(8000) })
    .then((r) => r.text()).catch((e) => `${e.name}: ${e.message}`);
  const plaque = await fetch(`${lanBase}/__tc/lan`, { signal: AbortSignal.timeout(8000) })
    .then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const privateV4 = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(lan.lan ?? '');
  measured.lan = { said: lan.lan, iface: lan.iface, game, health, plaque, ports: [lan.gamePort, lan.relayPort] };
  record('lan-one-command-serves-both-halves',
    game === 200 && String(health).startsWith('relay ok') && privateV4 && !!plaque?.relayUrl,
    'one command puts the game and the relay on an address another machine could route to',
    `${lan.iface} ${lan.lan}: game ${lan.gamePort} answered ${game}, `
      + `relay ${lan.relayPort} answered '${String(health).trim().slice(0, 40)}', `
      + `/__tc/lan names ${plaque?.relayUrl ?? 'no relay'}`,
    'both defaults were 127.0.0.1, so the documented way to play a two-player game was playable by one');

  /*
   * If the address does not answer there is nothing to drive a browser at, and the five checks
   * below would each report a Playwright timeout about a page that was never served. One
   * sentence, and the arm stops — the same judgement `norelay` makes when its port is occupied.
   */
  reachable: {
  if (game !== 200 || !String(health).startsWith('relay ok')) {
    record('lan-arm-can-run', false,
      'the rest of this arm needs the host command to be serving at that address',
      `game ${game}, relay '${String(health).slice(0, 60)}' — nothing to point a browser at`,
      'five Playwright timeouts about a server that is not there is not five findings');
    break reachable;
  }

  /*
   * The case the lobby could not solve alone: a loopback URL bar over a LAN-bound server.
   *
   * Nothing is typed into the relay field here on purpose. `defaultRelay()` fills it with
   * `ws://127.0.0.1:<relay>` — right for this browser, fatal in an invite — and the plaque is
   * the only thing that can know better. If the field is still loopback when CREATE is pressed,
   * the link is withheld and this check is red.
   */
  const hostPage = await newPage(chrome);
  await hostPage.goto(`http://127.0.0.1:${lan.gamePort}/?mp=1`, { waitUntil: 'domcontentloaded' });
  await hostPage.waitForSelector('.tc-lobby', { timeout: 30000 });
  await hostPage.waitForFunction(
    (want) => (document.querySelector('#tc-relay')?.value ?? '') === want,
    lan.relayUrl, { timeout: 10000 }
  ).catch(() => { /* asserted below, with the value in the message */ });
  /*
   * A second and a half for the reachability probe, which is the thing that decides this panel.
   *
   * `relayAnswers` in `src/ui/NetLobby.ts` asks the relay's own `/health` before the lobby
   * believes the address the server named, and it is allowed to take it away again. Reading
   * the face before that answer lands would measure the optimistic state and call the arm green
   * whatever the relay was doing, which is exactly the class of check this pass exists to stop
   * writing.
   */
  await sleep(1500);
  const face = await lobbyFace(hostPage);
  const relayField = face.relayValue;
  measured.lan.face = face;
  await shot(hostPage, 'lan-00-lobby-no-transport');
  record('lan-lobby-says-nothing-about-transport',
    !!face.metaRelay && !face.relayShown && !face.relayReaches && !face.blockedShown
      && face.advPresent && !face.advOpen && face.createDisabled === false
      && !/wss?:\/\//.test(face.text),
    'served by `npm run host`, with a relay that answers, the lobby is a room code, a Create '
      + 'and a Join &mdash; and says nothing about transport at all',
    `the sheet reads: ${face.text.slice(0, 150)}`
      + ` [relay field shown=${face.relayShown} reaches=${face.relayReaches}, `
      + `disclosure present=${face.advPresent} open=${face.advOpen}, `
      + `refusal shown=${face.blockedShown}, CREATE disabled=${face.createDisabled}]`,
    'the owner read a RELAY ADDRESS field on this screen and asked what it was for; it fills '
      + 'itself in correctly here, which is precisely why he should never have seen it');

  const roomA = nextRoom();
  await hostPage.click('#tc-room');
  await hostPage.type('#tc-room', roomA, { delay: 20 });
  await hostPage.click('#tc-host');
  await hostPage.waitForSelector('#tc-code', { timeout: 20000 });
  const loopInvite = await hostPage.textContent('#tc-invite').catch(() => null);
  const loopHint = ((await hostPage.textContent('#tc-link-hint')) ?? '').replace(/\s+/g, ' ').trim();
  await shot(hostPage, 'lan-01-loopback-page');
  measured.lan.fromLoopback = { relayField, invite: loopInvite, hint: loopHint };
  record('lan-invite-survives-a-loopback-url-bar',
    relayField === lan.relayUrl && !!loopInvite && loopInvite.includes(lan.lan)
      && loopInvite.includes(roomA) && !/no invite link/i.test(loopHint),
    'a host who opened localhost still gets a link naming the address the other machine reaches',
    loopInvite
      ? `relay field became ${relayField}; link ${loopInvite}`
      : `no link — the relay field held ${relayField} and the screen said: ${loopHint.slice(0, 120)}`,
    'the page cannot know its own machine has a second address; <meta name=tc-lan> is the server saying so');

  /*
   * And from the LAN address itself, which is the one the host command actually prints.
   *
   * The invite is read off the screen and handed to the second client verbatim. Nothing in this
   * half of the arm builds a URL — that is the claim.
   */
  const roomB = nextRoom();
  await hostPage.goto(`${lanBase}/?mp=1`, { waitUntil: 'domcontentloaded' });
  await hostPage.waitForSelector('.tc-lobby', { timeout: 30000 });
  /*
   * The relay field again, and on this origin it is a *different* wrong answer.
   *
   * `defaultRelay()` guesses `ws://<whatever host served this page>:5959`, so on the LAN origin
   * it produces `ws://192.168.0.238:5959` — plausible, not loopback, and pointing at nothing
   * when the host chose another relay port. The first version of the plaque handler only
   * overruled loopback and this arm went red here, which is the reason `relayWasGuessed` exists.
   */
  await hostPage.waitForFunction(
    (want) => (document.querySelector('#tc-relay')?.value ?? '') === want,
    lan.relayUrl, { timeout: 10000 }
  ).catch(() => { /* the CREATE below reports it */ });
  await hostPage.click('#tc-room');
  await hostPage.type('#tc-room', roomB, { delay: 20 });
  await hostPage.click('#tc-host');
  await hostPage.waitForSelector('#tc-code', { timeout: 20000 });
  const invite = ((await hostPage.textContent('#tc-invite').catch(() => '')) ?? '').trim();
  const hasButton = await hostPage.evaluate(() => !!document.querySelector('#tc-copy-link'));
  await shot(hostPage, 'lan-02-room-open');
  measured.lan.invite = invite;
  record('lan-invite-carries-the-address-and-the-code',
    hasButton && invite.startsWith(`http://${lan.lan}:${lan.gamePort}/`)
      && invite.includes(`room=${roomB}`) && invite.includes(encodeURIComponent(lan.relayUrl)),
    'the link on the open-room screen names the LAN page, the LAN relay and this room',
    invite || 'there is no link on the screen and no button to copy one',
    'built from location.href, which is exactly right once the page is served on a LAN address');

  await hostPage.click('#tc-begin');
  await driveMenu(hostPage, { map: 'campus-martius', scenario: 'field', tier: 'high', size: 'small' });

  const guestPage = await newPage(chromeGuest);
  await guestPage.goto(invite, { waitUntil: 'domcontentloaded' });
  /*
   * Bounded, and the failure is read off the page rather than thrown.
   *
   * An invite that carries the right host and the wrong intent — the `host=0` dropped, say —
   * opens perfectly and then sits on the setup sheet as a second host, and the first version of
   * this reported that as a five-minute `waitForFunction` timeout with an empty log. The whole
   * point of §9.12's geometry checks was to stop a Playwright stack standing in for a finding.
   */
  const guestReady = await guestPage
    .waitForFunction(() => window.__game?.ready === true, null, { timeout: 150000 })
    .then(() => true).catch(() => false);
  let lh = null;
  let lg = null;
  if (guestReady) {
    await hostPage.evaluate(INSTALL);
    await guestPage.evaluate(INSTALL);
    for (const p of [hostPage, guestPage]) {
      await p.waitForFunction(() => ['deploy', 'battle'].includes(window.__net()?.phase),
        null, { timeout: 90000 }).catch(() => { /* read below, whatever state it is in */ });
    }
    lh = await hostPage.evaluate(() => window.__net() ?? null).catch(() => null);
    lg = await guestPage.evaluate(() => window.__net() ?? null).catch(() => null);
  }
  const showing = guestReady ? '' : await guestPage.evaluate(() =>
    (document.querySelector('.tc-lobby h1')?.textContent
      ?? document.querySelector('.menu h1, .menu-home')?.textContent
      ?? document.title).replace(/\s+/g, ' ').trim().slice(0, 80)).catch(() => 'nothing readable');
  // A second and a half, because the phase flips while the loading splash is still fading out
  // and the frame is then a title card with a session strip over it rather than a battle.
  if (guestReady) await sleep(1500);
  await shot(guestPage, 'lan-03-guest-followed-the-link');
  await shot(hostPage, 'lan-05-host-in-battle');
  measured.lan.met = { room: roomB, host: lh, guest: lg, guestReady, showing };
  record('lan-the-link-is-the-whole-invitation',
    lh?.room === roomB && lg?.room === roomB && lh.slot === 0 && lg.slot === 1
      && lh.myFaction !== lg.myFaction,
    'a second client given nothing but that link ends up on the other side of the same battle',
    guestReady
      ? `${invite.slice(0, 78)}… → room ${lg?.room}, slot ${lg?.slot}, commanding ${lg?.myFaction} `
        + `against slot ${lh?.slot}'s ${lh?.myFaction}`
      : `the link opened and no battle started in 150 s — the second client is showing "${showing}", `
        + 'which is what an invite that omits the challenger\'s side of it produces',
    'no code typed, no relay address entered, no URL written by this test');

  /*
   * The honesty check, and the reason it is in this arm rather than the lobby one.
   *
   * `base` is the run's ordinary dev server: `127.0.0.1`, no LAN bind, no `/__tc/lan`. Nothing
   * about it has changed and nothing about it should. If a link appears here it is a link to
   * the recipient's own machine, which is the failure the previous pass built the refusal for
   * — so this check going red is the signal that making the link possible has made it
   * unconditional.
   */
  const plain = await newPage(chrome);
  const plainRelay = await startRelay(5987);
  await plain.goto(`${base}/?mp=1`, { waitUntil: 'domcontentloaded' });
  await plain.waitForSelector('.tc-lobby', { timeout: 30000 });
  await openAdvanced(plain);
  await plain.fill('#tc-relay', plainRelay.base);
  await plain.click('#tc-room');
  await plain.type('#tc-room', nextRoom(), { delay: 20 });
  await plain.click('#tc-host');
  await plain.waitForSelector('#tc-code', { timeout: 20000 });
  const plainHint = ((await plain.textContent('#tc-link-hint')) ?? '').replace(/\s+/g, ' ').trim();
  const plainLink = await plain.evaluate(() => !!document.querySelector('#tc-copy-link'));
  const plainCode = ((await plain.textContent('#tc-code')) ?? '').trim();
  await shot(plain, 'lan-04-no-lan-server');
  measured.lan.withheld = { hint: plainHint, hasButton: plainLink, code: plainCode };
  record('lan-no-lan-server-still-withholds-the-link',
    !plainLink && /no invite link/i.test(plainHint) && /127\.0\.0\.1/.test(plainHint)
      && /npm run host/.test(plainHint) && plainCode.length === 5,
    'a server bound only to loopback offers no link, says which address is the problem, '
      + 'and names the command that fixes it',
    plainLink ? `A COPY THE INVITE LINK button appeared on a loopback-only server. ${plainHint.slice(0, 120)}`
      : plainHint.slice(0, 210) || 'the screen said nothing about the link at all',
    'the previous pass withheld the link and this one must not turn that into "usually works"');

  record('lan-console', hostPage.__errs.length === 0 && guestPage.__errs.length === 0
    && plain.__errs.length === 0,
    'and no page in the LAN flow raised a console error',
    [...hostPage.__errs, ...guestPage.__errs, ...plain.__errs].slice(0, 3).join(' ; ') || 'clean');

  await hostPage.close(); await guestPage.close(); await plain.close();
  plainRelay.stop();
  }
  lan.stop();
}

/*
 * `npm run dev`, which is the command the owner ran, and the answer the lobby used to give it.
 *
 * ## Why this arm runs `vite` itself instead of using `base`
 *
 * `base` is a `tools/lib/vite-runner.mjs` server with no relay port, so its document has no
 * `<meta name="tc-relay">` in it either and the lobby answers it identically. That is a
 * *stand-in*, and the claim being made here is about a command in `package.json` — so the arm
 * spawns `"dev": "vite"`'s own binary, with vite's own config, no plugins of ours, and asserts
 * against the document that produces. If some future pass makes `vite.config.ts` announce a
 * relay, this goes red and the stand-in never would.
 *
 * ## What was wrong, and why it was worse than a bug
 *
 * `defaultRelay()` returned `ws://<whatever host served this page>:5959`, so `npm run dev` on
 * `localhost:5173` filled the field with `ws://localhost:5959` — well-formed, plausible, and
 * pointing at a process `npm run dev` does not start. Nothing was broken; the form simply
 * answered a question it could not answer, in a field the player had no reason to think about.
 * The failure arrived later, at CREATE, phrased as though the player had typed it wrong.
 *
 * ## In through the front door
 *
 * The root URL and a click on MULTIPLAYER, not `?mp=1`. That is the sequence being reported —
 * *"if someone opens the dev server and clicks Multiplayer"* — and the arm should walk it.
 *
 * The last check is the one that keeps the capability honest: with the disclosure opened and a
 * real relay's address typed into it, this same page opens a room. Demoted, not deleted.
 */
if (wanted('dev')) {
  console.log('\n=== npm run dev, which starts a Vite and nothing else ===');
  const dev = startDevVite(DEV_PORT);
  const devBase = `http://127.0.0.1:${DEV_PORT}`;
  const up = await waitForServer(`${devBase}/`, 120000);
  if (!up) {
    record('dev-arm-can-run', false,
      'this arm needs `npm run dev`\'s own vite on a port nobody else has',
      `nothing answered ${devBase}/ in 120 s — ${dev.log().trim().slice(0, 200) || 'it said nothing'}`,
      'rerun with --dev-port= for a free one; four Playwright timeouts is not four findings');
    dev.stop();
  } else {
    // 5990, not one of the 5985–5989 the `lag`, `lobby` and default arms cycle through: those
    // are stopped and restarted within a run, and a SIGTERM'd listener that has not yet let the
    // port go turns an arm about a lobby into an arm about port allocation.
    const relay = await startRelay(5990);
    const page = await newPage(chrome);
    await page.goto(`${devBase}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.menu.at-home .dest-multiplayer', { timeout: 120000 });
    await page.click('.menu-home .dest-multiplayer');
    await page.waitForSelector('.tc-lobby', { timeout: 30000 });
    // Longer than any probe could take, so "nothing appeared" means nothing was going to.
    await sleep(1500);
    const face = await lobbyFace(page);
    await shot(page, 'dev-01-lobby');
    measured.dev = { origin: face.origin, face, errs: page.__errs.slice(0, 4) };

    record('dev-server-offers-no-relay-address',
      face.metaRelay === null && face.metaLan === null && face.relayValue === ''
        && !face.relayShown && !face.relayReaches && !/wss?:\/\//.test(face.text)
        && face.createDisabled === true,
      'a dev server with no relay beside it puts no address on the screen and none in the field',
      `${face.origin}: the field holds ${JSON.stringify(face.relayValue)} and is `
        + `${face.relayShown ? 'ON SCREEN' : 'behind the disclosure'}; the sheet reads: `
        + face.text.slice(0, 130),
      'it used to read ws://localhost:5959 here — well-formed, plausible, and nothing behind it');

    record('dev-server-names-the-command-that-works',
      face.blockedShown && /no relay behind this page/i.test(face.blockedText)
        && /npm run host/.test(face.blockedText)
        && /serving the game and nothing else/i.test(face.blockedText),
      'it says so where the player is looking, and names the one command that fixes it',
      face.blockedShown ? face.blockedText.slice(0, 230)
        : 'nothing on the panel says why a battle cannot start from here',
      'a refusal that does not name the thing that would work is only half honest');

    /*
     * And the capability, exercised rather than asserted.
     *
     * The relay this presses CREATE against is on 5986 and has nothing to do with the server
     * serving the page, which is the case the field exists for: `npm run host -- --relay-port=`,
     * or a relay on a third machine. If demoting it into a `<details>` had broken it, this is
     * the check that says so.
     */
    await openAdvanced(page);
    await page.fill('#tc-relay', relay.base);
    const enabled = await page.evaluate(() => !document.querySelector('#tc-host')?.disabled);
    const devRoom = nextRoom();
    await page.click('#tc-room');
    await page.type('#tc-room', devRoom, { delay: 20 });
    await shot(page, 'dev-02-advanced-open');
    await page.click('#tc-host');
    const opened = await page.waitForSelector('#tc-code', { timeout: 20000 })
      .then(() => true).catch(() => false);
    const shownCode = opened ? ((await page.textContent('#tc-code')) ?? '').trim() : '';
    const rs = await relayStatus(relay);
    await shot(page, 'dev-03-room-open');
    measured.dev.advanced = { enabled, room: devRoom, shown: shownCode };
    record('dev-server-still-lets-you-point-at-a-relay',
      enabled && shownCode === devRoom && !!rs?.rooms?.some((r) => r.code === devRoom),
      'and the address field survives, one disclosure click away, still able to reach a relay '
        + 'this page\'s server knows nothing about',
      enabled
        ? `typing ${relay.base} into the disclosure re-armed CREATE; the room is ${shownCode
          || '(none)'} and the relay holds ${(rs?.rooms ?? []).map((r) => r.code).join(', ') || 'nothing'}`
        : 'an address in the disclosure left CREATE disabled — the capability is gone, not demoted',
      'npm run host -- --relay-port= is a real case, and hiding a control is not deleting it');

    record('dev-server-lobby-console', page.__errs.length === 0,
      'and the page raised no console error at all &mdash; nothing was probed, because nothing '
        + 'named an address to probe',
      page.__errs.slice(0, 3).join(' ; ') || 'clean',
      'a probe fired on a page with no relay would write ERR_CONNECTION_REFUSED on every visit');

    await page.close();
    relay.stop();
    dev.stop();
  }
}

/*
 * An origin that has told the page nothing about itself — which is the deployed site's shape.
 *
 * `tools/deploy-vercel.mjs` uploads a static tree. There is no `vite-runner` behind it, so
 * neither meta tag exists; there is no relay and there cannot be one; and the origin is not
 * this machine's loopback, which is the fact that separates it from the `dev` arm and changes
 * the sentence the lobby has to say. `npm run dev -- --host`, reached at the LAN address, is
 * that document from the page's point of view: no tags, no relay, not loopback. The one thing
 * it is not is HTTPS, and nothing in this path branches on the scheme — `docs/MULTIPLAYER.md`
 * §10.2 measured what HTTPS does to a `ws://` socket, and that is a different refusal on a
 * different screen.
 *
 * **It is asserted to be non-loopback, in the pass condition and not just in the log.** An
 * earlier version of this gate had all 54 of its checks talking to `127.0.0.1` while claiming
 * to measure a LAN product. A check whose subject is an origin has to prove which origin it
 * got.
 */
if (wanted('static')) {
  console.log('\n=== an origin with no server of ours behind it ===');
  const pick = lanAddress({});
  const st = pick ? startDevVite(STATIC_PORT, ['--host']) : null;
  const staticBase = pick ? `http://${pick.ip}:${STATIC_PORT}` : '';
  const up = pick ? await waitForServer(`${staticBase}/`, 120000) : false;
  if (!up) {
    record('static-arm-can-run', false,
      'this arm needs a server on a non-loopback address of this machine',
      pick
        ? `nothing answered ${staticBase}/ in 120 s — ${st.log().trim().slice(0, 200) || 'it said nothing'}`
        : 'no private IPv4 interface on this machine, so there is no non-loopback origin to use',
      'measuring this over loopback would be the exact mistake this arm exists to rule out');
    st?.stop();
  } else {
    const page = await newPage(chromeGuest);
    await page.goto(`${staticBase}/?mp=1`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.tc-lobby', { timeout: 60000 });
    await sleep(1500);
    const face = await lobbyFace(page);
    await shot(page, 'static-01-lobby');
    const offMachine = face.origin === staticBase && !/\/\/(localhost|127\.|\[?::1)/.test(face.origin);
    measured.static = { origin: face.origin, offMachine, face, errs: page.__errs.slice(0, 4) };

    record('static-origin-offers-no-relay-address',
      offMachine && face.metaRelay === null && face.metaLan === null
        && face.relayValue === '' && !face.relayShown && !face.relayReaches
        && !/wss?:\/\//.test(face.text) && face.createDisabled === true,
      'an origin that has said nothing about itself gets no address, no field on screen, and '
        + 'no button that would fail',
      `${face.origin} (asserted off-loopback: ${offMachine}), no tc-lan and no tc-relay in the `
        + `document; the field holds ${JSON.stringify(face.relayValue)}`,
      'the deployed site got this half right already — empty and honest — while still asking '
        + 'the player to fill a form field in');

    record('static-origin-keeps-the-sentence-that-was-right',
      face.blockedShown && /static upload with no server in it/.test(face.blockedText)
        && /npm run host/.test(face.blockedText)
        && !/stop this server/i.test(face.blockedText),
      'and it still says what this page *is*, which is what explains why no typing will help',
      face.blockedShown ? face.blockedText.slice(0, 230)
        : 'nothing on the panel says why a battle cannot start from here',
      'telling somebody on a static host to stop their server names a process they do not have');

    record('static-origin-lobby-console', page.__errs.length === 0,
      'and nothing was probed, so the deployed site logs no network error on a lobby visit',
      page.__errs.slice(0, 3).join(' ; ') || 'clean',
      'the meta tag exists instead of a fetch for exactly this reason; the probe inherits it');

    await page.close();
    st.stop();
  }
}

/*
 * A code nobody opened. The relay knew; before this, nobody told the player.
 *
 * `roomFor` created on demand, so a mistyped code conjured a second empty room and the
 * challenger waited in it — no timeout, no message, no way back, for as long as they were
 * willing to sit there. This arm goes red the moment that silence comes back: its pass
 * condition is a *named* refusal with a way onward, inside twenty-five seconds.
 */
if (wanted('badcode')) {
  console.log('\n=== a code nobody opened ===');
  const relay = await startRelay(5988);
  const page = await newPage(chromeGuest);
  await page.goto(`${base}/?mp=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.tc-lobby', { timeout: 30000 });
  await openAdvanced(page);
  await page.fill('#tc-relay', relay.base);
  await page.click('#tc-room');
  await page.type('#tc-room', 'ZZZZZ', { delay: 20 });
  const t0 = Date.now();
  await page.click('#tc-join');
  let told = null;
  while (Date.now() - t0 < 25000) {
    told = await page.evaluate(() => {
      const h = document.querySelector('.tc-lobby h1');
      if (!h || !/would not|no relay/i.test(h.textContent ?? '')) return null;
      const b = document.querySelector('.tc-lobby a[href*="mp=1"]');
      return {
        title: (h.textContent ?? '').trim(),
        body: (document.querySelector('.tc-sheet')?.textContent ?? '').replace(/\s+/g, ' ').trim(),
        back: b ? b.getAttribute('href') : null,
      };
    }).catch(() => null);
    if (told) break;
    await sleep(300);
  }
  const waited = Date.now() - t0;
  await shot(page, 'lobby-06-wrong-code');
  measured.badcode = { told, waitedMs: waited, errs: page.__errs.slice(0, 3) };
  record('wrong-code-is-refused',
    !!told && /ZZZZZ/.test(told.body ?? '') && waited < 25000,
    'a code nobody opened is refused by name in a sentence, instead of waiting for ever',
    told ? `after ${(waited / 1000).toFixed(1)} s: ${told.body.slice(0, 150)}`
      : `nothing said anything in ${(waited / 1000).toFixed(1)} s — this is the silent wait`,
    'the relay always knew; what was missing was anybody telling the person who typed it');
  record('wrong-code-has-a-way-back',
    !!told?.back && /mp=1/.test(told.back) && /room=ZZZZZ/.test(told.back),
    'and the way out carries the code back to the form, so a typo is one correction',
    told?.back ? told.back : 'there is no link off this screen',
    'the previous screen offered the browser back button and nothing else');
  record('wrong-code-no-pageerror',
    page.__errs.filter((e) => e.startsWith('pageerror')).length === 0,
    'and nothing about the refusal reaches window.onerror',
    page.__errs.slice(0, 2).join(' ; ') || 'clean',
    'the old path threw at module top level, which every gate in tools/ collects as a failure');
  await page.close();
  relay.stop();
}

/*
 * Nothing listening at all, from both directions.
 *
 * Two different failures wearing one sentence until now. Through the form it reported *"No
 * relay at ws://… — start one with node tools/relay.mjs"* even when the relay was running and
 * had answered; through a battle URL it threw at module top level, which reached
 * `window.onerror`, and painted the failure in red capitals across the title card with no
 * control anywhere on the page.
 *
 * No relay is started here, deliberately. 5901 was one of the ports six other agents' dev
 * servers were scattered through, so the arm first proves nothing is on it and says why it
 * cannot run rather than reporting a dead relay it did not actually have.
 */
if (wanted('norelay')) {
  console.log('\n=== nothing listening ===');
  const DEAD = 'ws://127.0.0.1:5901';
  const occupied = await fetch('http://127.0.0.1:5901/health').then(() => true).catch(() => false);
  if (occupied) {
    record('no-relay-says-so', false, 'port 5901 has something on it, so this arm cannot run',
      'something answered http://127.0.0.1:5901/health', 'rerun when it is free');
  } else {
    const form = await newPage(chrome);
    await form.goto(`${base}/?mp=1`, { waitUntil: 'domcontentloaded' });
    await form.waitForSelector('.tc-lobby', { timeout: 30000 });
    await openAdvanced(form);
    await form.fill('#tc-relay', DEAD);
    await form.click('#tc-host');
    await form.waitForSelector('#tc-note.tc-bad', { timeout: 20000 }).catch(() => { /* asserted */ });
    const said = ((await form.textContent('#tc-note')) ?? '').replace(/\s+/g, ' ').trim();
    const stillHere = await form.evaluate(() => !!document.querySelector('#tc-host'));
    await shot(form, 'lobby-07-no-relay-form');
    record('no-relay-says-so', /5901/.test(said) && /No answer from/.test(said) && stillHere,
      'CREATE names the address that did not answer and leaves you on the form to fix it',
      said.slice(0, 170) || 'the form said nothing at all',
      'it used to blame a relay that was running, and it navigated away from the field to edit');

    const direct = await newPage(chromeGuest);
    await direct.goto(`${base}/?net=${encodeURIComponent(DEAD)}&room=QAQQQ&host=0`,
      { waitUntil: 'domcontentloaded' });
    await direct.waitForSelector('.tc-lobby h1', { timeout: 40000 }).catch(() => { /* asserted */ });
    const sheet = ((await direct.textContent('.tc-sheet').catch(() => '')) ?? '')
      .replace(/\s+/g, ' ').trim();
    const way = await direct.getAttribute('.tc-lobby a[href*="mp=1"]', 'href').catch(() => null);
    await shot(direct, 'lobby-08-no-relay-direct');
    measured.norelay = { form: said, direct: sheet, back: way,
      errs: [...form.__errs, ...direct.__errs] };
    record('no-relay-is-a-screen-and-not-a-splash',
      /No relay answered/i.test(sheet) && /5901/.test(sheet) && !!way,
      'and a battle URL pointed at nothing gets a refusal with a way back, not a red splash',
      sheet.slice(0, 170) || 'nothing was drawn',
      'a relayed battle cannot start without a relay; saying so is not the same as crashing');
    /*
     * `pageerror` only, and the browser's own network log is allowed to be noisy.
     *
     * A refused TCP connection writes two `console.error` lines nothing in this repository
     * emits or can suppress — "Failed to load resource: net::ERR_CONNECTION_REFUSED" and the
     * WebSocket equivalent — and counting those would make an honest failure report look like
     * a defect. What must not appear is an *uncaught exception*, which is what a top-level
     * throw on this path produced, and it is reported by name so the reason is legible.
     */
    const thrown = [...form.__errs, ...direct.__errs].filter((e) => e.startsWith('pageerror'));
    record('no-relay-no-pageerror', thrown.length === 0,
      'neither path raises an uncaught exception',
      thrown.slice(0, 2).join(' ; ')
        || `clean (${form.__errs.length + direct.__errs.length} network console line(s), which `
          + 'the browser writes for a refused connection and nothing here can prevent)',
      'main.ts spends a paragraph on why the lobby must not throw; this is the other branch');
    await form.close(); await direct.close();
  }
}

// ---------------------------------------------------------------------------
// Arm: what the input delay costs at a realistic latency
// ---------------------------------------------------------------------------

if (wanted('lag')) {
  console.log('\n=== what the delay costs at a realistic round trip ===');
  const rows = [];
  for (const [row, oneWay] of [0, 25, 60].entries()) {
    const relay = await startRelay(5985 + row, [`--lag=${oneWay}`, '--quiet']);
    const { host, guest } = await bootMatch(relay);
    await deployWith(host, `lag${oneWay}-h`);
    await deployWith(guest, `lag${oneWay}-g`);
    await sleep(1200);
    for (let i = 0; i < 3; i++) { await burst(host, i); await sleep(1200); }
    const n = await host.evaluate(() => window.__net());
    const lat = n.lat ?? [];
    const mean = (xs) => (xs.length ? xs.reduce((p, c) => p + c, 0) / xs.length : 0);
    rows.push({
      oneWayMs: oneWay,
      rttMs: +mean(lat.map((l) => l.rttMs)).toFixed(1),
      delayTicks: +mean(lat.map((l) => l.delayTicks)).toFixed(2),
      delayMs: +(mean(lat.map((l) => l.delayTicks)) * 33.33).toFixed(0),
      stalls: n.stalls,
      stalledMs: n.stalledMs,
      samples: lat.length,
    });
    console.log(`  one-way ${oneWay} ms → round trip ${rows.at(-1).rttMs} ms, `
      + `${rows.at(-1).delayTicks} ticks (${rows.at(-1).delayMs} ms), `
      + `${n.stalls} stall(s) totalling ${n.stalledMs} ms`);
    await host.close(); await guest.close();
    relay.stop();
  }
  measured.lag = rows;
  const worst = rows.at(-1);
  record('delay-holds', rows.every((r) => r.samples >= 2)
    && worst.delayTicks <= 12 && worst.stalledMs < 20000,
    'the input delay is bounded and the link does not stall the battle at 120 ms round trip',
    rows.map((r) => `${r.oneWayMs}ms→${r.delayTicks} ticks/${r.stalledMs}ms stalled`).join('  '),
    'the relay defers a late op to the next open turn; there is no path that drops one');
}

// ---------------------------------------------------------------------------
// Arm: two engines, which is a real desync rather than an injected one
// ---------------------------------------------------------------------------

if (wanted('xengine')) {
  console.log('\n=== Chromium against Firefox: a divergence nobody chose ===');
  /*
   * The best fixture available, and it is better than the one-ULP poke.
   *
   * A synthetic perturbation tests the detector against a fault whose tick, unit and magnitude
   * the test chose. This one tests it against real floating-point disagreement, at a moment
   * nobody picked. Either outcome is informative and only one is a failure:
   *
   *   - the two engines agree for the whole run  → the pairing holds on this battle, say so;
   *   - they disagree and the session detects, attributes and ends  → the design works;
   *   - they disagree and nothing notices        → RED, and the whole safety net is decorative.
   *
   * The relay runs at a five-times turn rate so a fork three and a half minutes into the battle
   * is reachable inside a minute of wall clock. That is not a determinism shortcut: turn length
   * is wall-clock scheduling and the tick index is unaffected — the same battle, sooner.
   */
  let ff = null;
  try {
    // A third slot, on top of the two the host and challenger already hold. Cap is 4, so this
    // peaks at three and leaves one for whatever else is on the machine.
    ff = await launchBrowser({ label: 'qa-net/xengine-firefox', engine: 'firefox', port: PORT, root: ROOT });
    browsers.push(ff);
  } catch (e) {
    record('xengine', false, 'Firefox is needed for the cross-engine arm and did not launch',
      String(e).slice(0, 160),
      'npx playwright install firefox');
  }
  if (ff) {
    /*
     * Real-time turns here, not the accelerated ones the first version used.
     *
     * At a 33 ms turn the relay ran 215 turns while Firefox — 8,632 men, a second browser on
     * the same laptop — reached tick 30, and a client that far behind is a client with no main
     * thread left to process the desync message it has already been sent. The divergence
     * happens at tick 30 whatever the turn rate, so there was nothing to gain by hurrying: the
     * fixture needs the first second of the battle, not the first four minutes of it.
     */
    const relay = await startRelay(5999, ['--max-lag-turns=6000', '--quiet']);
    /*
     * `autoplay=1`: both armies under AI command, identically on both clients.
     *
     * Not a shortcut — a necessity, and the reason is what the first run of this arm measured.
     * With neither player faction commanded and no orders issued, 8,632 men stood still for
     * 262 simulated seconds and nobody died; the two engines agreed perfectly and the run
     * proved nothing, because the escape §1.1 measured at t+205.5 comes out of *combat*. The
     * AI's plan is derived from the config and the seed, so both clients run the same one, and
     * what this arm then measures is exactly what it claims to: two engines executing one
     * relayed battle with a real melee in it.
     */
    const { host, guest } = await bootMatch(relay, {
      deploy: false, guestBrowser: ff, size: XSIZE, autoplay: 1,
    });
    const t0 = Date.now();
    let n = null;
    let ng = null;
    while (Date.now() - t0 < 240000) {
      n = await host.evaluate(() => window.__net());
      ng = await guest.evaluate(() => window.__net());
      if (n?.desync || n?.ended) break;
      const t = await host.evaluate(() => window.__mark().tick);
      if (t > XTICKS) break;                     // t+50 by default; the fork is at tick 30
      await sleep(600);
    }
    /*
     * Let the ending finish arriving before asking whether it arrived.
     *
     * A desync is three messages, not one: `desync`, then `wantProbe` and the two `probe`
     * replies, then `attrib` and `end`. The loop above breaks on the *first* of those, so
     * reading `ended` immediately caught the session mid-sentence — the arm reported a real
     * divergence, correctly detected, as a failure, on the strength of a field that was about
     * to be set. Poll for the conclusion rather than assuming it.
     */
    /*
     * Settle to a common tick before comparing, or the comparison is meaningless.
     *
     * The first version of this read both clients' hashes wherever they happened to be, got
     * 7,846 against 7,848, and reported a pool-hash difference as a cross-engine divergence.
     * It was two ticks of a battle, not two engines. The relay's own per-second comparison —
     * which *is* at equal ticks — had said nothing, and that disagreement between the two
     * instruments is what caught it.
     */
    const settled = await settleTogether(host, guest, 60000, relay);
    /*
     * Re-read the status after settling, and not before.
     *
     * The loop above exits on the *host's* tick target, which can happen seconds before the
     * relay has finished comparing the checkpoints that matter — so the `n` it leaves behind is
     * stale, and asserting on a stale status reported a session that had correctly declared a
     * desync as one that had noticed nothing. Read it again after the battle has stopped moving.
     */
    n = await host.evaluate(() => window.__net());
    ng = await guest.evaluate(() => window.__net());
    if ((n?.desync || ng?.desync) && !(n?.ended && ng?.ended)) {
      const untilEnded = Date.now() + 40000;
      while (Date.now() < untilEnded) {
        n = await host.evaluate(() => window.__net());
        ng = await guest.evaluate(() => window.__net());
        if (n?.ended && ng?.ended) break;
        await sleep(300);
      }
    }
    const ma = await host.evaluate(() => window.__mark());
    const mb = await guest.evaluate(() => window.__mark());
    const ta = ma.tick;
    const tb = mb.tick;
    const ha = ma;
    const hb = mb;
    void settled;
    const rs = await relayStatus(relay);
    const d = n?.desync ?? null;
    measured.xengine = {
      size: XSIZE, men: ha.count,
      hostTick: ta, guestTick: tb, desync: d,
      ended: [n?.ended, ng?.ended], frames: [n?.got, ng?.got],
      ceiling: [n?.ceiling, ng?.ceiling], readyTurn: [n?.readyTurn, ng?.readyTurn],
      status: [n, ng], relay: rs?.rooms?.[0] ?? null,
      hashes: { chromium: ha, firefox: hb },
      lastAgreedTick: rs?.rooms?.[0]?.lastAgreedTick ?? -1,
    };
    if (d) {
      console.log(`  Firefox and Chromium parted at tick ${d.tick} (t+${(d.tick / 30).toFixed(1)} s) `
        + `on ${d.layer}; last agreed tick ${d.lastAgreedTick}`);
      record('xengine', d.tick > 0 && (n?.ended === 'desync') && (ng?.ended === 'desync'),
        'a real cross-engine divergence is detected, attributed and ended on both clients',
        `parted at tick ${d.tick} (t+${(d.tick / 30).toFixed(1)} s) on ${d.layer}: `
          + `${d.mine} against ${d.theirs}; last agreed tick ${d.lastAgreedTick}; ${d.note}`
          + `${d.units.length ? `; regiments ${d.units.slice(0, 8).join(', ')}` : ''}`,
        'nobody chose where or when this happened, which is what makes it worth more '
          + 'than the injected arm');
    } else {
      const same = ta === tb && ha.hash === hb.hash && ha.uf64 === hb.uf64
        && ha.uctl === hb.uctl && ha.alive === hb.alive;
      record('xengine', same && ta > 3000,
        'Chromium and Firefox ran the same battle for the whole run',
        `${ha.count} men, tick ${ta}/${tb} (t+${(ta / 30).toFixed(0)} s): `
          + `pool ${ha.hash}/${hb.hash}, uf64 ${ha.uf64}/${hb.uf64}, `
          + `uctl ${ha.uctl}/${hb.uctl}, alive ${ha.alive}/${hb.alive}`,
        'no fork inside this run — one seed, one machine, and a stronger result than the '
          + 'pairing table claims');
    }
    await host.close(); await guest.close();
    relay.stop();
  }
}

// ---------------------------------------------------------------------------
// What this run actually covered — asserted, not assumed
// ---------------------------------------------------------------------------

/*
 * The check that makes the blind spot impossible to reintroduce quietly.
 *
 * `covered` is filled from the **challenger's** own config on every `bootMatch`, so it records
 * the battles two clients really stood in rather than the arguments this file passed. A full
 * run must contain at least one `field` and at least one `assault`; if somebody deletes the
 * siege arm, narrows it, or breaks the path by which a siege config crosses the wire, the
 * count of green checks does not quietly stay the same — this one goes red and says which
 * scenario is missing.
 *
 * It runs whenever the run contains **both** the `battle` and the `siege` arm — which every
 * default run does, and which `--only=battle,siege` does deliberately and cheaply. A run
 * narrowed to one of them is not making a coverage claim, and a gate that punishes you for
 * debugging a single arm is a gate people stop running.
 */
if (wanted('battle') && wanted('siege')) {
  const kinds = new Set(covered.map((c) => c.scenario));
  const want = ['field', 'assault'];
  const missing = want.filter((k) => !kinds.has(k));
  measured.coverage = { covered, kinds: [...kinds], missing };
  record('net-coverage', missing.length === 0 && covered.length >= 2,
    'this run relayed both a field battle and a siege, and read that off the challenger',
    missing.length
      ? `no relayed ${missing.join(' or ')} in this run — covered: `
        + `${covered.map((c) => `${c.map}/${c.scenario}`).join(', ') || '(nothing)'}`
      : `${covered.length} match(es): ${[...new Set(covered.map((c) => `${c.map}/${c.scenario}`))].join(', ')}`,
    'qa-replay reported 21/21 for weeks while never once recording a siege — §9.9, and the '
      + 'reason this check exists at all');
}

cleanup();

if (results.length === 0) {
  console.log('\n✗ no checks ran — nothing was measured');
  failed = 1;
}
console.log(`\n${failed === 0 ? '✓' : '✗'} ${results.length - failed}/${results.length} checks passed`);
if (JSON_OUT) {
  await writeFile(path.resolve(ROOT, JSON_OUT), JSON.stringify({ results, measured }, null, 2));
  console.log(`wrote ${JSON_OUT}`);
}
process.exit(failed === 0 ? 0 : 1);
