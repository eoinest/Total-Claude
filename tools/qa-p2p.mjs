#!/usr/bin/env node
/**
 * The gate for the peer-to-peer transport: two browsers, one direct connection, one battle.
 *
 * ## Why this is a second file and not more arms in `tools/qa-net.mjs`
 *
 * `qa-net` is the relay's gate and it is **the control**. Its 89 checks are the known-good
 * behaviour this transport is measured against, and a number that moves whenever somebody adds
 * an arm is not a baseline. So the relay's gate keeps its arms and its count, this one has its
 * own, and the mouse gestures both drive with are one library (`tools/lib/net-drive.mjs`) rather
 * than two copies that drift.
 *
 * ## What is proved here, and where each proof lives
 *
 * The three guarantees `src/net/room.ts` names, carried across to a topology with no
 * coordinator in it. They are proved at two levels on purpose:
 *
 * - **`proto`, in Node, with no browser at all.** Two `PeerRoom`s in one process, a simulated
 *   clock and a simulated wire. It is where the ordering, the no-drop guarantee under latency
 *   and jitter, the phase flip, the fault detection and the refusals are established, because
 *   there it can be run a hundred times in a second and every run is deterministic. A claim
 *   about a state machine that can only be tested through two browsers is a claim that gets
 *   tested rarely.
 * - **The browser arms**, which prove the same things *through a real `RTCPeerConnection`* on
 *   the real 8,632-man battle. Fewer runs, much slower, and they are the ones that catch
 *   everything the simulated wire cannot: whether ICE connects at all, whether the pacing
 *   survives a real frame loop, and whether an `https` page can do it.
 *
 * ## The bit-identity proof is a checkpoint history, not a settled tick, and that is stronger
 *
 * `qa-net` brings two clients to a common tick by SIGSTOPing the relay. There is no process to
 * stop between two peers, and two pages read a fifth of a second apart are two pages several
 * ticks apart — measured while writing this: host at 853, guest at 854, every exchanged
 * checkpoint agreeing, and the naive comparison calling that a divergence. `qa-net`'s own
 * `same-battle` is red in four runs of five for exactly this reason and `docs/MULTIPLAYER.md`
 * §12.8 gives up on it.
 *
 * So the primary comparison here is `NetSession.checkpoints()`: each client's own
 * `stateHashes` computed locally at ticks 30, 60, 90 …, intersected by tick and compared bit for
 * bit on all four layers. Twenty-eight agreements across a battle rather than one, at ticks
 * neither page chose, and it cannot be satisfied by the instrument getting lucky. The settled
 * tick is still read and still reported — as a *measurement*, not as a pass/fail, because a
 * number that reproduces four times in five is a number that teaches people to ignore a gate.
 *
 * ## Two things about this machine that had to be measured before anything could be written
 *
 * 1. **Playwright's default headless Chromium cannot hold a peer connection here.** Two browsers,
 *    real STUN, host candidates on the LAN address: `chrome-headless-shell` — which is what
 *    `chromium.launch({ headless: true })` runs — connected 2 times in 17 across four flag
 *    combinations, each failure sitting in `ice: checking` for the full budget with no
 *    `icecandidateerror` and nothing to attribute it to. The same bundled binary in *new*
 *    headless mode (`channel: 'chromium'`) and the system Google Chrome (`channel: 'chrome'`)
 *    both connect in 57-209 ms. So every browser here is `channel: 'chrome'`, and if it is
 *    missing the arm says so rather than reporting a transport failure.
 * 2. **mDNS obfuscation has to be off for the harness and stays on for players.** Chromium hides
 *    local IPs behind `*.local` candidate names by default, and nothing in this environment
 *    resolves them, so `--disable-features=WebRtcHideLocalIpsWithMdns` is a harness flag. A real
 *    player's OS resolves mDNS, and a real player's peer is on another machine.
 *
 * Both are recorded because they are the kind of environment fact that, undocumented, turns into
 * "the new transport is flaky".
 *
 *     node tools/qa-p2p.mjs
 *     node tools/qa-p2p.mjs --only=proto,params,seal      # no browser, about a second
 *     node tools/qa-p2p.mjs --only=battle --shots=/tmp/p2p
 *     node tools/qa-p2p.mjs --all                          # adds `broker`, which uses the internet
 */
import { execFileSync } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { launchBrowser, startVite } from './lib/browser-budget.mjs';
import { spawnOwned } from './lib/process-registry.mjs';
import { lanAddress } from './lib/lan-address.mjs';
import { bootThroughMenu, driveMenu } from './lib/menu-boot.mjs';
import {
  drivers, INSTALL, lobbyFace, logDiff, markDisagreement, openAdvanced, readBoth,
} from './lib/net-drive.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const FLAGS = ['only', 'port', 'relay', 'ab-relay', 'https-port', 'https-relay', 'lobby-relay',
  'seconds', 'shots', 'json', 'all', 'battles', 'channel'];
const args = new Map(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? ''] : [a, ''];
}));
const badFlag = [...args.keys()].filter((k) => !FLAGS.includes(k));
if (badFlag.length) {
  console.error(`unknown flag(s): ${badFlag.join(', ')}\nknown: ${FLAGS.map((f) => `--${f}`).join(' ')}`);
  process.exit(2);
}

const ARMS = ['proto', 'params', 'seal', 'battle', 'lag', 'desync', 'leave', 'lobby', 'https',
  'nodirect', 'ab', 'broker', 'brokerplay'];
/**
 * `broker` and `brokerplay` reach the public internet, so both are opt-in for the reason
 * `xengine` is: a gate that goes red because somebody else's free service is busy teaches
 * people to ignore it.
 *
 * They are two arms rather than one because they cost three orders of magnitude apart.
 * `broker` is two `MqttSignal`s in Node — four seconds, no browser, and most of what the
 * broker path actually is. `brokerplay` boots two battles on top of it. Splitting them is
 * what lets `tools/scratch/inject-p2p.mjs` prove the cheap one red without queueing for a
 * browser slot behind the expensive one.
 */
const DEFAULT_ARMS = ARMS.filter((a) => a !== 'broker' && a !== 'brokerplay');
const ONLY = args.get('only') ?? '';
if (ONLY) {
  const unknown = ONLY.split(',').filter((a) => !ARMS.includes(a));
  if (unknown.length) {
    console.error(`unknown arm(s): ${unknown.join(', ')}\nknown: ${ARMS.join(', ')}`);
    process.exit(2);
  }
}
const ALL = args.has('all');
const wanted = (n) => (ONLY ? ONLY.split(',').includes(n) : ALL || DEFAULT_ARMS.includes(n));

const PORT = Number(args.get('port') ?? 5960);
const SIG_RELAY = Number(args.get('relay') ?? 5961);
const AB_RELAY = Number(args.get('ab-relay') ?? 5962);
const HTTPS_PORT = Number(args.get('https-port') ?? 5963);
const HTTPS_RELAY = Number(args.get('https-relay') ?? 5965);
const LOBBY_RELAY = Number(args.get('lobby-relay') ?? 5966);
const SECONDS = Number(args.get('seconds') ?? 26);
const SHOT_DIR = args.get('shots') ?? '';
const JSON_OUT = args.get('json') ?? '';
const CHANNEL = args.get('channel') ?? 'chrome';
const BATTLES = (args.get('battles')
  ?? 'campus-martius/field,campus-martius/assault,carthage/assault').split(',');
const W = 1280;
const H = 800;
const CERT_DIR = '/tmp/tc-qa-p2p';

/**
 * The console errors a battle boot produces on this branch's base, and therefore not findings.
 *
 * Attributed rather than assumed: `tools/scratch/console404.mjs` boots a *single-player* battle
 * with no room, no relay and no peer connection in it, and gets two of these. The lobby
 * (`?mp=1`) gets none, which is why `qa-net`'s console arms are green. So they predate this work
 * and filtering them by exact text leaves every other error fatal — which is the property that
 * matters, and the reason this is a list of one string rather than a threshold.
 */
const KNOWN_CONSOLE = [
  'Failed to load resource: the server responded with a status of 404 (Not Found)',
];
const newErrors = (errs) => errs.filter((e) => !KNOWN_CONSOLE.some((k) => e.includes(k)));

const results = [];
const measured = {};
let failed = 0;
function record(name, pass, what, changed, note = '') {
  results.push({ name, pass, what, changed, note });
  if (!pass) failed++;
  console.log(`${pass ? '  PASS' : '  FAIL'}  ${name.padEnd(26)} ${what}`);
  console.log(`        → ${changed}${note ? `  [${note}]` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = async (page, name) => {
  if (SHOT_DIR) await page.screenshot({ path: path.join(SHOT_DIR, `${name}.png`) });
};
const { newPage, deployWith, burst, doubleOrder } = drivers({ W, H, shot });

// ---------------------------------------------------------------------------
// Everything this starts, it kills — including on the way out of a throw.
// ---------------------------------------------------------------------------

const cleanups = [];
let dying = false;
function cleanup() {
  if (dying) return;
  dying = true;
  for (const fn of cleanups.splice(0).reverse()) {
    try { fn(); } catch { /* going away regardless */ }
  }
}
const die = (why) => { console.error(`\n${why}`); cleanup(); process.exit(1); };
process.on('SIGINT', () => die('interrupted'));
process.on('SIGTERM', () => die('terminated'));
process.on('uncaughtException', (e) => die(`uncaught: ${e?.stack ?? e}`));
process.on('unhandledRejection', (e) => die(`unhandled rejection: ${e?.stack ?? e}`));

/**
 * Start a relay and wait for it to answer. Its `/health` body, not a 200.
 *
 * Through `spawnOwned` rather than a bare `spawn`, which is three things the house rule is for
 * and one of them has actually happened on this machine. A guard process anchored to *this
 * agent*, so a relay outlives neither the harness nor the agent that started it — `--parent=` is
 * kept as well, because two independent watches of the same fact is the point and a SIGKILLed
 * guard still leaves the runner's own poll. A registry entry naming the owner, the worktree and
 * the branch, so `node tools/browsers.mjs sweep` can say whose a stray listener is instead of
 * inferring. And a tree kill rather than a group kill.
 *
 * `tools/qa-net.mjs` still uses a bare `spawn` here and predates the rule; the two are not
 * merged because that file's `startRelay` carries a retry and a `--host=0.0.0.0` case this one
 * does not need, and merging them under a networking change is how a gate's baseline moves.
 */
async function startRelay(port, extra = []) {
  const job = spawnOwned(process.execPath,
    [path.join(ROOT, 'tools', 'relay.mjs'), `--port=${port}`,
      `--parent=${process.pid}`, '--quiet', ...extra],
    {
      cwd: ROOT,
      root: ROOT,
      port,
      label: `relay:${port}`,
      stdio: ['ignore', 'ignore', 'pipe'],
      meta: { kind: 'relay', gate: 'qa-p2p' },
    });
  let stderr = '';
  // The handle's `child` is the *guard*, and the guard runs the relay with its stderr inherited,
  // so this is the relay's own output. `startVite` reads its vite the same way.
  job.child.stderr?.on('data', (d) => { stderr += String(d); });
  let dead = false;
  const stop = () => {
    if (dead) return;
    dead = true;
    try { job.kill({ graceMs: 800 }); } catch { /* already gone */ }
  };
  cleanups.push(stop);
  for (let i = 0; i < 60; i++) {
    await sleep(120);
    const body = await fetch(`http://127.0.0.1:${port}/health`)
      .then((r) => r.text()).catch(() => '');
    if (body.startsWith('relay ok')) {
      return { base: `ws://127.0.0.1:${port}`, http: `http://127.0.0.1:${port}`, job, stop };
    }
    if (job.killed) break;
  }
  stop();
  throw new Error(`relay did not start on ${port}${stderr ? `: ${stderr.trim()}` : ''}`);
}

// ---------------------------------------------------------------------------
// The peer-side comparison
// ---------------------------------------------------------------------------

/**
 * Every checkpoint the two clients both reached, compared bit for bit. The lockstep proof.
 *
 * Returns `{ common, highest, bad }` — how many ticks both sides hashed, the highest of them,
 * and the first that disagreed with the layer named. `bad` is null when they agree everywhere.
 *
 * `common` is reported and asserted on, because "they agreed at every tick they both reached"
 * is vacuous when that number is zero, and a check that passes on an empty intersection is the
 * kind this repository keeps writing down.
 */
function compareChecks(a, b) {
  const byTick = new Map(b.map((m) => [m.tick, m]));
  let common = 0;
  let highest = -1;
  let bad = null;
  for (const m of a) {
    const t = byTick.get(m.tick);
    if (!t) continue;
    common++;
    if (m.tick > highest) highest = m.tick;
    if (bad) continue;
    for (const layer of ['uf64', 'uctl', 'hash', 'alive']) {
      if (m[layer] === t[layer]) continue;
      bad = `${layer} differs at tick ${m.tick}: ${m[layer]} against ${t[layer]}`;
      break;
    }
  }
  return { common, highest, bad };
}

/**
 * Bring two peers to a rest and read where they stopped. **Best effort, and reported as such.**
 *
 * There is no relay process to stop, so this waits for the two tick counters to coincide on two
 * consecutive reads. In a peer session that is a much better bet than it is through a relay —
 * the two are locked to within `TICKS_PER_TURN × delayTurns` by construction — but it is still a
 * wall-clock race against two frame loops, and `qa-net`'s equivalent is red in four runs of five.
 *
 * So nothing is *asserted* on the result. The bit-identity claim is `compareChecks`, which is
 * taken at ticks neither page chose and does not care where they stopped.
 */
async function settlePeers(host, guest, ms = 12000) {
  const t0 = Date.now();
  let last = [-1, -2];
  while (Date.now() - t0 < ms) {
    const a = await host.evaluate(() => window.__tick());
    const b = await guest.evaluate(() => window.__tick());
    if (a === b && a === last[0]) return { tick: a, apart: 0, settled: true };
    if (a === b) { last = [a, b]; await sleep(120); continue; }
    last = [a, b];
    await sleep(200);
  }
  const a = await host.evaluate(() => window.__tick());
  const b = await guest.evaluate(() => window.__tick());
  return { tick: Math.min(a, b), apart: Math.abs(a - b), settled: false };
}

let roomSeq = 0;
const nextRoom = () => `PP${String(++roomSeq).padStart(3, '0')}`
  .replace(/0/g, 'Q').replace(/1/g, 'R').slice(0, 5);

/**
 * Two clients in one room over a direct connection, both booted the way a player boots.
 *
 * The host goes through the front door and the setup sheet with real clicks. The challenger has
 * no menu: it is given the host's battle over the data channel, which is the whole point of
 * `setup` arriving before either client has an army.
 */
/**
 * `extra` goes to **both** pages; `hostExtra` and `guestExtra` go to one.
 *
 * The distinction is not tidiness and getting it wrong makes a whole arm vacuous. A latency knob
 * belongs on both — that is what a symmetric link is. A *fault* belongs on exactly one, because
 * the design is symmetric: `--p2pfault=ulp` on both peers perturbs the same field of the same
 * unit on both, by the same one unit in the last place, and the two battles stay bit-identical.
 * The desync arm would then have injected a fault, fired it, and correctly reported no
 * divergence — an arm passing by proving the opposite of what it claims.
 */
async function bootPeers(hostBrowser, guestBrowser, base, {
  room = nextRoom(), sig, deploy = true, autoplay = 0, map = 'campus-martius',
  scenario = 'field', size = 'small', extra = '', hostExtra = '', guestExtra = '',
  shots = null,
} = {}) {
  const q = `room=${room}&sig=${encodeURIComponent(sig)}&autoplay=${autoplay}`
    + `&deploy=${deploy ? 1 : 0}${extra}`;
  const host = await newPage(hostBrowser);
  await bootThroughMenu(host, {
    base,
    map,
    scenario,
    tier: 'high',
    size,
    // `host=1` and not merely the absence of `host=0`: a bare `?room=` is an *invitation* and
    // `main.ts` reads it as a join. Peer to peer there is no `?net=` to tell the two apart.
    query: `${q}&host=1${hostExtra}`,
    onSetup: shots ? (p) => shot(p, `${shots}-01-setup`) : undefined,
  });
  const guest = await newPage(guestBrowser);
  await guest.goto(`${base}/?${q}&host=0${guestExtra}`, { waitUntil: 'domcontentloaded' });
  await guest.waitForFunction(() => window.__game?.ready === true, null, { timeout: 300000 });
  await host.evaluate(INSTALL);
  await guest.evaluate(INSTALL);
  for (const p of [host, guest]) {
    await p.waitForFunction(
      () => ['deploy', 'battle'].includes(window.__net()?.phase), null, { timeout: 120000 });
  }
  // Read off the *challenger*: what it is standing in arrived over the data channel in `setup`,
  // because the challenger never sees a menu. Recording the argument would prove nothing.
  const cfg = await guest.evaluate(() => {
    const c = window.__rec()?.cfg;
    return c ? { map: c.map, scenario: c.scenario } : null;
  });
  return { host, guest, room, cfg };
}

/** Play a match out: deploy both sides, fire orders, then run to the clock. */
async function playMatch(host, guest, { seconds = SECONDS, rounds = 4, shots = null } = {}) {
  const acts = { host: [], guest: [] };
  acts.host.push(...await deployWith(host, `${shots ?? 'p2p'}-host`));
  acts.guest.push(...await deployWith(guest, `${shots ?? 'p2p'}-guest`));
  const t0 = Date.now();
  for (let i = 0; i < rounds; i++) {
    acts.host.push(...await burst(host, i));
    acts.guest.push(...await burst(guest, i + 1));
    await sleep(400);
  }
  const left = seconds * 1000 - (Date.now() - t0);
  if (left > 0) await sleep(left);
  return acts;
}

// ---------------------------------------------------------------------------
// Arm: the state machine, in Node, with a simulated clock and a simulated wire
// ---------------------------------------------------------------------------

if (wanted('proto')) {
  console.log('\n=== proto: two PeerRooms, a simulated clock and a simulated wire ===');
  const { PeerRoom } = await import('../src/net/peerRoom.ts');
  const { TICKS_PER_TURN } = await import('../src/net/protocol.ts');

  const print = (over = {}) => ({
    cfgKey: '{"map":"field"}', quality: 'high', unitScale: 1, count0: 8632, tick0: 0,
    hash: 'aaaa', uf64: 'bbbb', uctl: 'cccc', libm: 'dddd', ua: 'Chrome/151',
    deployPhase: false, ...over,
  });

  /**
   * A reliable, ordered wire with a one-way delay and optional jitter.
   *
   * **Jitter delays a frame; it does not reorder one**, and the first version of this got that
   * wrong. An `RTCDataChannel` with `ordered: true` is SCTP with in-order delivery: a frame held
   * up by jitter holds up every frame behind it. Modelling jitter as an independent per-frame
   * delay let a later frame overtake an earlier one, `PeerRoom` correctly refused the stream,
   * and the driver reported "at 60 ms ± 40 ms nothing was dropped" over a match that had never
   * started. The measurement was of the fake wire, not of the state machine.
   */
  class Wire {
    constructor({ owdMs = 0, jitterMs = 0, rng = () => 0.5 } = {}) {
      this.q = [];
      this.owdMs = owdMs;
      this.jitterMs = jitterMs;
      this.rng = rng;
      this.lastAt = [0, 0];
      this.sent = [0, 0];
    }

    send(from, msg, now) {
      const lag = this.owdMs + (this.jitterMs ? this.rng() * this.jitterMs : 0);
      const at = Math.max(now + lag, this.lastAt[from] + 1e-6);
      this.lastAt[from] = at;
      this.sent[from]++;
      this.q.push({ at, from, msg, n: this.q.length });
    }

    due(now) {
      const ready = this.q.filter((e) => e.at <= now);
      this.q = this.q.filter((e) => e.at > now);
      ready.sort((a, b) => (a.from - b.from) || (a.n - b.n));
      return ready;
    }
  }

  class Peer {
    constructor(code, slot, opts) {
      this.room = new PeerRoom(code, slot, opts);
      this.slot = slot;
      this.tick = 0;
      this.ceiling = 0;
      this.turns = [];
      this.locals = [];
      this.ops = [];
      this.wanted = [];
      this.maxBehind = 0;
    }

    take(reply, wire, now) {
      for (const m of reply.wire) wire.send(this.slot, m, now);
      for (const m of reply.local) {
        this.locals.push(m);
        if (m.k === 'wantProbe') this.wanted.push(m.tick);
        if (m.k !== 'turn') continue;
        this.turns.push(`${m.ph}${m.n}@${m.t}`);
        for (const o of m.ops) this.ops.push(`${m.ph}${m.n}/${o.s}:${o.i}:${JSON.stringify(o.e)}`);
        if (m.ph === 'battle') this.ceiling = (m.n + 1) * TICKS_PER_TURN;
      }
    }
  }

  /**
   * One whole match. `paced` runs the fake simulation at 30 Hz off the same simulated clock,
   * which is the only way to ask whether the commit loop keeps the battle at real time.
   */
  const runMatch = ({
    owdMs = 0, jitterMs = 0, ticks = 900, ordersAt = [], fault = null, faultOn = 0,
    deployPhase = false, seed = 1, hashEvery = 30, forkAt = -1, paced = false,
  } = {}) => {
    let s = seed >>> 0;
    const rng = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
    const wire = new Wire({ owdMs, jitterMs, rng });
    const peers = [
      new Peer('ABCDE', 0, { turnMs: 100, fault: fault && faultOn === 0 ? fault : null }),
      new Peer('ABCDE', 1, { turnMs: 100, fault: fault && faultOn === 1 ? fault : null }),
    ];
    let now = 0;
    const step = 1000 / 60;
    for (const p of peers) p.take(p.room.open(now), wire, now);
    peers[0].take(peers[0].room.fromClient(now,
      { k: 'setup', cfg: { map: 'field' }, deployPhase }), wire, now);
    for (const p of peers) {
      p.take(p.room.fromClient(now, {
        k: 'ready', print: print({ deployPhase }), cfg: { map: 'field' }, factions: [0, 1],
      }), wire, now);
    }
    const issued = [];
    let frames = 0;
    /*
     * A **settle phase**, and it is the difference between measuring the product and measuring
     * where the loop happened to stop.
     *
     * Two versions of this were wrong in opposite directions. Stopping the instant both peers
     * hit the tick target cut a round trip in half and reported an order lost that was still in
     * flight — issued 34, played 33. Waiting for the wire to go empty never terminates at all,
     * because the beat and the commit stream are unconditional and there is always a frame in
     * flight; that run went to its guard and reported t+89,996.
     *
     * So: reach the target, stop issuing orders, and run one more simulated second of ordinary
     * frames — delivery, hashing, probes and pumping, all of it — which is ten turns at a 100 ms
     * cadence and comfortably longer than any round trip modelled here.
     */
    const SETTLE = 60;
    let settle = -1;
    /*
     * The run does not end before the last order has been *issued*, and that is a correction.
     *
     * The schedule is by frame and the tick target is by tick, so at a low latency the peers hit
     * 600 ticks in 120 frames and a schedule running to frame 469 had issued nine of its forty
     * orders. The rows then read `9/9 ... 15/15 ... 34/34` -- every one of them honest about
     * what it measured and none of them measuring what the check claims, which is what a
     * vacuity guard of `issued > 30` correctly refused to sign off on. Waiting for the schedule
     * makes the denominator the same at every latency, which is the whole point of comparing
     * the rows against each other.
     */
    const lastOrder = ordersAt.reduce((m, o) => Math.max(m, o.t), 0);
    while (frames++ < 6000) {
      now += step;
      for (const e of wire.due(now)) {
        const p = peers[e.from ^ 1];
        p.take(p.room.fromPeer(now, e.msg), wire, now);
      }
      if (settle < 0) {
        for (const at of ordersAt) {
          if (Math.abs(at.t - frames) > 0.5) continue;
          const p = peers[at.slot];
          const ev = [];
          for (let k = 0; k < (at.burst ?? 1); k++) {
            const blob = ['move', at.slot, at.t, (at.tag ?? 0) * 10 + k];
            issued.push(`${at.slot}:${JSON.stringify(blob)}`);
            ev.push(blob);
          }
          p.take(p.room.fromClient(now, { k: 'ops', ev }), wire, now);
        }
        /*
         * **Staggered, and the stagger is the check.**
         *
         * Both peers pressing BEGIN BATTLE on the same frame makes a phase flip driven off a
         * peer's *own* ready flag agree by coincidence: `flip-on-my-own-flag` in
         * `tools/scratch/inject-p2p.mjs` left `proto-phase-flip-agrees` green for exactly that
         * reason. Fifteen frames apart is a quarter of a second, which is far less than two
         * people take, and it is enough for a wrong implementation to flip on different turns.
         */
        if (deployPhase && frames === 30) {
          peers[0].take(peers[0].room.fromClient(now, { k: 'deployReady' }), wire, now);
        }
        if (deployPhase && frames === 45) {
          peers[1].take(peers[1].room.fromClient(now, { k: 'deployReady' }), wire, now);
        }
      }
      for (const p of peers) {
        // The accumulator, when `paced`: whole 1/30 s ticks, at most five a frame, exactly as
        // `Time.beginFrame` hands them out. Unpaced, it runs straight to the ceiling, which is
        // right for an ordering test and useless for a pacing one.
        const budget = paced ? Math.min(5, Math.floor(now / (1000 / 30)) - p.tick) : 5;
        let n = 0;
        while (p.tick < p.ceiling && n++ < Math.max(0, budget)) {
          p.tick++;
          p.maxBehind = Math.max(p.maxBehind, p.ceiling - p.tick);
          if (p.tick % hashEvery !== 0) continue;
          const forked = forkAt >= 0 && p.tick >= forkAt && p.slot === 1;
          p.take(p.room.fromClient(now, {
            k: 'hash', tick: p.tick,
            hash: `h${p.tick}`, uf64: forked ? `X${p.tick}` : `u${p.tick}`,
            uctl: `c${p.tick}`, alive: 8000,
          }), wire, now);
        }
        while (p.wanted.length) {
          const t = p.wanted.shift();
          const forked = forkAt >= 0 && p.slot === 1;
          p.take(p.room.fromClient(now, {
            k: 'probe', tick: t, units: [[1, 'a'], [2, forked ? 'ZZ' : 'b'], [3, 'c']],
          }), wire, now);
        }
        p.take(p.room.pump(now, p.tick), wire, now);
      }
      if (settle >= 0) { if (--settle <= 0) break; continue; }
      if (peers.every((p) => p.room.over)
        || (frames > lastOrder && peers.every((p) => p.tick >= ticks))) settle = SETTLE;
    }
    return { peers, wire, issued, frames, now };
  };

  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  // -- 1. one clean battle ---------------------------------------------------
  {
    /*
     * **Both slots order on the same frame**, and that is what makes the ordering claim testable.
     *
     * Alternating slots frame by frame put every turn's ops in one slot, and a turn carrying one
     * slot's ops is sorted identically by `(slot, seq)` and by `seq` alone — so
     * `proto-sorted-by-slot-seq` stayed green with `sorted()` deliberately reduced to
     * `a.i - b.i`, which is the `unsorted-turn` fault in `tools/scratch/inject-p2p.mjs`. Two
     * players whose orders land in one turn is also the realistic case and the one §4.1 is about.
     */
    const orders = [];
    for (let i = 0; i < 24; i++) {
      orders.push({ t: 40 + i * 13, slot: 0, tag: i, burst: 2 });
      orders.push({ t: 40 + i * 13, slot: 1, tag: 100 + i, burst: 2 });
    }
    const r = runMatch({ ticks: 900, ordersAt: orders });
    const [a, b] = r.peers;
    record('proto-one-order-stream',
      eq(a.ops, b.ops) && a.ops.length === r.issued.length && a.ops.length > 0,
      'both peers play every order, in one order, with no coordinator',
      `${r.issued.length} issued by two players, ${a.ops.length} played by the host and `
      + `${b.ops.length} by the challenger; streams identical ${eq(a.ops, b.ops)}`,
      'the total-order guarantee, from (turn, slot, seq) stamped at source');
    record('proto-one-turn-stream', eq(a.turns, b.turns) && a.turns.length > 100,
      'both peers emit the identical turn packets at the identical execution ticks',
      `${a.turns.length} turns each, last ${a.turns.at(-1)}; identical ${eq(a.turns, b.turns)}`);
    const sortedOk = a.ops.every((o, i) => {
      if (i === 0) return true;
      const [pt, pk] = [a.ops[i - 1].split('/')[0], a.ops[i - 1].split('/')[1]];
      const [ct, ck] = [o.split('/')[0], o.split('/')[1]];
      if (pt !== ct) return true;
      const [ps, pi] = pk.split(':').map(Number);
      const [cs, ci] = ck.split(':').map(Number);
      return cs > ps || (cs === ps && ci > pi);
    });
    // A turn that mixes the two slots is what the claim is about, so the count of them is
    // asserted: without one the comparison below is satisfied by any ordering at all.
    const mixed = new Set();
    for (const o of a.ops) {
      const turn = o.split('/')[0];
      const slot = o.split('/')[1].split(':')[0];
      mixed.add(`${turn}:${slot}`);
    }
    const turnsWithBoth = [...new Set([...mixed].map((k) => k.split(':')[0]))]
      .filter((t) => mixed.has(`${t}:0`) && mixed.has(`${t}:1`)).length;
    record('proto-sorted-by-slot-seq', sortedOk && turnsWithBoth > 0,
      'every turn packet is in (slot, seq) order, checkable from the packet alone',
      `${a.ops.length} ops across ${a.turns.length} turns, ${turnsWithBoth} of which carry both `
      + `players' orders; all ascending within their turn`,
      'a turn holding one slot\'s ops is sorted the same by (slot, seq) and by seq alone, so the '
      + 'count of mixed turns is part of the check');
  }

  // -- 2. latency and jitter -------------------------------------------------
  {
    const rows = [];
    let allOk = true;
    for (const [owdMs, jitterMs] of [[0, 0], [25, 0], [60, 0], [60, 40], [150, 80]]) {
      const orders = [];
      for (let i = 0; i < 40; i++) orders.push({ t: 40 + i * 11, slot: i % 2, tag: i });
      const r = runMatch({ owdMs, jitterMs, ticks: 600, ordersAt: orders, seed: 7 });
      const [a, b] = r.peers;
      const ok = eq(a.ops, b.ops) && a.ops.length === r.issued.length && r.issued.length > 30;
      allOk = allOk && ok;
      rows.push({
        owdMs, jitterMs, issued: r.issued.length, played: a.ops.length,
        identical: eq(a.ops, b.ops), tick: Math.min(a.tick, b.tick), ok,
      });
    }
    measured.protoLatency = rows;
    record('proto-nothing-dropped', allOk,
      'no order is lost or reordered at any latency, and the peers stall rather than drop',
      rows.map((r) => `${r.owdMs}±${r.jitterMs}ms ${r.played}/${r.issued}`
        + `${r.identical ? '' : ' DIFFERENT'} to t+${r.tick}`).join('; '),
      'a slow peer makes its opponent wait; there is no deadline anywhere in PeerRoom');
  }

  // -- 3. the deployment phase ----------------------------------------------
  {
    const r = runMatch({ deployPhase: true, ticks: 300, ordersAt: [
      { t: 5, slot: 0 }, { t: 6, slot: 1 }, { t: 10, slot: 0 }, { t: 100, slot: 1 },
    ] });
    const [a, b] = r.peers;
    const dep = a.turns.filter((t) => t.startsWith('deploy'));
    record('proto-deploy-in-one-order',
      eq(a.ops, b.ops) && a.ops.length === r.issued.length && dep.length > 0,
      'deployment operations cross in one order and none is lost',
      `${dep.length} deploy turns, ${a.ops.length} of ${r.issued.length} operations played, `
      + `all at tick ${[...new Set(dep.map((t) => t.split('@')[1]))].join(',')}`,
      'deployment mints unit ids, so a different sequence is a different army (§4.1)');
    record('proto-phase-flip-agrees',
      a.room.phase === 'battle' && b.room.phase === 'battle'
      && a.room.deployTurn === b.room.deployTurn,
      'both peers leave the deployment phase after the same deploy turn, with no shared clock',
      `host ${a.room.phase} after deploy turn ${a.room.deployTurn}, `
      + `guest ${b.room.phase} after ${b.room.deployTurn}`,
      'the flip is a function of the commit stream, not of two wall clocks');
  }

  // -- 4. a fork is detected, attributed, and ends the match -----------------
  {
    const r = runMatch({ ticks: 900, forkAt: 120, owdMs: 25 });
    const [a, b] = r.peers;
    const da = a.locals.find((m) => m.k === 'desync');
    const db = b.locals.find((m) => m.k === 'desync');
    const at = a.locals.find((m) => m.k === 'attrib');
    const ea = a.locals.find((m) => m.k === 'end');
    const eb = b.locals.find((m) => m.k === 'end');
    record('proto-fork-detected',
      !!da && !!db && da.tick === db.tick && da.layer === db.layer && da.layer === 'uf64',
      'both peers declare the same fork, at the same tick, on the same layer, with no coordinator',
      da && db ? `host tick ${da.tick} layer ${da.layer}, guest tick ${db.tick} layer ${db.layer}`
        : `host ${!!da}, guest ${!!db}`,
      'uf64 is the detector: no quantisation firewall, so it moves first (§1.4)');
    record('proto-fork-mine-is-mine', !!da && da.mine === `u${da.tick}` && da.theirs === `X${da.tick}`,
      "each peer's report says which of the two hashes was its own",
      da ? `host reports mine ${da.mine}, theirs ${da.theirs}` : 'no report',
      'the marks arrive in whichever order the wire produced them');
    record('proto-fork-attributed', !!at && eq(at.units, [2]),
      'the fork is attributed to the regiment whose digest differed',
      at ? `units ${JSON.stringify(at.units)}: ${at.note}` : 'no attribution came back');
    record('proto-fork-ends-both',
      !!ea && !!eb && ea.why === 'desync' && eb.why === 'desync' && a.tick < 900 && b.tick < 900,
      'the match ends by name on both peers, and stops rather than playing on',
      ea && eb ? `host ${ea.why} at tick ${ea.atTick}, guest ${eb.why} at ${eb.atTick}; `
        + `stopped at ${a.tick} and ${b.tick} of a 900-tick run` : 'no end');
  }

  // -- 5. every injected fault fires, and the two modes do the two different things --------
  /*
   * A published fault is a *shared* corruption and a local fault is a *fork*, and both are worth
   * asserting because getting the difference wrong makes a whole arm vacuous.
   *
   * `Room.bend` sends the bent packet to one slot and the clean one to the other: a relay has a
   * canonical stream and one client is given something else. There is no canonical stream between
   * two peers, so a corrupted commit is corrupted for both — which the rows below assert, because
   * it is a real property of the topology and not an accident. The fork the *detector* exists for
   * needs the corruption to stay on one side, which is `?p2pfault-local=1`, and the second block
   * asserts that it does.
   */
  for (const kind of ['drop', 'dup', 'swap', 'ulp']) {
    const orders = [];
    for (let i = 0; i < 30; i++) orders.push({ t: 30 + i * 7, slot: i % 2, tag: i, burst: 3 });
    const r = runMatch({ ticks: 500, ordersAt: orders, fault: { kind, fromTurn: 12 } });
    const [a, b] = r.peers;
    const fired = a.room.status().faultsFired;
    // `ulp` is local-only by construction, so the host plays the marker and the guest does not.
    const want = kind === 'drop' ? r.issued.length - 1
      : kind === 'dup' ? r.issued.length + 1
        : kind === 'ulp' ? r.issued.length + 1 : r.issued.length;
    // `swap` changes the order, not the count, so the count alone cannot see it: the observable
    // is a pair out of ascending order within one turn from one slot.
    const tagOf = (o) => Number(JSON.parse(o.slice(o.indexOf('['))).at(-1));
    const swapped = kind !== 'swap' || a.ops.some((o, i) => i > 0
      && o.split('/')[0] === a.ops[i - 1].split('/')[0] && tagOf(o) < tagOf(a.ops[i - 1]));
    const shared = kind !== 'ulp';
    record(`proto-fault-${kind}`,
      fired === 1 && a.ops.length === want && swapped
      && (shared ? eq(a.ops, b.ops) : !eq(a.ops, b.ops)),
      shared
        ? `--p2pfault=${kind} corrupts the record at the source and both peers play the corruption`
        : '--p2pfault=ulp perturbs only the peer that carries it, which is the fork a libm '
          + 'disagreement actually is',
      `fired ${fired}, ${r.issued.length} issued, host played ${a.ops.length} `
      + `(expected ${want}) and guest played ${b.ops.length}; streams identical `
      + `${eq(a.ops, b.ops)}${kind === 'swap' ? `, pair exchanged ${swapped}` : ''}`,
      shared
        ? 'a peer-to-peer commit goes to both ends of one channel, so there is no canonical '
          + 'stream for one side to diverge from'
        : 'the marker never leaves this peer: published, both sides would perturb the same '
          + 'field of the same unit and the fault would prove nothing');
  }

  // -- 5b. and a local-only fault really is one-sided ------------------------
  for (const kind of ['drop', 'swap']) {
    const orders = [];
    for (let i = 0; i < 30; i++) orders.push({ t: 30 + i * 7, slot: 0, tag: i, burst: 3 });
    const r = runMatch({
      ticks: 500, ordersAt: orders, fault: { kind, fromTurn: 12, localOnly: true },
    });
    const [a, b] = r.peers;
    const fired = a.room.status().faultsFired;
    record(`proto-fault-${kind}-local`,
      fired === 1 && !eq(a.ops, b.ops) && b.ops.length === r.issued.length,
      `--p2pfault=${kind}&p2pfault-local=1 forks the two simulations, which is what a detector `
      + 'is for',
      `fired ${fired}, ${r.issued.length} issued; the peer that carries the fault played `
      + `${a.ops.length} and its opponent played ${b.ops.length}; streams differ `
      + `${!eq(a.ops, b.ops)}`,
      'without this mode every fault here is symmetric and the browser desync arm would have '
      + 'injected a fault, fired it, and correctly found nothing');
  }

  // -- 6. a commit for a turn already played --------------------------------
  {
    const r = runMatch({ ticks: 120, ordersAt: [] });
    const [a] = r.peers;
    const already = a.room.turn;
    const before = a.ops.length;
    a.take(a.room.fromPeer(r.now, {
      k: 'commit', ph: 'battle', n: already, i0: 9000, ops: [['move', 1, 9999, 1]], ready: false,
    }), r.wire, r.now);
    const refused = a.locals.filter((m) => m.k === 'refuse').at(-1);
    const ended = a.locals.filter((m) => m.k === 'end').at(-1);
    record('proto-late-commit-refused',
      !!refused && refused.why === 'protocol' && a.ops.length === before
      && a.room.phase === 'over' && !!ended,
      'a commit for a turn already played stops the match and names what would have been lost',
      refused ? refused.detail : `no refusal; the peer was at turn ${already}`,
      'dropping it silently would be dropping input, which is the thing guarantee 2 forbids');
  }

  // -- 6b. the host speaks before anybody is listening ----------------------
  {
    /*
     * The host publishes `setup` when its menu closes and `ready` when its army is on the field,
     * and both can be **minutes** before a challenger types the code. A relay cannot have this
     * problem — its socket is open from before the menu — and this transport can: measured in the
     * `lobby` arm as two clients connected, both `ready`, and neither ever leaving `phase: lobby`,
     * because the frames had been handed to a data channel that did not exist.
     *
     * So the contract is asserted here, where it is one line and no browser: **a `PeerRoom` that
     * has not opened still produces every wire frame**, and it is the adapter's job to hold them.
     * `PeerLink.preOpen` is that job; this is the half of it the state machine owes.
     */
    const solo = new PeerRoom('ABCDE', 0, { turnMs: 100 });
    const beforeSetup = solo.fromClient(0, { k: 'setup', cfg: { map: 'field' }, deployPhase: false });
    const beforeReady = solo.fromClient(0, {
      k: 'ready', print: print(), cfg: { map: 'field' }, factions: [0, 1],
    });
    const kinds = [...beforeSetup.wire, ...beforeReady.wire].map((m) => m.k);
    record('proto-speaks-before-the-peer-arrives',
      kinds.includes('setup') && kinds.includes('ready'),
      'a host that publishes its battle and its army before a challenger exists still emits both',
      `with no channel open at all: ${JSON.stringify(kinds)}`,
      'the adapter holds them (PeerLink.preOpen); dropping them left both pages in the lobby '
      + 'phase for ever');
  }

  // -- 7. two hosts in one room ---------------------------------------------
  {
    const wire = new Wire();
    const a = new Peer('ABCDE', 0, { turnMs: 100 });
    const b = new Peer('ABCDE', 0, { turnMs: 100 });
    a.take(a.room.open(0), wire, 0);
    b.take(b.room.open(0), wire, 0);
    for (const e of wire.due(1)) {
      const p = e.from === 0 ? b : a;
      p.take(p.room.fromPeer(1, e.msg), wire, 1);
    }
    const r = [...a.locals, ...b.locals].find((m) => m.k === 'refuse');
    record('proto-two-hosts-refused', !!r && r.why === 'slot',
      'two peers that both pressed CREATE are refused by name in the first frame',
      r ? `${r.why}: ${r.detail}` : 'not refused',
      'a relay assigns slots and cannot have this failure; a code can');
  }

  // -- 8. the pacing, which is the one thing a relay does not have to do -----
  {
    const r = runMatch({ ticks: 600, paced: true, owdMs: 20 });
    const [a, b] = r.peers;
    const wallS = r.now / 1000;
    const simS = a.tick / 30;
    const ratio = simS / wallS;
    const bound = 3 * 2 + 3;
    measured.protoPacing = {
      wallS: Math.round(wallS * 10) / 10, simS: Math.round(simS * 10) / 10,
      ratio: Math.round(ratio * 100) / 100, maxBehind: Math.max(a.maxBehind, b.maxBehind), bound,
    };
    record('proto-runs-at-real-time',
      ratio > 0.8 && ratio < 1.2 && Math.max(a.maxBehind, b.maxBehind) <= bound,
      'the commit loop paces the battle at real time and never authorises a fast-forward',
      `${simS.toFixed(1)} s of battle in ${wallS.toFixed(1)} s of clock (×${ratio.toFixed(2)}); `
      + `the ceiling never ran more than ${Math.max(a.maxBehind, b.maxBehind)} ticks ahead of the `
      + `simulation, against a structural bound of ${bound}`,
      'a commit is earned by consuming a turn; without that tie two peers finish in a tenth '
      + 'of the time');
  }
}

// ---------------------------------------------------------------------------
// Arm: what a URL means, and what the test knobs are reachable from
// ---------------------------------------------------------------------------

if (wanted('params')) {
  console.log('\n=== params: which wire a URL asks for, and who introduces the peers ===');
  const { chooseTransport, testKnobs } = await import('../src/net/transport.ts');
  const q = (s) => new URLSearchParams(s);
  const rows = [
    ['room=ABCDE', null, { kind: 'peer', want: 'host', signalWs: null }],
    ['room=ABCDE&host=0', null, { kind: 'peer', want: 'join', signalWs: null }],
    ['room=ABCDE', 'ws://192.168.1.77:5959', { kind: 'peer', want: 'host', signalWs: 'ws://192.168.1.77:5959' }],
    ['room=ABCDE&sig=broker', 'ws://192.168.1.77:5959', { kind: 'peer', want: 'host', signalWs: null }],
    ['room=ABCDE&sig=ws://x:1', null, { kind: 'peer', want: 'host', signalWs: 'ws://x:1' }],
    ['net=ws://r:5959&room=ABCDE', null, { kind: 'relay', want: 'host' }],
    ['net=ws://r:5959&room=ABCDE&host=0', 'ws://s:1', { kind: 'relay', want: 'join' }],
    /*
     * Both at once, and `?net=` wins. Without this row the table said nothing about precedence:
     * `sig-outranks-net` in `tools/scratch/inject-p2p.mjs` reordered the two clauses and
     * `params-transport-table` stayed green, because no row had ever put them in the same URL.
     */
    ['net=ws://r:5959&sig=ws://s:1&room=ABCDE', null, { kind: 'relay', base: 'ws://r:5959' }],
    ['net=ws://r:5959&sig=broker&room=ABCDE', null, { kind: 'relay', base: 'ws://r:5959' }],
  ];
  const bad = [];
  for (const [url, server, want] of rows) {
    const got = chooseTransport(q(url), server);
    for (const k of Object.keys(want)) {
      if (got?.[k] !== want[k]) bad.push(`?${url} → ${k} ${got?.[k]} (wanted ${want[k]})`);
    }
  }
  record('params-transport-table', bad.length === 0,
    'every URL shape picks the wire and the introduction service the table says it does',
    bad.length ? bad.join('; ') : `${rows.length} URL shapes, all as documented`,
    'an explicit ?net= is the only thing that asks for a relay');
  record('params-bad-code-refused',
    chooseTransport(q('room=IOL01'), null) === null && chooseTransport(q(''), null) === null,
    'a malformed room code and an absent one both produce no transport at all',
    'room=IOL01 → null, no room → null',
    'I, O, 0 and 1 are not in the alphabet, because a code gets read aloud');
  const plain = testKnobs(q('room=ABCDE&host=0&sig=ws://x&menu=battle'));
  record('params-no-knobs-by-default', Object.keys(plain).length === 0,
    'every URL the product itself builds turns on no test-only behaviour at all',
    `?room&host&sig&menu → ${JSON.stringify(plain)}`,
    'the audit that keeps --p2pfault out of a player\'s session');
  const knobs = testKnobs(q('p2plag=60&p2pfault=ulp&p2pfault-from=9&p2pcand=srflx&p2pstun=0'));
  record('params-knobs-when-asked',
    knobs.sendDelayMs === 60 && knobs.fault?.kind === 'ulp' && knobs.fault?.fromTurn === 9
    && JSON.stringify(knobs.onlyCandidates) === '["srflx"]'
    && Array.isArray(knobs.iceServers) && knobs.iceServers.length === 0,
    'and each knob is read when it is asked for, so the arms below are exercising it',
    JSON.stringify(knobs));
}

// ---------------------------------------------------------------------------
// Arm: the introduction, sealed
// ---------------------------------------------------------------------------

if (wanted('seal')) {
  console.log('\n=== seal: the topic is a hash, the payload is ciphertext ===');
  const { keyFor, PUBLIC_BROKERS, seal, topicFor, unseal } = await import('../src/net/signal.ts');
  const { CODE_ALPHABET } = await import('../src/net/protocol.ts');
  /*
   * The product's own `keyFor`, and it had to be exported for this.
   *
   * This arm used to derive the key itself, inline, with a copy of the same six lines. That made
   * `seal-round-trip` a comparison between `seal`, `unseal` and *the harness's* idea of the key —
   * and it stayed green when `keyFor` was deliberately changed to ignore the room code, which
   * would let anybody's envelope open in anybody's room. `inject-p2p.mjs`'s
   * `one-key-for-every-room` fault is what found it, which is the whole reason the injections
   * exist.
   */
  const kA = await keyFor('ABCDE');
  const kB = await keyFor('ZZZZZ');
  const msg = { t: 'offer', from: 0, sdp: 'v=0\r\no=- 1 1 IN IP4 192.168.1.77\r\n' };
  const env = await seal(kA, msg);
  const back = await unseal(kA, env);
  const wrong = await unseal(kB, env);
  record('seal-round-trip',
    JSON.stringify(back) === JSON.stringify(msg) && wrong === null,
    'an offer seals and opens under the room code, and opens as nothing under another',
    `${env.length} base64 chars; the right code returns the offer, the wrong one returns null`);
  record('seal-hides-the-sdp',
    !env.includes('192.168.1.77') && !env.includes('v=0') && !env.includes('offer'),
    'the sealed envelope carries no plaintext of the address it is about',
    `envelope begins ${env.slice(0, 28)}…, and contains no IP, no 'v=0' and no 'offer'`,
    'a public broker sees ciphertext; it is not secret from somebody who has the code');
  const t1 = await topicFor('ABCDE');
  const t2 = await topicFor('abcde');
  const t3 = await topicFor('ABCDF');
  record('seal-topic-is-a-hash',
    t1 === t2 && t1 !== t3 && t1.startsWith('tc/') && !t1.includes('ABCDE') && t1.length === 19,
    'the broker topic is a hash of the code, case-insensitive, and never the code itself',
    `ABCDE → ${t1}, abcde → ${t2}, ABCDF → ${t3}`);
  // Two envelopes of the same message must differ, or the nonce is not being used.
  const twice = await seal(kA, msg);
  record('seal-nonce-moves', twice !== env,
    'two seals of one message differ, so the nonce is real and a replay is visible',
    `${env.slice(0, 16)}… against ${twice.slice(0, 16)}…`);
  record('seal-brokers-listed',
    PUBLIC_BROKERS.length === 3 && PUBLIC_BROKERS.every((u) => u.startsWith('wss://'))
    && new Set(PUBLIC_BROKERS.map((u) => new URL(u).host)).size === 3
    && CODE_ALPHABET.length === 32,
    'three independent brokers over wss, so one disappearing costs nothing',
    PUBLIC_BROKERS.map((u) => new URL(u).host).join(', '));
}

// ---------------------------------------------------------------------------
// Browsers. Two, and both `channel: 'chrome'`; see the file docstring.
// ---------------------------------------------------------------------------

/**
 * Which arms need a browser, and `broker` is deliberately not one of them.
 *
 * Getting this list wrong is silent and expensive: `--only=broker` took two browser slots it had
 * no use for, printed its verdict, and then sat in the queue for the length of the machine's
 * patience. The rule is that an arm belongs here if and only if it opens a page.
 */
const NEEDS_BROWSER = ['battle', 'lag', 'desync', 'leave', 'lobby', 'https', 'nodirect', 'ab',
  'brokerplay'];
const anyBrowser = NEEDS_BROWSER.some((a) => wanted(a));

let chrome = null;
let chromeGuest = null;
let vite = null;
let base = '';
let sigRelay = null;

/**
 * `--disable-features=WebRtcHideLocalIpsWithMdns`, and it is a harness flag rather than a fix.
 *
 * Chromium replaces a host candidate's address with a random `*.local` mDNS name by default,
 * which is a real and good privacy behaviour: a page learns that a peer exists without learning
 * its address. Nothing in this environment resolves those names, so two Playwright browsers on
 * one machine never complete a connectivity check over host candidates — measured 0 of 4.
 *
 * A player's operating system resolves mDNS perfectly well, and a player's peer is on another
 * machine or across the internet on a server-reflexive candidate. So this makes the *harness*
 * able to see what a player already gets, and it changes nothing about the product: no flag is
 * shipped, and `PeerLink` never looks at a candidate's address.
 */
const CHROME_ARGS = ['--disable-features=WebRtcHideLocalIpsWithMdns'];

/**
 * The `https` arm's origin, declared **public** to the browser — on the run's own two browsers.
 *
 * `--ip-address-space-overrides` is a launch argument, so this has to be decided before any arm
 * runs. The first version launched a third and fourth browser for the arm rather than put the
 * flag on these two, on the reasoning that applying it here would "silently change what the other
 * arms measure". **That reasoning was wrong and it cost the arm a run.** The override names *one
 * host and one port* — this arm's TLS front end, which nothing else touches — and every other arm
 * in this file is on `127.0.0.1`, so there is nothing for it to change. What four browsers did
 * change was the load: two extra Chromes booting two extra 3,000-man battles took the arm past
 * its five-minute readiness budget on a machine at load 12, and the failure presented as a
 * transport timeout rather than as a queue.
 *
 * Empty when there is no LAN address, in which case the arm bails out with a named check anyway.
 */
const PUBLIC_ORIGIN_ARGS = lanAddress().ip
  ? [`--ip-address-space-overrides=${lanAddress().ip}:${HTTPS_PORT}=public`]
  : [];

if (anyBrowser) {
  if (SHOT_DIR) await mkdir(SHOT_DIR, { recursive: true });
  try {
    chrome = await launchBrowser({
      label: 'qa-p2p/host', port: PORT, root: ROOT, channel: CHANNEL,
      args: [...CHROME_ARGS, ...PUBLIC_ORIGIN_ARGS],
    });
    cleanups.push(() => { void chrome.close(); });
    chromeGuest = await launchBrowser({
      label: 'qa-p2p/guest', root: ROOT, channel: CHANNEL,
      args: [...CHROME_ARGS, ...PUBLIC_ORIGIN_ARGS],
    });
    cleanups.push(() => { void chromeGuest.close(); });
  } catch (e) {
    /*
     * A missing browser is a bail-out with a name, and it is one red check rather than silence.
     *
     * `channel: 'chrome'` needs Google Chrome installed, which is not a Playwright download. The
     * temptation is to fall back to the bundled Chromium; the measurement says not to, because
     * the bundled headless shell fails to connect 15 times in 17 on this machine and the arms
     * would then report a *transport* failure for a *browser* one. Say which it is.
     */
    record('p2p-browser-can-run', false,
      'the arms below need a browser that can hold a peer connection',
      `channel '${CHANNEL}' would not launch: ${e.message}`,
      "Playwright's own headless Chromium connects 2 times in 17 here; pass "
      + '--channel=chromium for new-headless mode, or install Google Chrome');
  }
}

if (chrome && chromeGuest) {
  vite = await startVite({ port: PORT, root: ROOT, label: 'qa-p2p' });
  cleanups.push(() => { void vite.close(); });
  base = vite.base;
  sigRelay = await startRelay(SIG_RELAY);
  console.log(`\nserving ${base}; introductions through ${sigRelay.base}`);
}

const SIG = () => sigRelay.base;

// ---------------------------------------------------------------------------
// Arm: a real battle, on all three grounds
// ---------------------------------------------------------------------------

if (wanted('battle') && chrome) {
  console.log('\n=== battle: two browsers, one direct connection, three battles ===');
  const rows = [];
  for (const spec of BATTLES) {
    const [map, scenario] = spec.split('/');
    const tag = `${map}-${scenario}`;
    console.log(`\n  -- ${spec} --`);
    const m = await bootPeers(chrome, chromeGuest, base, {
      sig: SIG(), map, scenario, shots: SHOT_DIR ? tag : null,
    });
    const acts = await playMatch(m.host, m.guest, { shots: SHOT_DIR ? tag : null });
    const settled = await settlePeers(m.host, m.guest);
    const both = await readBoth(m.host, m.guest);
    const ca = await m.host.evaluate(() => window.__checks());
    const cb = await m.guest.evaluate(() => window.__checks());
    const cmp = compareChecks(ca ?? [], cb ?? []);
    const diag = both.a.peer;
    const errs = newErrors([...both.a.errs, ...both.b.errs]);
    rows.push({
      spec, cfg: m.cfg, room: m.room, common: cmp.common, highest: cmp.highest, bad: cmp.bad,
      settled, tick: both.a.tick, guestTick: both.b.tick,
      selected: diag?.selected ?? null, openedMs: diag?.openedMs ?? -1, rttMs: diag?.rttMs ?? null,
      candidateTypes: diag?.candidateTypes ?? [],
      stalls: both.a.net?.stalls ?? -1, behind: both.a.net?.behindTicks ?? -1,
      delayTicks: both.a.net?.delayTicks ?? -1, rtt: both.a.net?.rttMs ?? -1,
      hostActs: acts.host.length, guestActs: acts.guest.length,
      events: both.a.rec?.events?.length ?? 0,
      errs,
    });
    record(`battle-${tag}-bit-identical`,
      cmp.bad === null && cmp.common >= 8 && cmp.highest >= 240,
      `${spec}: the two peers are bit-identical at every checkpoint both reached`,
      `${cmp.common} checkpoints in common, highest tick ${cmp.highest}, `
      + `${cmp.bad ?? 'no layer ever differed (uf64, uctl, pool, alive)'}; `
      + `pool ${both.a.hashes.hash} count ${both.a.hashes.count}`,
      'each client hashed its own state locally; the harness compared the strings');
    record(`battle-${tag}-connected-directly`,
      !!diag?.selected && diag.channel === 'open' && (diag.openedMs ?? 1e9) < 15000,
      `${spec}: the battle ran over a peer connection with nothing in between`,
      `${diag?.selected?.local ?? '?'}→${diag?.selected?.remote ?? '?'} `
      + `at ${diag?.selected?.address ?? '?'}, channel ${diag?.channel}, `
      + `open after ${diag?.openedMs} ms, pair rtt ${diag?.rttMs} ms, `
      + `candidates gathered ${JSON.stringify(diag?.candidateTypes)}`,
      'a host↔host pair means both browsers are on one network, which is what one machine can '
      + 'measure; the internet case is the srflx pair and is inferred, not measured here');
    const logsMatch = logDiff(both.a.rec?.events ?? [], both.b.rec?.events ?? []);
    record(`battle-${tag}-one-order-log`,
      logsMatch === null && (both.a.rec?.events?.length ?? 0) > 0,
      `${spec}: both peers recorded the identical order log, event for event`,
      logsMatch ?? `${both.a.rec?.events?.length} events, byte-identical on both sides `
        + `(${acts.host.length} host gestures, ${acts.guest.length} guest gestures)`);
    if (spec === BATTLES[0]) {
      record('battle-config-crossed-the-wire',
        m.cfg?.map === map && m.cfg?.scenario === scenario,
        'the challenger built the host\'s battle without ever seeing a menu',
        `asked for ${spec}; the challenger's own record says ${m.cfg?.map}/${m.cfg?.scenario}`);
      record('battle-console-clean', errs.length === 0,
        'neither page logged an error the base build does not already log',
        errs.length ? errs.join(' | ')
          : `no new errors; ${KNOWN_CONSOLE.length} known 404(s) filtered, attributed to a `
            + 'single-player boot by tools/scratch/console404.mjs',
        'the filter is by exact text, so any other error is still fatal');
      record('battle-no-fast-forward',
        (both.a.net?.behindTicks ?? 99) <= 9 && (both.b.net?.behindTicks ?? 99) <= 9,
        'the ceiling never runs far enough ahead for the catch-up lever to engage',
        `host ${both.a.net?.behindTicks} ticks behind its ceiling, guest `
        + `${both.b.net?.behindTicks}; the 2x step is at 7 and the 8x step at 13`,
        'a commit is earned by consuming a turn, so the ceiling is structurally bounded');
    }
    for (const p of [m.host, m.guest]) await p.close();
  }
  measured.battle = rows;
  const settledRows = rows.filter((r) => r.settled.settled).length;
  console.log(`\n  settled at a common tick in ${settledRows} of ${rows.length} battles `
    + `(reported, not asserted): ${rows.map((r) => `${r.spec} ${r.settled.tick}`
      + `${r.settled.settled ? '' : ` apart ${r.settled.apart}`}`).join('; ')}`);
}

// ---------------------------------------------------------------------------
// Arm: latency on the real data channel
// ---------------------------------------------------------------------------

if (wanted('lag') && chrome) {
  console.log('\n=== lag: real orders over a real channel at 0 and 60 ms one way ===');
  const rows = [];
  for (const owd of [0, 60]) {
    const m = await bootPeers(chrome, chromeGuest, base, {
      sig: SIG(), extra: owd ? `&p2plag=${owd}` : '', guestExtra: owd ? `&p2plag=${owd}` : '',
    });
    await deployWith(m.host, `lag${owd}-host`);
    await deployWith(m.guest, `lag${owd}-guest`);
    let fired = 0;
    for (let i = 0; i < 5; i++) {
      fired += (await burst(m.host, i)).length ? 1 : 0;
      fired += (await burst(m.guest, i + 2)).length ? 1 : 0;
      await sleep(500);
    }
    await sleep(4000);
    const both = await readBoth(m.host, m.guest);
    const ca = await m.host.evaluate(() => window.__checks());
    const cb = await m.guest.evaluate(() => window.__checks());
    const cmp = compareChecks(ca ?? [], cb ?? []);
    const lat = both.a.net?.lat ?? [];
    const worstDelay = lat.reduce((x, y) => Math.max(x, y.delayTicks), 0);
    const meanRtt = lat.length ? lat.reduce((x, y) => x + y.rttMs, 0) / lat.length : -1;
    rows.push({
      owd, samples: lat.length, worstDelay, meanRtt: Math.round(meanRtt),
      stalls: both.a.net?.stalls, stalledMs: both.a.net?.stalledMs,
      events: both.a.rec?.events?.length ?? 0, common: cmp.common, bad: cmp.bad,
      logDiff: logDiff(both.a.rec?.events ?? [], both.b.rec?.events ?? []),
    });
    for (const p of [m.host, m.guest]) await p.close();
  }
  measured.lag = rows;
  const ok = rows.every((r) => r.bad === null && r.logDiff === null && r.samples >= 2
    && r.worstDelay <= 12 && r.events > 0);
  record('lag-nothing-dropped', ok,
    'every order survives a real channel at both latencies, in one order on both peers',
    rows.map((r) => `${r.owd} ms one way: ${r.events} orders, ${r.samples} round trips measured, `
      + `worst input delay ${r.worstDelay} ticks, mean rtt ${r.meanRtt} ms, `
      + `${r.common} checkpoints agreed${r.bad ? ` — ${r.bad}` : ''}`
      + `${r.logDiff ? ` — ${r.logDiff}` : ''}`).join('; '),
    '?p2plag= holds each outbound frame on the real data channel; ordering is preserved');
  /*
   * The claim is that latency is *paid in latency*, so the check has to be able to see the
   * latency arriving — and the discriminator is the **difference between the rows**, not an
   * absolute figure.
   *
   * Two versions were wrong. `worstDelay[60] >= worstDelay[0]` is true when the knob does nothing
   * at all (4 >= 4), so an ignored `sendDelayMs` would have left it green. An absolute floor of
   * 90 ms does no work either: at *zero* added latency the measured order round trip is already
   * about 200 ms, because the input delay is two turns by design (`DEFAULT_DELAY_TURNS`) and that
   * is what `rttMs` measures.
   *
   * What `?p2plag=60` actually adds to a round trip is **one** wire crossing — the peer's commit,
   * which is the frame this client is waiting for; its own commit is filed locally and is not
   * delayed. So expect about +60 ms, and 30 is half of that with room for a turn boundary. The
   * `delay-ignored` fault is what proves this can fail.
   */
  const added = rows[1].meanRtt - rows[0].meanRtt;
  record('lag-costs-latency-not-orders',
    added >= 30 && rows[0].meanRtt >= 50 && rows.every((r) => r.events > 0),
    'and the cost of latency is measurable delay, never a lost command',
    `measured order round trip ${rows[0].meanRtt} ms at 0 ms one way against `
    + `${rows[1].meanRtt} ms at 60 ms — ${added} ms added, against the one wire crossing of `
    + 'about 60 ms the knob puts in the path; '
    + `worst input delay ${rows[0].worstDelay} against ${rows[1].worstDelay} ticks; `
    + `stalled ${rows[0].stalledMs} ms and ${rows[1].stalledMs} ms`,
    'the 200 ms at zero latency is the two turns of input delay the design schedules, so an '
    + 'absolute floor would not discriminate — the difference between the rows is the claim');
}

// ---------------------------------------------------------------------------
// Arm: a fork, injected on purpose, caught and attributed
// ---------------------------------------------------------------------------

if (wanted('desync') && chrome) {
  console.log('\n=== desync: a fork injected at the source, caught and attributed ===');
  const rows = [];
  /*
   * `ulp` and a **local** `drop`, not `swap`.
   *
   * `swap` published is symmetric and forks nothing (see `proto-fault-swap`), so it was testing
   * the detector against a battle that never diverged. `ulp` is local-only by construction and
   * is the failure real hardware produces; a local `drop` is the sharper one — this peer's own
   * simulation runs one of its own orders short while its opponent runs the published stream —
   * and it is the shape a real bug in the commit path would take.
   */
  for (const kind of ['ulp', 'drop']) {
    /*
     * `hostExtra`, so the corruption is on **one** peer. See `bootPeers`.
     *
     * Both peers carrying `--p2pfault=ulp` move the same float64 field of the same unit by the
     * same one unit in the last place, and the two battles stay identical — a fault that fires
     * and proves nothing, which is the exact shape this repository keeps writing down.
     */
    const m = await bootPeers(chrome, chromeGuest, base, {
      sig: SIG(),
      hostExtra: `&p2pfault=${kind}&p2pfault-from=12`
        + `${kind === 'ulp' ? '' : '&p2pfault-local=1'}`,
    });
    await deployWith(m.host, `desync-${kind}-host`);
    await deployWith(m.guest, `desync-${kind}-guest`);
    let caught = null;
    for (let i = 0; i < 8 && !caught; i++) {
      // Several orders in one turn, so a `drop` has something of this peer's own to drop.
      if (kind === 'drop') await doubleOrder(m.host, i);
      else await burst(m.host, i);
      await sleep(900);
      caught = await m.host.evaluate(() => {
        const n = window.__net();
        return n?.desync || n?.ended ? n : null;
      });
    }
    for (let i = 0; i < 60 && !caught?.desync; i++) {
      await sleep(500);
      caught = await m.host.evaluate(() => {
        const n = window.__net();
        return n?.desync || n?.ended ? n : null;
      });
    }
    const guest = await m.guest.evaluate(() => window.__net());
    const diag = await m.host.evaluate(() => window.__peer());
    rows.push({
      kind, fired: diag?.peerRoom?.faultsFired ?? -1,
      desync: caught?.desync ?? null, ended: caught?.ended ?? '',
      guestDesync: guest?.desync ?? null, guestEnded: guest?.ended ?? '',
      perturbed: caught?.perturbed ?? -1,
    });
    const d = caught?.desync;
    record(`desync-${kind}-caught`,
      !!d && d.tick > 0 && ['uf64', 'uctl', 'pool', 'alive'].includes(d.layer),
      `--p2pfault=${kind}: the two battles part company and the session says so`,
      d ? `forked at tick ${d.tick} on ${d.layer}: ${d.mine} against ${d.theirs}; `
        + `last agreed tick ${d.lastAgreedTick}`
        : `not detected after ${rows.at(-1).fired} fault(s) fired; ended '${caught?.ended ?? ''}'`,
      kind === 'ulp' ? 'one UnitGroupState float64 field moved by one unit in the last place, '
        + 'which is the magnitude a libm disagreement actually has (§1.4)'
        : "one of this peer's own orders missing from its own simulation and present in its "
          + 'opponent\'s, which is what a bug in the commit path would look like');
    record(`desync-${kind}-attributed`,
      !!d && Array.isArray(d.units) && d.note && !d.note.includes('deadline'),
      `--p2pfault=${kind}: the fork is attributed to named regiments, not merely to a tick`,
      d ? `${d.units.length} unit(s): ${JSON.stringify(d.units.slice(0, 8))} — ${d.note}`
        : 'no attribution');
    record(`desync-${kind}-ends-both`,
      caught?.ended === 'desync' && guest?.ended === 'desync',
      `--p2pfault=${kind}: both peers end the match by name rather than drifting`,
      `host ended '${caught?.ended ?? ''}' at tick ${caught?.endedAtTick ?? '?'}, `
      + `guest ended '${guest?.ended ?? ''}'; both reached the same verdict with no coordinator`);
    for (const p of [m.host, m.guest]) await p.close();
  }
  measured.desync = rows;
}

// ---------------------------------------------------------------------------
// Arm: one player walks away, and the other is told by name
// ---------------------------------------------------------------------------

if (wanted('leave') && chrome) {
  console.log('\n=== leave: a peer disappears mid-battle ===');
  /*
   * The third guarantee's other half. A desync ends the match by name; so must a peer who closes
   * their tab, and the *reason* has to be the right one — `peerLeft` and not `linkLost`, because
   * they are accusations about different parties. Under a relay the relay sees both sockets and
   * says which; between two peers the survivor has only its own channel to go on, and the two
   * are told apart by whether the far end said goodbye before it went.
   *
   * A real close, with `page.close()`, rather than a protocol message: `NetSession.dispose` sends
   * `bye` on the way out and the data channel closes behind it, which is what shutting a tab
   * actually does.
   */
  const m = await bootPeers(chrome, chromeGuest, base, {
    sig: SIG(), deploy: false, autoplay: 1, extra: '&menu=0&quality=medium',
  });
  await m.host.waitForFunction(
    () => window.__net()?.phase === 'battle', null, { timeout: 120000 });
  await sleep(6000);
  const beforeTick = await m.host.evaluate(() => window.__tick());
  await m.guest.close();
  let ended = null;
  const t0 = Date.now();
  for (let i = 0; i < 40 && !ended; i++) {
    await sleep(500);
    ended = await m.host.evaluate(() => {
      const n = window.__net();
      return n?.ended ? n : null;
    }).catch(() => null);
  }
  const took = Math.round(Date.now() - t0);
  await sleep(1200);
  const sheet = await m.host.evaluate(() => {
    const el = document.querySelector('.tc-over-sheet');
    return el ? (el.innerText ?? '').replace(/\s+/g, ' ').trim() : '';
  }).catch(() => '');
  const afterTick = await m.host.evaluate(() => window.__tick()).catch(() => -1);
  measured.leave = { beforeTick, afterTick, took, ended, sheet: sheet.slice(0, 300) };
  record('leave-ends-by-name',
    !!ended && ended.ended === 'peerLeft' && took < 12000,
    'a peer that closes its tab ends the match as peerLeft, not as a link failure',
    ended ? `'${ended.ended}' after ${took} ms: ${String(ended.message).slice(0, 150)}`
      : `nothing after ${took} ms, which is the hang this check exists to forbid`,
    'peerLeft and linkLost are accusations about different parties; the survivor tells them '
    + 'apart by whether the far end said goodbye');
  record('leave-halts-at-a-stated-tick',
    !!ended && ended.endedAtTick >= 0 && afterTick > 0 && afterTick - beforeTick < 200,
    'and it halts where it stood rather than playing on alone',
    `tick ${beforeTick} when the peer left, ${afterTick} a second later; the session reports `
    + `its last agreed tick as ${ended?.endedAtTick}`);
  record('leave-puts-a-sheet-up',
    /commander left|connection/i.test(sheet) && sheet.length > 40,
    'and the survivor gets a screen rather than a frozen picture',
    sheet ? sheet.slice(0, 190) : 'no session-over sheet was drawn',
    'the freeze this whole design exists to avoid: animations running, nothing moving, and '
    + 'nothing anywhere saying why');
  await m.host.close();
}

// ---------------------------------------------------------------------------
// Arm: the lobby, typed into by a mouse
// ---------------------------------------------------------------------------

if (wanted('lobby') && chrome) {
  console.log('\n=== lobby: two people, a code, and nothing about transport on the screen ===');
  const lobbyRelay = await startRelay(LOBBY_RELAY);
  const sigQ = encodeURIComponent(lobbyRelay.base);
  const hostPage = await newPage(chrome);
  await hostPage.goto(`${base}/?mp=1&sig=${sigQ}`, { waitUntil: 'domcontentloaded' });
  await hostPage.waitForSelector('#tc-room', { timeout: 20000 });
  const face = await lobbyFace(hostPage);
  record('lobby-opens-without-an-address',
    face.createDisabled === false && face.roomPresent && face.roomReaches
    && face.advPresent && !face.advOpen && !face.relayShown,
    'the form is usable with no address typed and none behind the page',
    `Create ${face.createDisabled ? 'disabled' : 'enabled'}, code field reachable `
    + `${face.roomReaches}, transport behind a closed disclosure ${!face.advOpen}`,
    'peer to peer needs no address, so there is nothing left for the form to refuse');
  /*
   * The panel's rule, both ways round, in one check.
   *
   * §11's finding was that a relay address on the front of this screen is a transport detail at
   * the player's eye level, and the first draft of this pass put a *paragraph* about the
   * transport there instead — on every origin, including the one where the page's own server
   * does the introduction automatically and nothing leaves the network. `qa-net`'s
   * `lan-lobby-says-nothing-about-transport` went red on it, correctly.
   *
   * So the rule is: **speak when a player would want to know, and be silent otherwise.** A third
   * party briefly touching your traffic is worth a sentence whether or not anybody asked; your
   * own machine doing it is not. Asserting one case would have left the other free to drift, so
   * this asserts the rule.
   */
  const brokerPage = await newPage(chrome);
  await brokerPage.goto(`${base}/?mp=1&sig=broker`, { waitUntil: 'domcontentloaded' });
  await brokerPage.waitForSelector('#tc-room', { timeout: 20000 });
  const brokerFace = await lobbyFace(brokerPage);
  await brokerPage.close();
  record('lobby-says-how-you-are-introduced',
    !face.blockedShown
    && brokerFace.blockedShown
    && /introduction services/i.test(brokerFace.blockedText)
    && /straight between the two browsers/i.test(brokerFace.blockedText)
    && !/cannot be played|can never|no relay behind this page/i.test(brokerFace.blockedText),
    'the panel is silent when this machine introduces you and explains when strangers do',
    `with a local service named: ${face.blockedShown ? `SPEAKS — ${face.blockedText.slice(0, 90)}`
      : 'silent'}; with the public services: `
    + `${brokerFace.blockedShown ? brokerFace.blockedText.slice(0, 170) : 'SILENT'}`,
    'this element used to hold "there is no relay behind this page, so a battle cannot start '
    + 'from it"');
  await openAdvanced(hostPage);
  const adv = await lobbyFace(hostPage);
  record('lobby-relay-still-reachable',
    adv.relayShown && adv.relayReaches && adv.viaRelayPresent && adv.viaRelayChecked === false
    && adv.relayValue === lobbyRelay.base,
    'the relay is one disclosure click away, holding what the link named, and off by default',
    `field reachable ${adv.relayReaches} holding '${adv.relayValue}', `
    + `"send every order through the relay" present ${adv.viaRelayPresent} `
    + `and unticked ${adv.viaRelayChecked === false}`,
    'demoting a capability is not the same as deleting it');

  // Create a room with the mouse and read the code off the screen.
  await hostPage.click('#tc-host');
  await hostPage.waitForSelector('#tc-code', { timeout: 20000 });
  const code = (await hostPage.textContent('#tc-code')).trim();
  /*
   * The invite *link* is deliberately withheld on a loopback origin, so the check is on the code
   * and on the account of why there is no link — not on the link's presence.
   *
   * `NetLobby.opened` withholds it whenever the page this run serves is at `127.0.0.1`: a link
   * built from that address, sent to somebody else, opens *their* machine and finds nothing. The
   * first version of this check asserted `#tc-invite` exists and went red on the product being
   * right, which is the shape of false red this file's header is about. The link's own presence
   * is measured where it exists — the `https` arm, on a LAN origin.
   */
  const linkFace = await hostPage.evaluate(() => ({
    invite: document.querySelector('#tc-invite')?.textContent?.trim() ?? '',
    hint: (document.querySelector('#tc-link-hint')?.innerText ?? '').replace(/\s+/g, ' ').trim(),
    how: (document.querySelector('#tc-how')?.innerText ?? '').replace(/\s+/g, ' ').trim(),
    qr: !!document.querySelector('#tc-qr svg'),
  }));
  const withheld = linkFace.invite === ''
    && /no invite link/i.test(linkFace.hint) && /127\.0\.0\.1|localhost/.test(linkFace.hint);
  record('lobby-mints-a-code-with-no-round-trip',
    /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{5}$/.test(code)
    && (linkFace.invite.includes(`room=${code}`) || withheld),
    'Create opens a room instantly, with no server asked and nothing to claim',
    `code ${code}; ${linkFace.invite
      ? `invite ${linkFace.invite}`
      : `no invite link, and it says why: ${linkFace.hint.slice(0, 150)}`}`,
    'peer to peer there is nothing to claim: a code is a rendezvous name, not a reservation');
  record('lobby-says-how-this-one-connects',
    /introduce/i.test(linkFace.how) && /nothing leaves your network/i.test(linkFace.how),
    'and the open-room screen says how this room will connect, in the terms that matter',
    linkFace.how.slice(0, 180),
    'the address is deliberately not named when it is this page\'s own server: the player is '
    + 'deciding whether the link works off this network, not reading a hostname');

  // The guest types the code into their own lobby while the host chooses the battle.
  const guestPage = await newPage(chromeGuest);
  await guestPage.goto(`${base}/?mp=1&sig=${sigQ}`, { waitUntil: 'domcontentloaded' });
  await guestPage.waitForSelector('#tc-room', { timeout: 20000 });
  await guestPage.click('#tc-room');
  await guestPage.keyboard.type(code, { delay: 60 });
  /*
   * CHOOSE THE BATTLE navigates the host to its own `?room=…&host=1&menu=battle` URL, which opens
   * on the setup sheet — so the menu still has to be driven. `driveMenu` rather than
   * `bootThroughMenu` for the reason that function's own docstring gives: the whole point of this
   * arm is that the *page* decides where to go, and a driver that called `page.goto` with a URL
   * it had built itself would be testing the driver.
   */
  await hostPage.click('#tc-begin');
  await driveMenu(hostPage, { map: 'campus-martius', scenario: 'field', tier: 'high', size: 'small' });
  await guestPage.click('#tc-join');
  let joined = false;
  try {
    await guestPage.waitForFunction(() => window.__game?.ready === true, null, { timeout: 300000 });
    for (const p of [hostPage, guestPage]) await p.evaluate(INSTALL);
    for (const p of [hostPage, guestPage]) {
      await p.waitForFunction(
        () => ['deploy', 'battle'].includes(window.__net()?.phase), null, { timeout: 120000 });
    }
    joined = true;
  } catch (e) {
    measured.lobbyFailure = e.message;
  }
  const hn = await hostPage.evaluate(() => window.__net?.() ?? null).catch(() => null);
  const gn = await guestPage.evaluate(() => window.__net?.() ?? null).catch(() => null);
  const hd = await hostPage.evaluate(() => window.__peer?.() ?? null).catch(() => null);
  record('lobby-two-people-and-a-code',
    joined && hn?.slot === 0 && gn?.slot === 1 && hn?.room === code && gn?.room === code
    && hn?.myFaction !== gn?.myFaction && !!hd?.selected,
    'one person clicks Create and reads out five characters; the other types them and is in',
    joined ? `room ${code}: host is slot ${hn?.slot} commanding faction ${hn?.myFaction}, `
      + `challenger is slot ${gn?.slot} commanding ${gn?.myFaction}; connected `
      + `${hd?.selected?.local}\u2192${hd?.selected?.remote} at ${hd?.selected?.address} `
      + `after ${hd?.openedMs} ms`
      : `they did not reach a battle: ${measured.lobbyFailure ?? 'unknown'}`,
    'no address typed by either of them, and nothing in the URL but a code');
  measured.lobby = { code, link: linkFace, host: hn, guest: gn, diag: hd };
  for (const p of [hostPage, guestPage]) await p.close();
  lobbyRelay.stop();
}

// ---------------------------------------------------------------------------
// Arm: the deployed site. The whole point of the pass.
// ---------------------------------------------------------------------------

if (wanted('https') && chrome) {
  console.log('\n=== https: an https origin the browser believes is public ===');
  secure: {
    const lan = lanAddress();
    if (!lan.ip) {
      record('https-arm-can-run', false,
        'the arm needs a LAN address to put a certificate on',
        'no non-loopback IPv4 interface');
      break secure;
    }
    mkdirSync(CERT_DIR, { recursive: true });
    try {
      execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
        '-keyout', `${CERT_DIR}/key.pem`, '-out', `${CERT_DIR}/cert.pem`, '-days', '2',
        '-subj', `/CN=${lan.ip}`, '-addext', `subjectAltName=IP:${lan.ip}`], { stdio: 'ignore' });
    } catch (e) {
      record('https-arm-can-run', false, 'the arm needs a self-signed certificate',
        `openssl failed: ${e.message}`);
      break secure;
    }
    /*
     * **The built bundle, served statically over TLS. Not a proxy in front of the dev server.**
     *
     * The first version reverse-proxied this run's vite, and it cost the arm two runs. Vite's
     * client opens an HMR WebSocket back to the page's own origin, my `upgrade` handler
     * forwarded *every* upgrade to the relay, and the relay refused `/?token=…` — so the page
     * sat behind a socket that never completed and the two errors the harness eventually
     * reported were both about HMR. Routing only `/signal/` to the relay fixes that, and the
     * better answer is not to have a dev server in the fixture at all.
     *
     * This is what the deployed site *is*: a static tree over TLS with no server in it. So the
     * arm builds `dist/` and serves it, which removes the proxy, the HMR socket and the whole
     * class of "a chunk 502'd" failure, and makes the fixture a closer likeness of the thing it
     * is standing in for. The build is run here rather than assumed, because a stale `dist/`
     * would have this arm measure code that is not on the branch.
     */
    /*
     * In-process, through the `vite` package, and not by spawning a CLI.
     *
     * There is no `node_modules/vite/bin` in a worktree — the install is hoisted to the main
     * checkout and only the *package* resolves from here, so `node …/vite/bin/vite.js build`
     * exits with a module-not-found and the arm reports "vite build failed" about a path rather
     * than about the build. `tools/lib/vite-runner.mjs` had already learned this for the dev
     * server and says why at length: no `npx`, no shell, and the process the caller holds is the
     * process doing the work.
     */
    const built = await (async () => {
      try {
        const { build } = await import('vite');
        await build({ root: ROOT, logLevel: 'error' });
        return '';
      } catch (e) {
        return e?.message ?? String(e);
      }
    })();
    if (built) {
      record('https-arm-can-run', false, 'the arm serves the built bundle over TLS',
        `vite build failed: ${built.slice(0, 200)}`);
      break secure;
    }
    const relay = await startRelay(HTTPS_RELAY);
    const DIST = path.join(ROOT, 'dist');
    const TYPES = {
      '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8', '.json': 'application/json',
      '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml',
      '.glb': 'model/gltf-binary', '.hdr': 'image/vnd.radiance', '.ktx2': 'image/ktx2',
      '.bin': 'application/octet-stream', '.woff2': 'font/woff2', '.mp3': 'audio/mpeg',
      '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.exr': 'image/x-exr',
    };
    const bad = [];
    const front = createHttpsServer({
      key: await readFile(`${CERT_DIR}/key.pem`),
      cert: await readFile(`${CERT_DIR}/cert.pem`),
    }, (req, res) => {
      const url = new URL(req.url, 'https://x');
      // Anything that is not a file is `index.html`, which is what a static host does and what
      // `?mp=1` and `?room=` need.
      let rel = decodeURIComponent(url.pathname);
      if (rel.endsWith('/')) rel += 'index.html';
      // No traversal out of `dist/`: this listens on 0.0.0.0 for the length of one arm.
      const file = path.normalize(path.join(DIST, rel));
      if (!file.startsWith(DIST)) { res.writeHead(403); res.end('no'); return; }
      void readFile(file)
        .then((body) => {
          res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
          res.end(body);
        })
        .catch(() => {
          if (path.extname(file)) {
            bad.push(`404 ${rel}`);
            res.writeHead(404);
            res.end('not found');
            return;
          }
          void readFile(path.join(DIST, 'index.html')).then((body) => {
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
            res.end(body);
          }).catch(() => { res.writeHead(500); res.end('no index'); });
        });
    });
    /*
     * **Only `/signal/` is tunnelled**, and the restriction is the fix.
     *
     * Forwarding every upgrade sent Vite's HMR socket to a relay that had no route for it, and a
     * socket that neither opens nor closes is worse than one that fails. Nothing else on this
     * origin has any business upgrading, so everything else is refused in one line.
     */
    front.on('upgrade', (req, sock, head) => {
      if (!/^\/signal\//.test(new URL(req.url, 'https://x').pathname)) {
        sock.write('HTTP/1.1 404 Not Found\r\nconnection: close\r\n\r\n');
        sock.destroy();
        return;
      }
      const up = httpRequest({ host: '127.0.0.1', port: HTTPS_RELAY, path: req.url,
        headers: req.headers });
      up.on('upgrade', (r, upSock, upHead) => {
        sock.write(`HTTP/1.1 101 Switching Protocols\r\n${
          Object.entries(r.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`);
        if (upHead?.length) sock.write(upHead);
        upSock.pipe(sock);
        sock.pipe(upSock);
      });
      up.on('error', () => sock.destroy());
      if (head?.length) up.write(head);
      up.end();
    });
    try {
      await new Promise((ok, no) => { front.on('error', no); front.listen(HTTPS_PORT, '0.0.0.0', ok); });
    } catch (e) {
      record('https-arm-can-run', false, `the arm needs port ${HTTPS_PORT}`, e.message);
      relay.stop();
      break secure;
    }
    cleanups.push(() => front.close());
    const origin = `https://${lan.ip}:${HTTPS_PORT}`;
    const sig = `wss://${lan.ip}:${HTTPS_PORT}`;
    console.log(`  origin ${origin}, declared PUBLIC to the browser, introduced by ${sig}`);
    /*
     * The run's own two browsers, which already carry the override. See `PUBLIC_ORIGIN_ARGS`.
     *
     * The flag has to be applied at launch, so if it is not on these two it cannot be on any —
     * and it names one host and one port that no other arm touches, so putting it here costs
     * nothing. Two extra browsers did cost something: the arm ran out of its readiness budget.
     */
    if (!PUBLIC_ORIGIN_ARGS.length) {
      record('https-arm-can-run', false,
        'the arm needs its origin declared public at browser launch',
        'no LAN address was available when the browsers were launched');
      relay.stop();
      break secure;
    }
    const pubHost = chrome;
    const pubGuest = chromeGuest;
    try {
      // 1. The lobby, from a page the browser believes came from the internet.
      const lp = await newPage(pubHost, { ignoreHTTPSErrors: true });
      await lp.goto(`${origin}/?mp=1`, { waitUntil: 'domcontentloaded' });
      await lp.waitForSelector('#tc-room', { timeout: 20000 }).catch(() => {});
      const face = await lobbyFace(lp);
      record('https-lobby-offers-a-room',
        face.origin === origin && face.roomPresent && face.roomReaches
        && face.createDisabled === false
        && !/cannot be played from this page|not be played/i.test(face.text),
        'a public https page offers a room code, a Create and a Join — and used to offer nothing',
        `origin ${face.origin}; code field reachable ${face.roomReaches}, `
        + `Create ${face.createDisabled ? 'disabled' : 'enabled'}; `
        + `the sheet no longer says the battle cannot be played from here`,
        'this screen had no controls on it at all until 2 Sep 2026 (§12.6)');
      await lp.close();

      // 2. And a `ws://` into the private network is still refused, which is why it is not used.
      const probe = await newPage(pubHost, { ignoreHTTPSErrors: true });
      const seen = [];
      probe.on('console', (m) => seen.push(m.text()));
      await probe.goto(`${origin}/?mp=1`, { waitUntil: 'domcontentloaded' });
      const wsResult = await probe.evaluate(async (u) => {
        try {
          const s = new WebSocket(u);
          return await new Promise((r) => {
            s.onopen = () => { s.close(); r('opened'); };
            s.onerror = () => r('error');
            s.onclose = () => r('closed');
            setTimeout(() => r('timeout'), 6000);
          });
        } catch (e) { return `threw ${e.name}`; }
      }, `ws://${lan.ip}:${HTTPS_RELAY}/room/HTTPS?want=host&v=1`);
      record('https-plain-socket-still-refused',
        wsResult !== 'opened' && seen.some((t) => /LOCAL_NETWORK_ACCESS|Mixed Content/i.test(t)),
        'the rule that made a relay impossible from here is still in force, unchanged',
        `ws:// from the public origin: ${wsResult}; `
        + `${seen.filter((t) => /LOCAL_NETWORK_ACCESS|Mixed Content/i.test(t))[0] ?? '(no reason logged)'}`,
        'this is the control: the peer connection below succeeds where this fails, so the '
        + 'difference is the transport and not the fixture');
      await probe.close();

      // 3. The whole point: two strangers, an https page, and a battle.
      const room = nextRoom();
      const q = `room=${room}&sig=${encodeURIComponent(sig)}&autoplay=1&deploy=0&quality=medium`;
      const h = await newPage(pubHost, { ignoreHTTPSErrors: true });
      const g = await newPage(pubGuest, { ignoreHTTPSErrors: true });
      await h.goto(`${origin}/?${q}&host=1&menu=0`, { waitUntil: 'domcontentloaded' });
      await sleep(1200);
      await g.goto(`${origin}/?${q}&host=0&menu=0`, { waitUntil: 'domcontentloaded' });
      let played = false;
      let why = '';
      try {
        for (const p of [h, g]) {
          await p.waitForFunction(() => window.__game?.ready === true, null, { timeout: 300000 });
          await p.evaluate(INSTALL);
        }
        for (const p of [h, g]) {
          await p.waitForFunction(() => window.__net()?.phase === 'battle', null, { timeout: 120000 });
        }
        await sleep(14000);
        played = true;
      } catch (e) {
        /*
         * A timeout here says which `waitForFunction` gave up and nothing else, which is not
         * enough to act on: "the page never booted" and "the peers never connected" are different
         * failures with different fixes, and the first run of this arm could not tell them apart.
         * So both pages are asked what they think happened, and it goes in the record.
         */
        why = e.message;
        const ask = async (p, tag) => {
          const g2 = await p.evaluate(() => !!window.__game?.ready).catch(() => 'unreadable');
          const load = await p.evaluate(
            () => document.querySelector('#load-text')?.textContent ?? '').catch(() => '');
          const n = await p.evaluate(() => window.__net?.() ?? null).catch(() => null);
          return `${tag}: ready=${g2} loading="${String(load).slice(0, 70)}" `
            + `phase=${n?.phase ?? '-'} errs=[${newErrors(p.__errs).slice(0, 2).join(' | ')}]`;
        };
        why += ` — ${await ask(h, 'host')}; ${await ask(g, 'guest')}`;
      }
      const ca = await h.evaluate(() => window.__checks()).catch(() => null);
      const cb = await g.evaluate(() => window.__checks()).catch(() => null);
      const cmp = compareChecks(ca ?? [], cb ?? []);
      const diag = await h.evaluate(() => window.__peer()).catch(() => null);
      measured.https = { origin, sig, room, cmp, diag, played, why, missing: bad.slice(0, 10) };
      record('https-peers-connect-and-play',
        played && cmp.bad === null && cmp.common >= 4 && !!diag?.selected,
        'two pages the browser believes came from the internet connect directly and play',
        played
          ? `${diag?.selected?.local}→${diag?.selected?.remote} at ${diag?.selected?.address}, `
            + `open after ${diag?.openedMs} ms, rtt ${diag?.rttMs} ms; `
            + `${cmp.common} checkpoints agreed to tick ${cmp.highest}, `
            + `${cmp.bad ?? 'no layer ever differed'}`
          : `they never reached a battle: ${why}`
            + `${bad.length ? `; ${bad.length} file(s) the static host did not have: ${bad.slice(0, 4).join(', ')}` : ''}`,
        'blocked by neither mixed content nor Local Network Access — the two rules that make '
        + 'the deployed site unable to reach a relay');
      for (const p of [h, g]) await p.close();
    } finally {
      // The browsers are the run's; only what this arm started is closed.
      front.close();
      relay.stop();
    }
  }
}

// ---------------------------------------------------------------------------
// Arm: the honest limit — two networks that will not connect
// ---------------------------------------------------------------------------

if (wanted('nodirect') && chrome) {
  console.log('\n=== nodirect: when a direct path is refused, say so and stop ===');
  /*
   * **Three rows, and only two of them are assertions.**
   *
   * The first draft used `?p2pcand=srflx` — throw away host candidates and leave only the
   * hairpin out to the public address and back, which most home routers refuse. That is a
   * faithful likeness of two peers behind one NAT, and it is the wrong *basis for a check*:
   * whether it fails is a fact about this router. A check whose red depends on somebody's
   * network equipment is a check that will go green somewhere else and be believed.
   *
   * So the two assertions use `?p2pcand=relay`, which offers **no candidates at all** — there
   * is no TURN, so there are no relay candidates to offer — and therefore cannot connect on any
   * network. That is also the honest likeness of the failure that matters most: a network that
   * blocks UDP outbound produces exactly this, no usable candidate and no path, and §13.6 says
   * it is 100% fatal rather than a percentage.
   *
   * The two rows differ in whether STUN answered, because `noDirectPath` says two different
   * things and both have to be right. With STUN, this machine *did* learn its own public address,
   * so the block is the path between the two — the symmetric-NAT sentence. With `?p2pstun=0` it
   * never learned it, which on a real network means something local is eating UDP — and that one
   * is fixable by the person reading the message, which is why the two are not merged.
   *
   * The third row is a **measurement and not a check**: does this network hairpin? It is the
   * number the report needs for "two peers behind the same NAT", and it is reported without an
   * assertion because the answer is the router's and not the product's.
   */
  const notice = async (tag, extraQ, ms = 90000) => {
    const room = nextRoom();
    const q = `room=${room}&sig=${encodeURIComponent(SIG())}&deploy=0&autoplay=1`
      + `&quality=medium&menu=0${extraQ}`;
    const h = await newPage(chrome);
    const g = await newPage(chromeGuest);
    await h.goto(`${base}/?${q}&host=1`, { waitUntil: 'domcontentloaded' });
    await sleep(900);
    await g.goto(`${base}/?${q}&host=0`, { waitUntil: 'domcontentloaded' });
    const t0 = Date.now();
    let seen = null;
    let connected = false;
    while (Date.now() - t0 < ms && !seen && !connected) {
      await sleep(1000);
      const state = await g.evaluate(() => {
        const sheet = document.querySelector('.tc-sheet');
        return {
          ready: window.__game?.ready === true,
          h1: document.querySelector('h1')?.textContent ?? '',
          txt: (sheet?.innerText ?? '').replace(/\s+/g, ' ').trim(),
        };
      }).catch(() => null);
      if (!state) continue;
      if (state.ready) { connected = true; break; }
      if (state.txt && state.h1) seen = state;
    }
    const took = Math.round((Date.now() - t0) / 1000);
    for (const p of [h, g]) await p.close();
    return { tag, took, connected, notice: seen };
  };

  const blocked = await notice('no-candidates-with-stun', '&p2pcand=relay');
  const blindfold = await notice('no-candidates-no-stun', '&p2pcand=relay&p2pstun=0');
  const hairpin = await notice('srflx-only', '&p2pcand=srflx');
  measured.nodirect = { blocked, blindfold, hairpin };

  record('nodirect-says-so-and-stops',
    !!blocked.notice && !blocked.connected && blocked.took < 80
    && /network|connect|direct/i.test(blocked.notice.txt),
    'two networks that refuse a direct path produce a sentence and a stop, never a hang',
    blocked.notice
      ? `after ${blocked.took} s: "${blocked.notice.h1}" — ${blocked.notice.txt.slice(0, 230)}`
      : `nothing on screen after ${blocked.took} s`
        + `${blocked.connected ? ', and it connected — the fixture did not block anything' : ''}`,
    'no candidates are offered at all, which is what a UDP-blocking network produces and is the '
    + 'one case §13.6 says is 100% fatal rather than a percentage');
  record('nodirect-names-the-right-cause',
    !!blocked.notice && !!blindfold.notice
    && /path between them/i.test(blocked.notice.txt)
    && /address-discovery|blocking/i.test(blindfold.notice.txt)
    && /same wifi|home internet/i.test(blocked.notice.txt),
    'and it distinguishes a block on this side from a block on the path, and names what to try',
    blocked.notice && blindfold.notice
      ? `with STUN answering: "${blocked.notice.txt.slice(-190)}"; with STUN off: `
        + `"${blindfold.notice.txt.slice(0, 190)}"`
      : `with STUN ${blocked.notice ? 'got' : 'no'} notice, without ${blindfold.notice ? 'got' : 'no'} notice`,
    'the first is fixable by the person reading it and the second usually is not, which is the '
    + 'difference between an instruction and an apology');
  console.log(`\n  measurement, not a check — does this network hairpin? `
    + `srflx-only ${hairpin.connected ? 'CONNECTED' : 'refused'} after ${hairpin.took} s. `
    + 'That is the shape of two peers behind one NAT, and the answer is the router\'s.');
}

// ---------------------------------------------------------------------------
// Arm: A/B against the relay, which is the control
// ---------------------------------------------------------------------------

if (wanted('ab') && chrome) {
  console.log('\n=== ab: the same battle over the relay and over a peer connection ===');
  const abRelay = await startRelay(AB_RELAY);
  const room = nextRoom();
  const q = `net=${encodeURIComponent(abRelay.base)}&room=${room}&autoplay=1&deploy=0`
    + '&quality=medium';
  const h = await newPage(chrome);
  const g = await newPage(chromeGuest);
  await h.goto(`${base}/?${q}&menu=0`, { waitUntil: 'domcontentloaded' });
  await g.goto(`${base}/?${q}&host=0&menu=0`, { waitUntil: 'domcontentloaded' });
  let relayCmp = null;
  let relayDiag = null;
  try {
    for (const p of [h, g]) {
      await p.waitForFunction(() => window.__game?.ready === true, null, { timeout: 300000 });
      await p.evaluate(INSTALL);
    }
    for (const p of [h, g]) {
      await p.waitForFunction(() => window.__net()?.phase === 'battle', null, { timeout: 120000 });
    }
    await sleep(18000);
    relayCmp = compareChecks(await h.evaluate(() => window.__checks()) ?? [],
      await g.evaluate(() => window.__checks()) ?? []);
    relayDiag = await h.evaluate(() => window.__peer());
  } catch (e) { measured.abRelayFailure = e.message; }
  const relayChecks = await h.evaluate(() => window.__checks()).catch(() => []);
  for (const p of [h, g]) await p.close();
  abRelay.stop();

  const room2 = nextRoom();
  const q2 = `room=${room2}&sig=${encodeURIComponent(SIG())}&autoplay=1&deploy=0&quality=medium`;
  const h2 = await newPage(chrome);
  const g2 = await newPage(chromeGuest);
  await h2.goto(`${base}/?${q2}&host=1&menu=0`, { waitUntil: 'domcontentloaded' });
  await sleep(900);
  await g2.goto(`${base}/?${q2}&host=0&menu=0`, { waitUntil: 'domcontentloaded' });
  let peerCmp = null;
  let peerChecks = [];
  try {
    for (const p of [h2, g2]) {
      await p.waitForFunction(() => window.__game?.ready === true, null, { timeout: 300000 });
      await p.evaluate(INSTALL);
    }
    for (const p of [h2, g2]) {
      await p.waitForFunction(() => window.__net()?.phase === 'battle', null, { timeout: 120000 });
    }
    await sleep(18000);
    peerChecks = await h2.evaluate(() => window.__checks()) ?? [];
    peerCmp = compareChecks(peerChecks, await g2.evaluate(() => window.__checks()) ?? []);
  } catch (e) { measured.abPeerFailure = e.message; }
  for (const p of [h2, g2]) await p.close();

  /*
   * The A/B, and what it can and cannot claim.
   *
   * Two identical battles — same map, same scenario, same tier, `autoplay=1` so no player input
   * enters either — run over the two transports. Every checkpoint at a shared tick must match
   * *across* the transports, not merely within each. That is the strongest available statement
   * that the transport is not in the simulation: the same seed produces the same battle whether
   * the orders came through a relay process or straight down a data channel.
   *
   * It cannot claim anything about a battle *with* input, because two runs with real mouse
   * gestures are two different battles by construction. The three `battle` arms cover that case
   * within a transport; this covers determinism across them.
   */
  const cross = compareChecks(relayChecks ?? [], peerChecks ?? []);
  measured.ab = { relay: relayCmp, peer: peerCmp, cross, relayDiag: relayDiag?.selected ?? null };
  record('ab-both-transports-agree-internally',
    relayCmp?.bad === null && peerCmp?.bad === null
    && (relayCmp?.common ?? 0) >= 8 && (peerCmp?.common ?? 0) >= 8,
    'the same battle holds together over the relay and over a peer connection',
    `relay: ${relayCmp?.common} checkpoints to tick ${relayCmp?.highest}, `
    + `${relayCmp?.bad ?? 'all agreed'}; peer: ${peerCmp?.common} to ${peerCmp?.highest}, `
    + `${peerCmp?.bad ?? 'all agreed'}`);
  record('ab-transport-is-not-in-the-simulation',
    cross.bad === null && cross.common >= 8,
    'and the two transports produce the identical battle, checkpoint for checkpoint',
    `${cross.common} checkpoints shared between the relay run and the peer run, to tick `
    + `${cross.highest}; ${cross.bad ?? 'no layer ever differed'}`,
    'same map, same tier, autoplay so no input enters either run');
}

// ---------------------------------------------------------------------------
// Arm: the public brokers, for real. Opt-in.
// ---------------------------------------------------------------------------

/*
 * `broker` runs its first half with **no browser at all**, which is why it is above the
 * browser gate rather than below it.
 *
 * `src/net/signal.ts` needs a `WebSocket` that takes a subprotocol, `crypto.subtle`, `btoa` and
 * `atob`, and Node 24 has all four — so the vendored MQTT client, the topic hash and the sealed
 * envelope can be exercised against the *real* public brokers in about four seconds. That is
 * most of what the broker path actually is: two peers finding each other. What a browser adds on
 * top is the `RTCPeerConnection`, and that is measured by every other arm in this file.
 *
 * Opt-in either way (`--only=broker` or `--all`), for the reason `xengine` is: it uses somebody
 * else's free service, and a gate that goes red because a public test broker is busy is the thing
 * §12.8 warns about.
 */
if (wanted('broker')) {
  console.log('\n=== broker: the real public introduction services ===');
  const { MqttSignal, PUBLIC_BROKERS: BROKERS } = await import('../src/net/signal.ts');
  const code = `Q${Math.random().toString(36).slice(2, 6).toUpperCase().replace(/[IOL01]/g, 'X')}`;
  const sa = new MqttSignal(code, 0, BROKERS);
  const sb = new MqttSignal(code, 1, BROKERS);
  const heard = { host: [], guest: [] };
  sa.onMessage = (m) => heard.host.push(m);
  sb.onMessage = (m) => heard.guest.push(m);
  const t0 = Date.now();
  let openErr = '';
  try {
    await Promise.all([sa.open(10000), sb.open(10000)]);
  } catch (e) { openErr = e.message; }
  const openMs = Date.now() - t0;
  if (!openErr) {
    sb.send({ t: 'knock', from: 1 });
    await sleep(1200);
    sa.send({ t: 'offer', from: 0, sdp: 'v=0\r\no=- 1 1 IN IP4 192.168.1.77\r\n' });
    await sleep(1200);
    sb.send({ t: 'answer', from: 1, sdp: 'v=0\r\nanswer\r\n' });
    await sleep(1200);
  }
  const gotKnock = heard.host.some((m) => m.t === 'knock');
  const gotOffer = heard.guest.some((m) => m.t === 'offer' && m.sdp.includes('192.168.1.77'));
  const gotAnswer = heard.host.some((m) => m.t === 'answer');
  const noEcho = !heard.host.some((m) => m.from === 0) && !heard.guest.some((m) => m.from === 1);
  measured.brokerSignal = {
    code, openMs, live: [sa.live, sb.live], of: BROKERS.length,
    foreign: [sa.foreign, sb.foreign], heard, openErr,
  };
  record('broker-carries-an-introduction',
    !openErr && gotKnock && gotOffer && gotAnswer && noEcho,
    'a knock, an offer and an answer cross the real public brokers, sealed, with no account',
    openErr
      ? `could not open: ${openErr}`
      : `${sa.live} and ${sb.live} of ${BROKERS.length} brokers answered, first in ${openMs} ms; `
        + `knock ${gotKnock}, offer ${gotOffer}, answer ${gotAnswer}, no self-echo ${noEcho}; `
        + `${sa.foreign + sb.foreign} envelope(s) arrived that would not open`,
    'the topic is a hash and the payload is AES-GCM under the room code, so an operator sees '
    + 'neither');
  sa.close();
  sb.close();
}

if (wanted('broker') && chrome) {
  const room = nextRoom();
  const q = `room=${room}&sig=broker&deploy=0&autoplay=1&menu=0&quality=medium`;
  const h = await newPage(chrome);
  const g = await newPage(chromeGuest);
  const t0 = Date.now();
  await h.goto(`${base}/?${q}&host=1`, { waitUntil: 'domcontentloaded' });
  await sleep(2500);
  await g.goto(`${base}/?${q}&host=0`, { waitUntil: 'domcontentloaded' });
  let ok = false;
  let why = '';
  try {
    for (const p of [h, g]) {
      await p.waitForFunction(() => window.__game?.ready === true, null, { timeout: 300000 });
      await p.evaluate(INSTALL);
    }
    for (const p of [h, g]) {
      await p.waitForFunction(() => window.__net()?.phase === 'battle', null, { timeout: 120000 });
    }
    ok = true;
  } catch (e) { why = e.message; }
  const diag = await h.evaluate(() => window.__peer()).catch(() => null);
  measured.broker = { room, took: Math.round((Date.now() - t0) / 1000), diag, ok, why };
  record('broker-introduces-two-strangers',
    ok && !!diag?.selected,
    'two browsers find each other through the free public message services and connect',
    ok ? `room ${room} over ${diag?.signal}; connected ${diag?.selected?.local}→`
      + `${diag?.selected?.remote} after ${diag?.openedMs} ms, rtt ${diag?.rttMs} ms`
      : `they did not: ${why}`,
    'no account, nothing deployed, nothing to keep alive — and the game itself never touches '
    + 'them');
  for (const p of [h, g]) await p.close();
}

// ---------------------------------------------------------------------------

cleanup();
if (results.length === 0) {
  console.log('\n✗ no checks ran — nothing was measured');
  failed = 1;
}
console.log(`\n${failed === 0 ? '✓' : '✗'} ${results.length - failed}/${results.length} checks passed`);
if (JSON_OUT) {
  await writeFile(path.resolve(ROOT, JSON_OUT), JSON.stringify({ results, measured }, null, 2));
}
process.exit(failed === 0 ? 0 : 1);
