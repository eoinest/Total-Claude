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

import { launchBrowser, startVite } from './lib/browser-budget.mjs';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { lanAddress } from './lib/lan-address.mjs';
import { bootThroughMenu, driveMenu, ensureServer, waitForServer } from './lib/menu-boot.mjs';
/*
 * The page-side hooks and the mouse gestures, which used to live in this file.
 *
 * They moved to `tools/lib/net-drive.mjs` on 2 Sep 2026 when a second netcode gate appeared
 * (`tools/qa-p2p.mjs`, for the peer-to-peer transport). Every gesture is identical between the
 * two, because a *player* does the identical thing either way — same lobby, same plaque, same
 * right-click — and two copies of `deployWith` would start with its three hard-won lessons and
 * lose them one at a time. Nothing about the behaviour changed in the move; the functions are
 * the same functions, and the run below is the check on that.
 */
import {
  drivers, INSTALL, lobbyFace, logDiff, markDisagreement, openAdvanced, readBoth,
} from './lib/net-drive.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const ARMS = ['proto', 'qr', 'battle', 'siege', 'lobby', 'lan', 'https', 'dev', 'static', 'ghost',
  'badcode', 'norelay', 'drop', 'dup', 'swap', 'ulp', 'late', 'leave', 'lag', 'xengine'];
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
  'static-port', 'ghost-port', 'ghost-relay', 'https-port', 'https-relay'];

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
/*
 * The `ghost` arm's pair: a real `vite-runner` on 5945 told to advertise a relay on 5991, and
 * **nothing started on 5991**. The gap between those two numbers is the arm.
 *
 * 5945 and not 5941, which was the first choice: `tools/qa-freeze.mjs` defaults to `--port=5941`
 * and the two gates run back to back in the same sweep. `startVite` would have refused the
 * second one by tree identity rather than silently measuring the first, so this would have
 * surfaced — as a red arm about port allocation, in the gate that had nothing to do with it.
 */
const GHOST_PORT = Number(args.get('ghost-port') ?? 5945);
const GHOST_RELAY = Number(args.get('ghost-relay') ?? 5991);
/*
 * The `https` arm's pair, and the reason it cannot borrow anything.
 *
 * It puts a TLS front end on 5946 in front of a `vite-runner` on 5947, both bound to the LAN
 * address, and points the page at a *real* relay on 5983 at that same address. Everything about
 * the arm depends on the page's origin being `https://192.168.1.77:5946` and the relay's being
 * a plain private address, so neither half can be a loopback listener somebody else started.
 */
const HTTPS_PORT = Number(args.get('https-port') ?? 5946);
const HTTPS_RELAY = Number(args.get('https-relay') ?? 5983);
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
/**
 * One extra Chromium flag, for one host and port, and it is the whole of the `https` arm.
 *
 * ## What was measured, and why the arm could not work without it
 *
 * The deployed site's refusal is **not** a mixed-content refusal *in Chromium*, and this pass
 * found that out the hard way by building the fixture and watching it pass when it should not
 * have. It is one in WebKit, where the original §10.2 explanation holds exactly as written —
 * so what follows is a statement about Chromium 151 and is labelled as one. Measured here from
 * an https page whose own origin is a private address:
 *
 *     ws://192.168.1.77:5968   opened
 *     ws://127.0.0.1:5968      opened
 *     ws://1.1.1.1:81          threw SecurityError  (Mixed Content)
 *
 * So in Chromium an https page **can** open a plain socket to a private address, as long as the
 * page itself came from one. The rule Chromium applies is about *address spaces*: a document is
 * refused a connection that reaches from a more public space into a more private one, and mixed
 * content blocks the rest. **WebKit does not have that carve-out** — the same three targets all
 * come back refused, loopback included — so this override is what makes the fixture faithful to
 * Chromium, and WebKit would have needed no help. The engine matters and the arm says so. `total-claude.vercel.app` is public and the relay is private, which is the
 * one combination that is refused — `tools/host-lan.mjs`'s docstring records the same error
 * from the live site, `ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS`.
 *
 * A fixture on this LAN is private by construction and therefore cannot reproduce it. That is
 * not a detail: without this flag the arm's socket check passes for the wrong reason and would
 * go on passing if the product's whole premise were wrong.
 *
 * `--ip-address-space-overrides` is Chromium's own switch for exactly this, and it is what the
 * web-platform tests for Local Network Access use. It names **one host and one port** — the
 * `https` arm's TLS front end, which no other arm touches — and declares that endpoint public.
 * With it, the same three targets come back:
 *
 *     ws://192.168.1.77:5968   ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS
 *     ws://127.0.0.1:5968      ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS
 *     ws://1.1.1.1:81          threw SecurityError
 *
 * Empty when this machine has no LAN address, in which case the arm refuses to run at all
 * rather than measure loopback.
 */
const PUBLIC_ORIGIN_OVERRIDE = (() => {
  const ip = lanAddress()?.ip;
  return ip ? [`--ip-address-space-overrides=${ip}:${HTTPS_PORT}=public`] : [];
})();

const chrome = await launchBrowser({
  label: 'qa-net/host', engine: 'chromium',
  args: ['--hide-scrollbars', ...PUBLIC_ORIGIN_OVERRIDE], port: PORT, root: ROOT,
});
browsers.push(chrome);
const chromeGuest = await launchBrowser({
  label: 'qa-net/guest', engine: 'chromium', args: ['--hide-scrollbars'], port: PORT, root: ROOT,
});
browsers.push(chromeGuest);

// ---------------------------------------------------------------------------
// Page-side readers. Read-only: every order below goes through page.mouse.
// ---------------------------------------------------------------------------

const shot = async (page, name) => {
  if (SHOT_DIR) await page.screenshot({ path: path.join(SHOT_DIR, `${name}.png`) });
};

// Bound once to this run's viewport and screenshot sink. See `tools/lib/net-drive.mjs`.
const { newPage, deployWith, burst, doubleOrder } = drivers({ W, H, shot });

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

const relayStatus = async (relay) =>
  fetch(`${relay.http}/status`).then((r) => r.json()).catch(() => null);

// ---------------------------------------------------------------------------
// Arm: the square, read back by a decoder that is not ours
// ---------------------------------------------------------------------------

/*
 * The QR, measured at the far end rather than at the near one.
 *
 * `src/net/qr.ts` produces a matrix, and it would be easy — and worthless — to assert things
 * about the matrix. What a guest points a camera at is a *rendering*, and the two renderings
 * this product ships are unlike each other: an SVG on a laptop screen and half-block glyphs in
 * a terminal. So every check below renders, turns the rendering into an image, and hands the
 * image to **Vision**, which is Apple's barcode decoder and the one an iPhone camera runs.
 * Nothing here reads our own encoder back with our own code; that would prove only that it
 * agrees with itself, and this repository has shipped that check before.
 *
 * Two of the five carry a control, which is the cheapest way to keep a check honest.
 * `qr-survives-a-thumb` blanks the same corner of the same payload at level Q and at level L
 * and requires the second to *fail*, so it is measuring error correction rather than the
 * decoder's patience — and it goes red if somebody quietly drops the level to save four
 * modules. `qr-every-version` fills all forty (version, level) pairs to capacity, which is what
 * stands in for auditing the block table by eye: a wrong digit in it moves a block boundary and
 * the symbol comes back as something other than what went in.
 *
 * No browser and no server: the arm is a few milliseconds of encoding, some `sharp` calls and
 * one `swift` process. It runs first, so a broken encoder is known before anything expensive
 * starts.
 */
if (wanted('qr')) {
  console.log('\n=== the square, decoded by Vision rather than by us ===');
  const { blockPlan, capacityBytes, qrEncode, qrHalfBlocks, qrSvg, QUIET, TOTAL_CODEWORDS }
    = await import('../src/net/qr.ts');
  const { decodeQr, halfBlocksToPixels, halfBlocksToPng, qrPng, quietRings, svgRings, svgToPng }
    = await import('./lib/qr-image.mjs');
  /*
   * Two directories, because they hold two different kinds of thing. `work` takes the forty
   * grid symbols, which are an intermediate nobody looks at; `dir` takes the handful a person
   * would actually open — the product's own payloads, the terminal rendering and the two
   * damaged ones — and is `--shots=` when a run asked for shots.
   */
  const work = '/tmp/tc-qa-net-qr';
  const dir = SHOT_DIR ?? work;
  await mkdir(work, { recursive: true });
  await mkdir(dir, { recursive: true });
  measured.qr = {};

  /*
   * Every row of the block table, exercised at capacity and read back.
   *
   * Forty symbols, each filled to the exact byte count its (version, level) pair holds, each
   * carrying a payload that names the pair — so a file-to-payload mix-up in this loop shows up
   * as a mismatch rather than as a pass. Vision reads all forty or this is red with the pairs
   * that failed named.
   */
  const grid = [];
  for (let v = 1; v <= 10; v++) {
    for (const ecc of ['L', 'M', 'Q', 'H']) {
      const head = `v${v}${ecc}:`;
      const want = capacityBytes(v, ecc);
      const text = (head + 'X'.repeat(Math.max(0, want - head.length))).slice(0, want);
      const q = qrEncode(text, { ecc, minVersion: v });
      const f = path.join(work, `qr-grid-v${String(v).padStart(2, '0')}${ecc}.png`);
      await writeFile(f, await qrPng(q));
      grid.push({ f, text, ecc, v, version: q.version, bytes: want });
    }
  }
  let read = await decodeQr(grid.map((g) => g.f));
  const gridBad = grid.filter((g) => g.version !== g.v || (read.get(g.f) ?? [])[0] !== g.text);
  measured.qr.grid = grid.map((g) => ({ v: g.v, ecc: g.ecc, bytes: g.bytes, ok: !gridBad.includes(g) }));
  record('qr-every-version', gridBad.length === 0,
    'all forty version-and-level pairs encode a full payload and come back byte for byte '
      + 'through a decoder that is not ours',
    gridBad.length
      ? gridBad.slice(0, 4).map((g) => `v${g.v}${g.ecc} (${g.bytes}B): `
        + `got ${JSON.stringify(((read.get(g.f) ?? [])[0] ?? '').slice(0, 20))}`).join('; ')
      : `versions 1–10 × L/M/Q/H, ${grid[0].bytes}…${grid[grid.length - 1].bytes} bytes each, `
        + 'all exact',
    'this is the audit of the error-correction block table: one wrong digit in it moves a '
      + 'block boundary and the symbol decodes to rubbish while still scanning perfectly');

  /*
   * The four payload shapes this product actually builds, at the level it actually ships.
   *
   * Not "a QR of some text". The short join URL is what the terminal and the lobby print, the
   * long one is what an overridden relay falls back to, the `.local` form is what `npm run host`
   * offers Mac to Mac, and the `create=1` form is the one the host's own browser is opened on.
   */
  const payloads = [
    ['join', 'http://192.168.1.77:5958/?room=ABCDE'],
    ['override', 'http://192.168.1.77:5958/?net=ws%3A%2F%2F10.0.0.9%3A5959&room=ABCDE&host=0'],
    ['mdns', 'http://ernests-air.local:5958/?room=ABCDE'],
    ['create', 'http://192.168.1.77:5958/?mp=1&room=ABCDE&create=1'],
  ];
  const shots = [];
  for (const [name, text] of payloads) {
    const q = qrEncode(text);
    const f = path.join(dir, `qr-${name}.png`);
    await writeFile(f, await qrPng(q));
    shots.push({ f, text, name, version: q.version });
  }
  read = await decodeQr(shots.map((s) => s.f));
  const wrong = shots.filter((s) => (read.get(s.f) ?? [])[0] !== s.text);
  measured.qr.payloads = shots.map((s) => ({ name: s.name, version: s.version, got: (read.get(s.f) ?? [])[0] ?? null }));
  record('qr-decodes', wrong.length === 0,
    'every URL this product puts in a square is read back, byte for byte',
    wrong.length
      ? wrong.map((s) => `${s.name}: got ${JSON.stringify((read.get(s.f) ?? [])[0] ?? null)}`).join('; ')
      : `${shots.map((s) => `${s.name} v${s.version}`).join(', ')} — all four exact`,
    'Vision is what an iPhone camera runs, so this is the device the product is aimed at '
      + 'saying yes, rather than our own encoder agreeing with itself');

  /*
   * And the terminal, which is the rendering nobody would think to check.
   *
   * `qrHalfBlocks` carries two module rows per character with 24-bit colour escapes, and the
   * glyph-to-module mapping is easy to get subtly wrong — an off-by-one in the row pairing
   * produces output that still looks exactly like a QR. `halfBlocksToPixels` reconstructs the
   * image the terminal paints and the same decoder reads it.
   */
  const termFiles = [];
  for (const [name, text] of payloads.slice(0, 2)) {
    const f = path.join(dir, `qr-term-${name}.png`);
    await writeFile(f, await halfBlocksToPng(qrHalfBlocks(qrEncode(text)), { scale: 6 }));
    termFiles.push({ f, text, name });
  }
  read = await decodeQr(termFiles.map((s) => s.f));
  const termWrong = termFiles.filter((s) => (read.get(s.f) ?? [])[0] !== s.text);
  record('qr-terminal-decodes', termWrong.length === 0,
    'the half-block rendering `npm run host` prints is a scannable symbol and not a picture of one',
    termWrong.length
      ? termWrong.map((s) => `${s.name}: got ${JSON.stringify((read.get(s.f) ?? [])[0] ?? null)}`).join('; ')
      : `${termFiles.length} terminal renderings re-imaged two pixel rows to a character row, both exact`,
    'one module is half a character cell, so a wrong row pairing still looks like a QR');

  /*
   * A thumb over the corner, and the control that makes it mean something.
   */
  const occlude = (q, frac) => {
    const n = Math.round(q.size * frac);
    const mods = Uint8Array.from(q.modules);
    for (let y = q.size - n - 1; y < q.size - 1; y++) {
      for (let x = q.size - n - 1; x < q.size - 1; x++) mods[y * q.size + x] = 0;
    }
    return { ...q,
      modules: mods,
      dark: (x, y) => x >= 0 && y >= 0 && x < q.size && y < q.size && mods[y * q.size + x] === 1 };
  };
  /*
   * The first side is encoded with **no level given**, so it is the level the product actually
   * ships, and the check reads that level back into its own sentence.
   *
   * Written the other way round first — `qrEncode(url, { ecc: 'Q' })` — and the injection that
   * changes the default from Q to L was then run and the check stayed green, because it was
   * asking for Q rather than measuring what a caller gets. A check that names the shipped
   * default has to obtain it the way a caller does.
   */
  const thumb = [];
  for (const opt of [{}, { ecc: 'L' }]) {
    const q = qrEncode(payloads[0][1], opt);
    const f = path.join(dir, `qr-thumb-${q.ecc}${opt.ecc ? '' : '-default'}.png`);
    await writeFile(f, await qrPng(occlude(q, 0.25)));
    thumb.push({ f, ecc: q.ecc });
  }
  read = await decodeQr(thumb.map((s) => s.f));
  const gotQ = (read.get(thumb[0].f) ?? [])[0] ?? null;
  const gotL = (read.get(thumb[1].f) ?? [])[0] ?? null;
  measured.qr.thumb = { shipped: thumb[0].ecc, withDefault: gotQ, withL: gotL };
  record('qr-survives-a-thumb',
    thumb[0].ecc === 'Q' && gotQ === payloads[0][1] && gotL !== payloads[0][1],
    'a quarter of the symbol\'s width blanked out of the bottom corner still reads at the '
      + 'level this ships at, and does not at the level below it',
    `the shipped default is level ${thumb[0].ecc}, and read ${JSON.stringify(gotQ)}; `
      + `level L read ${JSON.stringify(gotL)}`,
    'the control is the point: without the L arm this would pass against a decoder that was '
      + 'merely patient — and without taking the default it would pass after the level was '
      + 'quietly lowered, which is exactly what the injection for it showed');

  /*
   * The quiet zone, measured off the rendering rather than off the constant.
   *
   * Four clear modules a side is what the specification requires and what a scanner uses to
   * find the symbol at all. It is asserted on the *output* — the terminal text's own width and
   * the SVG's `viewBox` — because a renderer that dropped it would still produce a decodable
   * synthetic image (measured: Vision reads a clean symbol with no quiet zone at all) and would
   * then fail on a screen with anything printed beside it. This is the one property a decode
   * test is structurally unable to see.
   */
  const qq = qrEncode(payloads[0][1]);
  const term = halfBlocksToPixels(qrHalfBlocks(qq), { scale: 1 });
  const termRings = quietRings(term, 1);
  /*
   * Counted off the pixels, on both renderings, and the previous version of this check could
   * not have failed.
   *
   * It read `term.width === qq.size + QUIET * 2` — a constant on both sides of its own
   * comparison — while its sentence claimed to measure "off the rendering and not off the
   * constant". Set `QUIET` to 0 and the expectation moved with it; the only conjunct doing any
   * work was `QUIET === 4`, which is an assertion about a literal. `quietRings` walks in from
   * each edge counting whole rows and columns of light, so it measures what a scanner has to
   * find and it goes red at zero because there is then nothing to count.
   */
  const svgMarkup = qrSvg(qq);
  const svgFile = path.join(dir, 'qr-svg-on-panel.png');
  await writeFile(svgFile, await svgToPng(svgMarkup));
  const sRings = await svgRings(svgMarkup, { modules: qq.size + QUIET * 2 });
  const svgRead = ((await decodeQr([svgFile])).get(svgFile) ?? [])[0] ?? null;
  const minRing = Math.min(termRings.top, termRings.bottom, termRings.left, termRings.right);
  const minSvg = Math.min(sRings.top, sRings.bottom, sRings.left, sRings.right);
  measured.qr.quiet = { termRings, svgRings: sRings, svgDecoded: svgRead };
  record('qr-quiet-zone', minRing >= 4 && minSvg >= 4 && svgRead === payloads[0][1],
    'both renderings supply their own light field — at least four clear rings, counted off '
      + 'the pixels, with the SVG rasterised onto the panel\'s own dark background rather '
      + 'than onto the white its CSS happens to sit on',
    `terminal rings ${termRings.top}/${termRings.right}/${termRings.bottom}/${termRings.left}; `
      + `svg on #14100c rings ${sRings.top}/${sRings.right}/${sRings.bottom}/${sRings.left}, `
      + `decoded ${JSON.stringify(svgRead)}`,
    'decoding alone does not discriminate here and that was measured too: flattened onto the '
      + 'panel colour a rect-less symbol is black on RGB(20,16,12) and Vision still reads it, '
      + 'because a synthetic image has no noise for two dark greys to get lost in. The rings '
      + 'are the property a camera actually needs');

  /*
   * The arithmetic the block table has to satisfy, and the docstring that promised it.
   *
   * `src/net/qr.ts` named this check in prose a day before it existed. It is cheap and it fails
   * differently from `qr-every-version`: the round trip catches a digit that breaks a symbol,
   * this catches one that breaks the identity `ec * blocks + data === total`, and a pair of
   * mistakes that agreed with each other would have to survive both.
   */
  const sumBad = [];
  for (let v = 1; v <= 10; v++) {
    for (const ecc of ['L', 'M', 'Q', 'H']) {
      const [ec, g1, d1, g2, d2] = blockPlan(v, ecc);
      const total = ec * (g1 + g2) + g1 * d1 + g2 * d2;
      if (total !== TOTAL_CODEWORDS[v - 1]) {
        sumBad.push(`v${v}${ecc}: ${total} against ${TOTAL_CODEWORDS[v - 1]}`);
      }
    }
  }
  record('qr-tables-sum', sumBad.length === 0 && TOTAL_CODEWORDS.length === 10,
    'every one of the forty block-table rows adds up to the codeword count its version is '
      + 'defined to hold',
    sumBad.length ? sumBad.slice(0, 4).join('; ')
      : `40 rows against ${TOTAL_CODEWORDS[0]}…${TOTAL_CODEWORDS[9]} codewords, all exact`,
    'promised by qr.ts\'s docstring before it was written, which is a false claim in a file '
      + 'whose whole subject is not making them');

  /*
   * The function patterns, walked. This is the check that would have caught the two modules
   * `drawFunctions` was clearing and `drawFormat` never restored.
   */
  const fnBad = [];
  for (const v of [1, 2, 5, 7, 10]) {
    const q = qrEncode('x', { minVersion: v });
    for (let i = 8; i < q.size - 8; i++) {
      if (q.dark(i, 6) !== (i % 2 === 0)) fnBad.push(`v${v} timing row at x=${i}`);
      if (q.dark(6, i) !== (i % 2 === 0)) fnBad.push(`v${v} timing column at y=${i}`);
    }
    if (!q.dark(8, q.size - 8)) fnBad.push(`v${v} dark module at (8,${q.size - 8})`);
    for (const [fx, fy] of [[0, 0], [q.size - 7, 0], [0, q.size - 7]]) {
      for (let dy = 0; dy < 7; dy++) {
        for (let dx = 0; dx < 7; dx++) {
          const d = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
          if (q.dark(fx + dx, fy + dy) !== (d !== 2)) fnBad.push(`v${v} finder at ${fx + dx},${fy + dy}`);
        }
      }
    }
  }
  record('qr-function-patterns', fnBad.length === 0,
    'the timing runs alternate over their whole length, the three finders are exact and the '
      + 'always-dark module is dark, across five versions',
    fnBad.length ? `${fnBad.length} wrong: ${fnBad.slice(0, 4).join('; ')}`
      : 'versions 1, 2, 5, 7 and 10 — every function module as the specification draws it',
    'the format-information reservation used to clear (8,6) and (6,8), which are timing '
      + 'modules, and drawFormat never wrote them back: two modules light where the spec says '
      + 'dark, in every symbol, costing 71 decodes against 70 over 216 degraded trials — which '
      + 'is to say nothing measurable, which is exactly why prose could not be the check');

  const cols = qq.size + QUIET * 2;
  const rowsOut = Math.ceil(cols / 2);
  /*
   * The symbol's own footprint. Whether the *command* leaves it on screen is a different claim
   * with different evidence, and it is `lan-square-stays-on-screen`, which reads the line counts
   * `tools/host-lan.mjs` reports about its own output.
   */
  record('qr-fits-a-terminal', cols <= 80 && rowsOut <= 22,
    'the square itself fits inside an 80x24 window with room for a line under it',
    `v${qq.version}: ${cols} columns by ${rowsOut} rows of half blocks, quiet zone included`,
    'the long ?net= form is version 7 and 53 columns, which is why the short form exists');
}

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
  /*
   * Recorded unconditionally, and that is a fix to the gate's arithmetic rather than a style.
   *
   * It used to be `if (d) { record(...) }`, so a fault arm that failed its first check silently
   * dropped its second — and the **denominator moved with the result**. A run with a red
   * `reordered-pair` reported "78/81" where a green one reports "82/82": three reds out of
   * eighty-one reads as a better run than it is, and the total is no longer a constant a person
   * can compare between runs. A check that cannot be counted when it fails is not a check.
   *
   * With nothing detected the claim is false by construction — neither client can have stopped
   * on a desync that was never declared — so it is red, and it says which of the two facts is
   * missing rather than repeating the first check's sentence.
   */
  record(`${name}-both`, !!d && (seen?.ended ?? '') === 'desync' && (ng?.ended ?? '') === 'desync',
    'and both clients stopped, rather than one of them playing on alone',
    d ? `host ended '${seen?.ended ?? 'not ended'}', guest ended '${ng?.ended ?? 'not ended'}'`
      : 'no desync was declared, so there was nothing for either client to stop on',
    d ? '' : 'red because the check above is: this one cannot be true while that one is false');
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
  /*
   * Recorded whether or not the fault was caught, for the reason `faultArm` gives at length:
   * a check that is skipped when it fails takes the denominator with it. These two were the
   * last conditional pair in the file — a run where `one-ulp` went red reported 87 checks where
   * a green one reports 89, so the totals of two runs could not be compared. Measured on
   * exactly that: run A 89/89, run B 80/87, and two of the seven "missing" checks were these.
   */
  record('one-ulp-layer', !!d && d.layer === 'uf64',
    'and it is caught on the float64 unit layer, which is why that layer is the detector',
    d ? `caught on '${d.layer}' at tick ${d.tick}` : 'nothing was caught, so no layer was named',
    'the float32 pool has a quantisation firewall with ~29 bits of headroom; '
      + 'UnitGroupState has none');
  record('one-ulp-attributed', !!d && d.units.length >= 1 && d.units.length <= 4,
    'and attributed to the regiment it happened to, not to the whole field',
    d ? `${d.units.length} unit(s): ${d.units.join(', ')} — ${d.note}`
      : 'nothing was caught, so nothing was attributed',
    'per-unit digests are hashed from a fresh state each, so a one-unit fault names one unit');
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
   * And tick **Send every order through the relay**, because that is what this arm is about.
   *
   * From 2 Sep 2026 an address in this field is an *introduction service* — it passes one message
   * each way and is then closed — and the default transport is a connection straight between the
   * two browsers. So filling the field alone no longer makes `CREATE` ask the relay for a room,
   * and `lobby-create-opens-the-room-asked-for` went red on a room that had been opened correctly
   * and peer to peer. The relay *transport* is still here and still does exactly what it did;
   * it is one checkbox in, and this is the arm that exercises it.
   */
  await host.check('#tc-via-relay');

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
    'before CORS this fetch always rejected and the lobby blamed a relay that had just '
      + 'answered. Reaching the relay at all now needs the transport checkbox above, which is '
      + 'what this arm ticks');

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
  /*
   * The square is still on screen when the command has finished printing.
   *
   * Read off the counts `tools/host-lan.mjs` reports about its own output rather than off a
   * terminal, because `--json` prints no square and a gate cannot own a tty. It printed 55
   * lines with **22 after the last row of the symbol**, so on an 80x24 window the thing the
   * other machine is meant to photograph had scrolled off the top by the time the command
   * settled. The square is now the last thing printed.
   */
  const { qrEncode: encodeHere } = await import('../src/net/qr.ts');
  const qrRows = Math.ceil((encodeHere(lan.joinUrl ?? 'x').size + 8) / 2);
  measured.lan.layout = { lines: lan.lines, after: lan.linesAfterQr, rows: qrRows };
  record('lan-square-stays-on-screen',
    lan.qr === true && Number.isInteger(lan.linesAfterQr)
      && qrRows + lan.linesAfterQr <= 24,
    'the command prints the square last, so it survives an 80x24 window',
    `${lan.lines} lines in all, ${lan.linesAfterQr} of them after the last row of a `
      + `${qrRows}-row symbol — ${qrRows + lan.linesAfterQr} of the 24 a default window has`,
    'a symbol that fits and has scrolled off the top is not a symbol that fits');

  const roomB = lan.room;
  /*
   * The guest scanned first, which is a real race and used to lock the host out of their own room.
   *
   * `npm run host` mints the room and prints the square before the host's browser has finished
   * loading, so a guest with a camera can be in the room first. The relay then refuses `/new`
   * for that code with 409 *"room X is in use on this relay"* — correct for a code somebody
   * typed, and a dead end for the host, who is being told about their own room. Reproduced here
   * with a socket rather than a second browser: what matters is that the room is occupied, not
   * what occupies it.
   *
   * **On its own page, and the reason is a finding rather than tidiness.** Chromium writes
   * *"Failed to load resource: the server responded with a status of 409"* for any `fetch` that
   * comes back 4xx, whatever the caller does with the answer — the same behaviour that made the
   * lobby read `<meta name="tc-lan">` instead of asking for `/__tc/lan` (§11.2). So recovering
   * from this race costs exactly one console line, and it is charged here, to this check, where
   * it is named — rather than silently to `lan-console`, whose subject is the ordinary flow and
   * which went red the first time this ran on `hostPage`. What must not appear is a
   * `pageerror`, and that is in the pass condition.
   */
  const raceRoom = await fetch(`http://${lan.lan}:${lan.relayPort}/new`,
    { signal: AbortSignal.timeout(4000) })
    .then((r) => (r.ok ? r.json() : null)).then((j) => j?.room ?? null).catch(() => null);
  const racePage = await newPage(chrome);
  let raceShown = null;
  let raceSock = null;
  if (raceRoom) {
    raceSock = await new Promise((ok) => {
      const ws = new WebSocket(`ws://${lan.lan}:${lan.relayPort}/room/${raceRoom}?want=join&v=1`);
      ws.onopen = () => ok(ws);
      ws.onerror = () => ok(null);
      setTimeout(() => ok(null), 5000);
    });
    if (raceSock) {
      await sleep(300);
      await racePage.goto(`${lanBase}/?mp=1&room=${raceRoom}&create=1`, { waitUntil: 'domcontentloaded' });
      raceShown = await racePage.waitForSelector('#tc-code', { timeout: 20000 })
        .then(async () => ((await racePage.textContent('#tc-code')) ?? '').trim())
        .catch(() => null);
      raceSock.close();
    }
  }
  const raceSaid = raceShown === null
    ? ((await racePage.textContent('#tc-note').catch(() => '')) ?? '').replace(/\s+/g, ' ').trim()
    : '';
  const raceThrew = racePage.__errs.filter((e) => e.startsWith('pageerror'));
  const raceNoise = racePage.__errs.filter((e) => !/409/.test(e));
  await shot(racePage, 'lan-07-guest-scanned-first');
  await racePage.close();
  measured.lan.race = { room: raceRoom, shown: raceShown, said: raceSaid, errs: racePage.__errs };
  record('lan-guest-first-does-not-lock-the-host',
    !!raceRoom && !!raceSock && raceShown === raceRoom
      && raceThrew.length === 0 && raceNoise.length === 0,
    'a guest who scans the square before the host\'s browser has loaded does not lock the host '
      + 'out of their own room',
    raceRoom
      ? `${raceRoom} was occupied by a joining socket, then opened at ?create=1; the sheet reads `
        + `${raceShown ?? `nothing — it says "${raceSaid.slice(0, 120)}"`}`
        + `; the page logged ${racePage.__errs.length} console line(s), `
        + `${raceNoise.length} of them not the 409, and threw ${raceThrew.length}`
      : 'the relay would not mint a room to race for',
    '/new answers 409 for an occupied code, which is right for a code somebody typed and is '
      + 'the good outcome wearing an error\'s clothes for a code the command minted');

  /*
   * `?mp=1&room=…&create=1`, which is the URL the command opens the host's own browser on.
   *
   * Not typed here and not built here: it comes out of `host-lan --json`, which is the same
   * string the command hands the OS opener. The claim is that the host does nothing at all —
   * the room the terminal printed is already open on the screen when the page settles.
   */
  await hostPage.goto(lan.hostUrl, { waitUntil: 'domcontentloaded' });
  await hostPage.waitForSelector('#tc-code', { timeout: 30000 }).catch(() => { /* read below */ });
  const openedCode = ((await hostPage.textContent('#tc-code').catch(() => '')) ?? '').trim();
  const rsHost = await relayStatus({ http: `http://${lan.lan}:${lan.relayPort}` });
  measured.lan.autoCreate = { url: lan.hostUrl, room: roomB, shown: openedCode };
  record('lan-create-from-the-link',
    !!roomB && openedCode === roomB && !!rsHost?.rooms?.some((r) => r.code === roomB),
    'the command opened the room itself, and the browser it opens lands on that room with '
      + 'nothing pressed',
    roomB
      ? `host-lan minted ${roomB} and opened ${lan.hostUrl}; the sheet reads `
        + `${openedCode || '(nothing)'}, and the relay holds `
        + `${(rsHost?.rooms ?? []).map((r) => r.code).join(', ') || 'no rooms'}`
      : 'host-lan did not mint a room at all, so the code it printed and the code on screen '
        + 'cannot be the same one',
    'a browser landing on an empty form would let the host open a *second* room with one '
      + 'press, and the square in the terminal would then name a room nobody is in');

  const invite = ((await hostPage.textContent('#tc-invite').catch(() => '')) ?? '').trim();
  const hasButton = await hostPage.evaluate(() => !!document.querySelector('#tc-copy-link'));
  await shot(hostPage, 'lan-02-room-open');
  measured.lan.invite = invite;
  record('lan-invite-carries-the-address-and-the-code',
    hasButton && invite === lan.joinUrl
      && invite.startsWith(`http://${lan.lan}:${lan.gamePort}/`) && invite.includes(`room=${roomB}`),
    'the link on the open-room screen is the LAN page and this room, and it is character for '
      + 'character the line the terminal printed',
    invite ? `screen: ${invite}\n        → terminal: ${lan.joinUrl}`
      : 'there is no link on the screen and no button to copy one',
    'it used to carry the relay address as well, percent-encoded, which is 78 characters and '
      + 'goes stale the moment the host restarts on another relay port — the address is in '
      + 'the document the link fetches, stated by the server');

  /*
   * The square on the host's screen, photographed and read by a decoder that is not ours.
   *
   * This is the check the whole pass turns on. Everything else about the QR is measured
   * headlessly in the `qr` arm — the encoder, the terminal rendering, the error correction —
   * and none of it says anything about the symbol that is actually on the lobby's panel, at
   * the size the panel gives it, in the colours the panel paints. A screenshot of that one
   * element is what a camera would see; Vision reads it; the string it yields is what the
   * second client is then given, and nothing between here and the battle is written by this
   * test.
   */
  const { decodeQr } = await import('./lib/qr-image.mjs');
  const qrDir = SHOT_DIR ?? '/tmp/tc-qa-net-qr';
  await mkdir(qrDir, { recursive: true });
  const qrShot = path.join(qrDir, 'lan-06-screen-qr.png');
  const qrBox = await hostPage.$('#tc-qr');
  if (qrBox) await qrBox.screenshot({ path: qrShot, scale: 'device' });
  const scanned = qrBox ? ((await decodeQr([qrShot])).get(qrShot) ?? [])[0] ?? null : null;
  measured.lan.scanned = scanned;
  record('lan-the-square-decodes-to-that-room',
    scanned !== null && scanned === lan.joinUrl,
    'the square drawn on the host\'s screen, screenshotted and decoded, is the join URL for '
      + 'this room',
    qrBox
      ? `${qrShot} → ${JSON.stringify(scanned)}; the terminal printed ${JSON.stringify(lan.joinUrl)}`
      : 'there is no square on the open-room screen at all',
    'a rendered QR that does not decode is the exact shape of check this repository has '
      + 'shipped before — so this reads it back rather than asserting that an <svg> appeared');

  /*
   * A phone scans the square, and is turned away without spending the room.
   *
   * This is the failure the whole feature had until a reviewer ran it: a client at an iPhone
   * viewport followed the square, connected, **took slot 1**, and landed on a deployment plaque
   * whose BEGIN BATTLE sat 434 px off the right edge of a page that cannot scroll. Neither
   * commander could then play — the phone could not start the battle and the real second
   * laptop was refused with "already has a challenger".
   *
   * The engine is not the variable and this arm does not pretend otherwise: the refusal is
   * keyed on viewport width, so a 390x844 Chromium page exercises the identical path. What
   * WebKit adds is a rendering defect, measured and named in `docs/MULTIPLAYER.md` §12.10,
   * which this arm cannot reach because on this path **no engine boots at all**.
   *
   * Two claims, and the second is the one that matters: the phone is told why, *and the room
   * is untouched*. `occupied` is read off the relay, and the real guest joining afterwards is
   * the same assertion made a second way — if the phone had taken the slot,
   * `lan-the-link-is-the-whole-invitation` below would fail too.
   */
  const phone = await chromeGuest.newPage({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, hasTouch: true, isMobile: true,
  });
  const phoneErrs = [];
  phone.on('pageerror', (e) => phoneErrs.push(`pageerror: ${e.message}`));
  phone.on('console', (m) => { if (m.type() === 'error') phoneErrs.push(`console.error: ${m.text()}`); });
  await phone.goto(scanned ?? invite, { waitUntil: 'domcontentloaded' });
  await phone.waitForSelector('.tc-lobby h1', { timeout: 60000 }).catch(() => { /* read below */ });
  await sleep(1200);
  const phoneFace = await phone.evaluate(() => ({
    title: (document.querySelector('.tc-lobby h1')?.textContent ?? '').trim(),
    text: (document.querySelector('.tc-sheet')?.innerText ?? '').replace(/\s+/g, ' ').trim(),
    code: (document.querySelector('#tc-notice-code')?.textContent ?? '').trim(),
    link: (document.querySelector('#tc-notice-link')?.textContent ?? '').trim(),
    canCopy: !!document.querySelector('#tc-notice-copy'),
    booted: typeof window.__game !== 'undefined',
    coarse: matchMedia('(pointer: coarse)').matches,
    vw: innerWidth,
  })).catch(() => null);
  await shot(phone, 'lan-08-phone-turned-away');
  const afterPhone = await relayStatus({ http: `http://${lan.lan}:${lan.relayPort}` });
  const phoneRoom = (afterPhone?.rooms ?? []).find((r) => r.code === roomB);
  await phone.close();
  measured.lan.phone = { face: phoneFace, occupied: phoneRoom?.occupied ?? null, errs: phoneErrs };
  record('lan-a-phone-is-turned-away',
    !!phoneFace && /too narrow/i.test(phoneFace.title) && phoneFace.booted === false
      && phoneFace.code === roomB && phoneFace.link.includes(`room=${roomB}`)
      && phoneFace.canCopy && phoneErrs.length === 0,
    'a client too narrow to reach BEGIN BATTLE is told so, and handed the code and the link to '
      + 'carry to a machine that can play',
    phoneFace
      ? `${phoneFace.vw}px, coarse pointer ${phoneFace.coarse}: "${phoneFace.title}" — `
        + `code ${phoneFace.code || '(none)'}, link ${phoneFace.link || '(none)'}, `
        + `copy button ${phoneFace.canCopy}, engine booted ${phoneFace.booted}, `
        + `${phoneErrs.length} console line(s)`
      : 'the page never showed a lobby sheet at all',
    'the HUD has no @media rule anywhere and BEGIN BATTLE is at a fixed 1062 px whatever the '
      + 'viewport, with scrollWidth equal to innerWidth — so it is unreachable, not merely '
      + 'off-screen. Refusing is the honest interim; a phone HUD is a pass of its own');
  record('lan-a-phone-does-not-take-the-slot', phoneRoom?.occupied === 0,
    'and the room it declined is still empty, so the second commander can still have it',
    phoneRoom
      ? `room ${roomB} reports ${phoneRoom.occupied} occupant(s) after the phone visited`
      : `room ${roomB} is not on the relay at all`,
    'the refusal is above `new NetLink` in main.ts, so no socket is opened and no slot is '
      + 'claimed — the ordering is the entire fix');

  await hostPage.click('#tc-begin');
  await driveMenu(hostPage, { map: 'campus-martius', scenario: 'field', tier: 'high', size: 'small' });

  const guestPage = await newPage(chromeGuest);
  /*
   * And the guest is given **the string that came out of the decoder**, not the one this test
   * knows. If the square encoded a different room, or a stale relay port, or a URL that opens
   * the setup sheet as a second host, this is where it shows.
   */
  await guestPage.goto(scanned ?? invite, { waitUntil: 'domcontentloaded' });
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
    !!scanned && lh?.room === roomB && lg?.room === roomB && lh.slot === 0 && lg.slot === 1
      && lh.myFaction !== lg.myFaction,
    'a second client given nothing but the string that came out of the square ends up on the '
      + 'other side of the same battle',
    guestReady
      ? `${(scanned ?? invite).slice(0, 78)} → room ${lg?.room}, slot ${lg?.slot}, commanding `
        + `${lg?.myFaction} against slot ${lh?.slot}'s ${lh?.myFaction}`
      : `the link opened and no battle started in 150 s — the second client is showing "${showing}", `
        + 'which is what an invite that omits the challenger\'s side of it produces',
    'nothing typed, no Join pressed, no relay address entered, and no URL written by this '
      + 'test: `?room=` alone resolves the relay out of the document and joins');

  /*
   * And the room, once it is playing, cannot be reopened as though it were still waiting.
   *
   * The other half of the 409 repair, and the case a reviewer found by driving a `Room` to its
   * battle phase: the first version keyed on *provenance* — "the code came from a `create=1`
   * link" — and so swallowed both of the relay's 409s. A host who pressed Back, or reopened the
   * `create=1` URL out of history or a restored tab, was handed a Room open screen with a code,
   * a link and a square for a room that was already playing and could never be entered again.
   * The relay now says which refusal it is (`taken` against `started`) and the lobby reads that.
   *
   * Run last, because it needs a room that is genuinely past the lobby, and the battle above is
   * one.
   */
  const replay = await newPage(chrome);
  await replay.goto(lan.hostUrl, { waitUntil: 'domcontentloaded' });
  await replay.waitForSelector('.tc-lobby', { timeout: 30000 }).catch(() => { /* read below */ });
  await sleep(2500);
  const replayFace = await replay.evaluate(() => ({
    reopened: !!document.querySelector('#tc-code'),
    note: (document.querySelector('#tc-note')?.textContent ?? '').replace(/\s+/g, ' ').trim(),
  })).catch(() => null);
  await shot(replay, 'lan-09-room-already-playing');
  await replay.close();
  measured.lan.reopen = replayFace;
  record('lan-a-playing-room-is-not-reopened',
    !!replayFace && replayFace.reopened === false && /phase|cannot be re-entered/i.test(replayFace.note),
    'reopening the host link after the battle has started says the room is playing, rather '
      + 'than showing a room-open screen for a room nobody can enter',
    replayFace
      ? `#tc-code present: ${replayFace.reopened}; the sheet says "${replayFace.note.slice(0, 120)}"`
      : 'the page never rendered a lobby sheet',
    'gating the 409 on where the code came from swallowed this; gating it on which refusal the '
      + 'relay sent does not');

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
 * The deployed site, reproduced on this LAN, because the thing that makes it what it is is the
 * scheme and not the hostname.
 *
 * ## What this arm is for
 *
 * `total-claude.vercel.app` is public and served over https, and multiplayer on this branch is
 * two machines on one private network. A secure page may not open an insecure connection to a
 * private address. **How** it is refused depends on the engine, and both refusals are real:
 * Chromium 151 blocks the reach from a public address space into a private one
 * (`ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS`), and WebKit blocks it as plain mixed content
 * with no address-space carve-out at all — measured, all three targets, in §12.6's table.
 * There is no flag on the visitor's side that changes either. So the deployed site's multiplayer screen can
 * *never* start a battle, and what it said until this pass was `npm run host` — a shell command,
 * printed at a stranger with no checkout, under a form field they could type into for ever.
 *
 * A dead-end button, in other words, and the two ways to fix one are to remove it or to make it
 * lead somewhere true. This asserts the second: the entry is still on the front door, and what
 * it leads to is four sentences and a link to a copy, with **no form at all** — no code field,
 * no Create, no Join, no relay address. A disabled control arguing with a paragraph that
 * explains why it is disabled is furniture.
 *
 * ## How a public origin is obtained without deploying anything
 *
 * A self-signed certificate for this machine's LAN address, a 30-line TLS front end in front of
 * the run's own dev server, `ignoreHTTPSErrors` on the page — and one Chromium switch, which is
 * the part that took a second attempt and is documented at length above
 * `PUBLIC_ORIGIN_OVERRIDE`.
 *
 * The first version of this arm had the certificate and not the switch, and it **passed the
 * screen check and failed the socket check by opening the socket**. That is the finding, and it
 * is worth more than the arm: the deployed site's refusal is not about https, it is about the
 * address space the browser believes the document came from. A page on this LAN is private
 * whatever its scheme, so it may reach a private relay; the deployed site is public, so it may
 * not. `--ip-address-space-overrides` declares the TLS front end public and the fixture becomes
 * faithful.
 *
 * ## The control, which is the half that makes it evidence
 *
 * The same proxy also serves the same bytes over plain http on the next port, at the same LAN
 * address, in front of the same dev server, pointed at the same live relay — and **is not**
 * covered by the override. The plain page opens the socket; the declared-public page is refused
 * by name. Without that half, "refused" would be indistinguishable from a firewall, a wrong
 * port or a relay that never started.
 */
if (wanted('https')) {
  console.log('\n=== the deployed site: an https origin, and a relay it may never reach ===');
  const { createServer: createHttp } = await import('node:http');
  const { createServer: createHttps } = await import('node:https');
  const { execFile } = await import('node:child_process');
  const { readFile } = await import('node:fs/promises');

  const lanIp = lanAddress()?.ip ?? null;
  secure: {
  if (!lanIp) {
    record('https-arm-can-run', false,
      'this arm needs a LAN address to be an origin that is not loopback',
      'no non-loopback IPv4 interface — a loopback https origin is a trustworthy one and the '
        + 'rule under test does not apply to it',
      'the same reason tools/host-lan.mjs refuses to print a URL on a machine with no LAN');
    break secure;
  }
  const certDir = '/tmp/tc-qa-net-https';
  await mkdir(certDir, { recursive: true });
  const made = await new Promise((ok) => {
    execFile('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', path.join(certDir, 'key.pem'), '-out', path.join(certDir, 'cert.pem'),
      '-days', '2', '-subj', `/CN=${lanIp}`, '-addext', `subjectAltName=IP:${lanIp}`],
    (err) => ok(!err));
  });
  if (!made) {
    record('https-arm-can-run', false,
      'this arm needs openssl to mint a certificate for this machine\'s LAN address',
      'openssl did not produce a key and a certificate',
      'without a real https origin there is nothing here to measure');
    break secure;
  }
  const key = await readFile(path.join(certDir, 'key.pem'));
  const cert = await readFile(path.join(certDir, 'cert.pem'));

  /*
   * The front end. It forwards to the run's own dev server, which is a `vite-runner` bound to
   * loopback with no relay beside it — so the document it produces has **neither** meta tag in
   * it, which is exactly the shape of the deployed upload. Using it rather than starting a
   * third vite also keeps the arm to one server of its own.
   */
  const { request: httpRequest } = await import('node:http');
  const forward = (req, res) => {
    const proxied = new URL(req.url, base);
    const r = httpRequest({
      host: '127.0.0.1', port: PORT, path: proxied.pathname + proxied.search, method: req.method,
      headers: { ...req.headers, host: `127.0.0.1:${PORT}` },
    }, (ur) => {
      res.writeHead(ur.statusCode ?? 502, ur.headers);
      ur.pipe(res);
    });
    r.on('error', (e) => { res.writeHead(502); res.end(String(e.message)); });
    req.pipe(r);
  };
  const tls = createHttps({ key, cert }, forward);
  const plainTwin = createHttp(forward);
  const listen = (s, port) => new Promise((ok, no) => {
    s.once('error', no);
    s.listen(port, '0.0.0.0', () => ok(true));
  });
  const PLAIN_PORT = HTTPS_PORT + 1;
  const bound = await listen(tls, HTTPS_PORT).then(() => listen(plainTwin, PLAIN_PORT))
    .then(() => true).catch((e) => String(e?.message ?? e));
  if (bound !== true) {
    record('https-arm-can-run', false,
      `this arm needs ${HTTPS_PORT} and ${PLAIN_PORT} on ${lanIp}`,
      `could not bind: ${bound}`,
      'somebody else has the port; pass --https-port= rather than measuring their server');
    break secure;
  }
  const shutTls = () => { try { tls.close(); } catch { /* down */ } try { plainTwin.close(); } catch { /* down */ } };
  const secureBase = `https://${lanIp}:${HTTPS_PORT}`;
  const plainBase = `http://${lanIp}:${PLAIN_PORT}`;
  /*
   * A relay that is genuinely listening at the LAN address, because "the browser refused" and
   * "nothing was there" are different findings and only one of them is this arm's.
   */
  const liveRelay = await startRelay(HTTPS_RELAY, ['--host=0.0.0.0', '--quiet']);
  const wsTarget = `ws://${lanIp}:${HTTPS_RELAY}/room/HTTPS?want=host&v=1`;

  const page = await newPage(chrome, { ignoreHTTPSErrors: true });
  /*
   * In through the front door, which is the half of this the coordinator asked about: the entry
   * has to still exist, and it has to lead somewhere true.
   */
  await page.goto(`${secureBase}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.menu.at-home .dest-multiplayer', { timeout: 60000 });
  await page.click('.menu-home .dest-multiplayer');
  await page.waitForSelector('.tc-lobby', { timeout: 30000 });
  await sleep(400);
  const face = await lobbyFace(page);
  const sheet = await page.evaluate(() => ({
    hasRoom: !!document.querySelector('#tc-room'),
    hasCreate: !!document.querySelector('#tc-host'),
    hasJoin: !!document.querySelector('#tc-join'),
    hasRelay: !!document.querySelector('#tc-relay'),
    hasAdv: !!document.querySelector('#tc-adv'),
    copy: (document.querySelector('#tc-get-copy')?.getAttribute('href') ?? ''),
  }));
  await shot(page, 'https-01-deployed-lobby');
  measured.https = { origin: face.origin, sheet, text: face.text.slice(0, 400) };
  /*
   * **Rewritten 2 Sep 2026, and the claim is now the opposite of what it was.**
   *
   * This check used to require that an https origin's multiplayer screen have *no form on it at
   * all* — no code field, no Create, no Join, no relay address — because a page the browser
   * believes came from the internet cannot open a plain connection into a private network, so
   * every control on it would have been furniture. That was right, and §12.6 has the measurement
   * both ways round.
   *
   * `e/net/webrtc-p2p` made the transport a connection straight between the two browsers, which
   * is subject to neither mixed content nor Local Network Access — so the screen has controls
   * again, and asserting their absence would now be asserting a regression. What is checked
   * instead is that the entry still leads somewhere *usable*: the code field is reachable by a
   * mouse, Create is enabled, and the sheet no longer claims the battle cannot be played from
   * here.
   *
   * **The socket check below is untouched, and is now the control rather than the limit.** The
   * `ws://` refusal is still exactly true and is the reason a relay cannot be the answer on this
   * origin; `tools/qa-p2p.mjs`'s `https` arm reuses this same fixture to show a peer connection
   * succeeding from the same page that this fails from.
   */
  const usable = sheet.hasRoom && sheet.hasCreate && sheet.hasJoin && sheet.hasAdv
    && face.roomReaches && face.createDisabled === false;
  const noLongerRefuses = !/cannot be played from this page/i.test(face.text)
    && !/nothing typed on this screen/i.test(face.text);
  record('https-lobby-offers-a-room',
    face.origin === secureBase && usable && noLongerRefuses && !/npm run/.test(face.text),
    'on an https origin the multiplayer entry leads to a room code, a Create and a Join',
    `origin ${face.origin}; controls present: `
      + `${Object.entries(sheet).filter(([, v]) => v === true).map(([k]) => k).join(', ') || 'none'}; `
      + `code field reachable ${face.roomReaches}, Create `
      + `${face.createDisabled ? 'disabled' : 'enabled'}; sheet reads: ${face.text.slice(0, 150)}`,
    'this screen had no controls on it at all until 2 Sep 2026, because a relay was compulsory '
      + 'and this origin cannot reach one — see §13.1 and the socket check below, which is now '
      + 'the control for that rather than the limit');

  /*
   * And the reason it gives, measured. Two pages, one relay, one character of difference.
   */
  const probe = async (from) => {
    const p = await newPage(chrome, { ignoreHTTPSErrors: true });
    const seen = [];
    p.on('console', (m) => { if (m.type() === 'error') seen.push(m.text()); });
    await p.goto(`${from}/`, { waitUntil: 'domcontentloaded' });
    const said = await p.evaluate(async (url) => {
      try {
        const ws = new WebSocket(url);
        return await new Promise((res) => {
          const done = (how) => { try { ws.close(); } catch { /* already */ } res(how); };
          ws.onopen = () => done('opened');
          ws.onerror = () => done('error');
          ws.onclose = (e) => done(`closed ${e.code}`);
          setTimeout(() => done('timeout'), 5000);
        });
      } catch (e) {
        return `threw ${e.name}: ${e.message}`;
      }
    }, wsTarget);
    await p.close();
    return { said, why: seen.join(' | ').slice(0, 300) };
  };
  const fromSecure = await probe(secureBase);
  const fromPlain = await probe(plainBase);
  measured.https.socket = { target: wsTarget, fromSecure, fromPlain };
  /*
   * Named, not merely failed. `error` is what a blocked socket and an unplugged cable both
   * look like from `onerror`, so the pass condition reads the browser's own sentence: this has
   * to be refused *by the address-space check or by mixed content*, and not by nothing being
   * there. The plain-http half proves something is there.
   */
  const blocked = /LOCAL_NETWORK_ACCESS|Mixed Content/i.test(fromSecure.why);
  record('https-blocks-a-lan-socket',
    fromSecure.said !== 'opened' && blocked && fromPlain.said === 'opened',
    'the same relay, at the same address, refused to a page the browser believes came from '
      + 'the internet and opened to one from this network',
    `${wsTarget}\n        → from ${secureBase} (declared public): ${fromSecure.said}`
      + `${fromSecure.why ? ` — ${fromSecure.why.slice(0, 150)}` : ''}`
      + `\n        → from ${plainBase}: ${fromPlain.said}`,
    'this is the evidence behind the sentence on the screen, and it took two attempts to '
      + 'measure: without --ip-address-space-overrides the secure page opens the socket, '
      + 'because the rule is about address spaces and a fixture on this LAN is private');

  record('https-console', page.__errs.length === 0,
    'and the refusal screen itself raised no console error',
    page.__errs.slice(0, 3).join(' ; ') || 'clean',
    'the socket probe is on its own page on purpose: a blocked mixed-content request is '
      + 'logged by Chromium and would otherwise be charged to a screen that did nothing');

  await page.close();
  liveRelay.stop();
  shutTls();
  }
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
    /*
     * Typed the way a person would say it out loud: four dotted numbers and a port, no scheme.
     *
     * This is the whole of what this branch built in place of packing a LAN address into a
     * longer room code — see `docs/MULTIPLAYER.md` §12.5 for why that was considered and
     * refused. The completion is written back into the field on `change`, so the address that
     * gets used is the address on the screen and nothing was guessed behind the player's back.
     */
    const bare = relay.base.replace(/^ws:\/\//, '');
    await page.fill('#tc-relay', bare);
    await page.evaluate(() => document.querySelector('#tc-relay')?.blur());
    const completed = await page.inputValue('#tc-relay');
    record('dev-server-completes-a-bare-address', completed === relay.base,
      'an address typed without a scheme is completed to one, in the field, where it can be read',
      `typed "${bare}", the field now holds "${completed}"`,
      'the cross-origin case is two people who each have a checkout, and the thing they have '
        + 'to get across is an address — four dotted numbers is the smallest honest spelling '
        + 'of one, and this is what makes it typeable');
    const enabled = await page.evaluate(() => !document.querySelector('#tc-host')?.disabled);
    const devRoom = nextRoom();
    await page.click('#tc-room');
    await page.type('#tc-room', devRoom, { delay: 20 });
    await shot(page, 'dev-02-advanced-open');
    /*
     * The press is conditional, and that is a reporting decision rather than a softer test.
     *
     * `page.click` on a `disabled` button waits thirty seconds for actionability and then
     * throws, which reaches this file's `unhandledRejection` handler and kills the run — so a
     * regression in the one line that re-arms the form would end the whole gate with a
     * Playwright stack and no verdict. Measured, while writing the injection that removes that
     * line. Reading the state and saying what it was keeps the sentence.
     */
    if (enabled) await page.click('#tc-host');
    const opened = enabled && await page.waitForSelector('#tc-code', { timeout: 20000 })
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
 * it is not is HTTPS, and since this pass **the lobby does branch on the scheme** — an https
 * origin with no server of ours behind it gets no form at all, because on that origin the
 * refusal is permanent. That case is the `https` arm's, and it is a different screen with a
 * different sentence. This arm holds the plain-http half of the pair, which is what
 * `npm run dev -- --host` and any other unadorned upload produce: a form, disabled, with a
 * refusal that names a command the reader can actually run.
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
 * A server that says it started a relay, and did not. The arm that measures the probe itself.
 *
 * ## Why this exists, and what was wrong without it
 *
 * `dev` and `static` prove the lobby is honest when *nothing* names an address, and `lan`
 * proves it is quiet when a named address answers. **None of them can tell whether the probe
 * runs at all.** `relayAnswers()` could be replaced by `async () => true` and all three would
 * stay green: the first two never call it, and in the third the relay is alive. So the one
 * sentence this pass rests on — *a stated fact is still checked* — was the only claim in it
 * with no check behind it.
 *
 * ## Why it is a real case and not a contrivance
 *
 * `tools/host-lan.mjs` spawns the game server and the relay as **two processes**. The meta tag
 * is written by the first of them, at the moment it serves the document, and it knows nothing
 * about whether the second is still alive — a relay that crashed, or that lost its port to
 * something else, leaves exactly this document behind. `startVite` with `relayPort` and nothing
 * listening on that port reproduces it in one line, and `vite-runner`'s `relayPlaque()` writes
 * the tag on a loopback bind, so no LAN address is needed to get there.
 *
 * The port is asserted empty first. A relay somebody else happens to be running on 5991 would
 * turn this into an arm that quietly measures nothing and reports green.
 */
if (wanted('ghost')) {
  console.log('\n=== a server that says it started a relay, and did not ===');
  const held = await fetch(`http://127.0.0.1:${GHOST_RELAY}/health`,
    { signal: AbortSignal.timeout(2000) }).then(() => true).catch(() => false);
  if (held) {
    record('ghost-arm-can-run', false,
      `this arm needs port ${GHOST_RELAY} to have nothing on it, which is the whole fixture`,
      `something answered http://127.0.0.1:${GHOST_RELAY}/health`,
      'a relay that is actually there would make every check below pass for the wrong reason');
  } else {
    const ghost = await startVite({
      port: GHOST_PORT,
      root: ROOT,
      cacheDir: path.join(ROOT, '.vite-cache', `qa-net-ghost-${GHOST_PORT}`),
      label: 'qa-net/ghost',
      relayPort: GHOST_RELAY,
    });
    const page = await newPage(chrome);
    await page.goto(`${ghost.base}/?mp=1`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.tc-lobby', { timeout: 60000 });
    // Longer than the probe's own 3 s timeout, so a slow answer is not read as no answer.
    await sleep(4000);
    const face = await lobbyFace(page);
    await shot(page, 'ghost-01-lobby');
    const want = `ws://127.0.0.1:${GHOST_RELAY}`;
    measured.ghost = { declared: face.metaRelay, want, face, errs: page.__errs.slice(0, 4) };

    record('ghost-relay-is-probed-and-not-believed',
      face.metaRelay === String(GHOST_RELAY) && face.relayValue === want
        && face.blockedShown && face.blockedText.includes(want)
        && /said it had started a relay there/.test(face.blockedText)
        && face.createDisabled === true && face.joinDisabled === true,
      'a relay the server advertised and did not start is caught before the player presses '
        + 'anything, and named as the server\'s claim rather than the player\'s mistake',
      `the document says tc-relay=${face.metaRelay}, the field holds ${JSON.stringify(face.relayValue)}, `
        + `CREATE disabled=${face.createDisabled}; the panel says: ${face.blockedText.slice(0, 190)
          || '(nothing — the lobby believed the tag)'}`,
      'without this arm relayAnswers() could return true unconditionally and dev, static and '
        + 'lan would all still be green');

    const thrown = page.__errs.filter((e) => e.startsWith('pageerror'));
    record('ghost-relay-no-pageerror', thrown.length === 0,
      'and finding that out costs a network line in the browser\'s own log, not an exception',
      thrown.slice(0, 2).join(' ; ')
        || `clean (${page.__errs.length} network console line(s) — a refused connection, which `
          + 'is what the probe just discovered and nothing here can suppress)',
      'the meta tag replaced a fetch to avoid exactly this noise; the probe is allowed it '
        + 'because it only fires when an address has already been named');

    await page.close();
    await ghost.close();
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
