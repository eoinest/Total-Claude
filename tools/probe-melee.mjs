#!/usr/bin/env node
/**
 * Probe: melee contact, chokepoint behaviour, gait and unit cohesion.
 *
 * Four player reports, four measurements. Every one of them is a number the sim can be
 * held to, because none of them can be seen in a screenshot:
 *
 *   reach       Two opposed units in contact. Blows landed per second, kills per minute,
 *               men in `Fighting` versus men who *could* reach an enemy under the sim's
 *               own acquisition rule, and the distance the two front ranks settle at.
 *               This is the "they stand there and do not fight" report.
 *
 *   gate        A cohort ordered through the Porta Flaminia carriageway. Lateral drift
 *               per fighting man per second, unit heading change per second, and how many
 *               men end up on the wrong side of a wall they cannot fit through.
 *
 *   run         Measured ground speed of a unit ordered to move, with and without the
 *               run flag, against `walkSpeed` and `runSpeed` from the roster — plus
 *               whether a synthetic `R` keypress reaches the sim at all.
 *
 *   stragglers  After a gate transit, how many men are more than N metres from their
 *               unit's body, and whether they rejoin within a further minute.
 *
 * Usage:
 *   node tools/probe-melee.mjs --port=5571 [--case=reach|gate|run|stragglers|all] [--json=path]
 *
 * The port matters. With no dev server listening, vite is started here; but a probe
 * pointed at a *stale* port silently reads whatever is being served there, which has
 * already produced one false regression report in this project. The first line of output
 * says which server answered and whether this process started it.
 */

import { chromium } from 'playwright';
import { writeFile, readFile } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { spawnVite } from './lib/devtree.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const args = new Map(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
  })
);
const PORT = Number(args.get('port') ?? 5571);
const CASE = args.get('case') ?? 'all';
const JSON_OUT = args.get('json') ?? null;
const VERBOSE = args.has('verbose');

const waitForServer = async (url, ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (r.ok || r.status === 304) return true;
    } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
};

const base = `http://127.0.0.1:${PORT}`;
let server = null;
const preexisting = await waitForServer(base, 1200);
if (!preexisting) {
  server = spawnVite(['--port', String(PORT), '--host', '127.0.0.1', '--strictPort'], {
    cwd: ROOT, stdio: 'ignore', env: { ...process.env, TC_NO_HMR: '1' },
  });
  if (!(await waitForServer(base, 60000))) { console.error('vite did not start'); process.exit(1); }
}
/*
 * Which tree answered?
 *
 * "A live dev server is on the port" is not the same question. This harness attaches to any
 * pre-existing listener, several agents run vite on this machine at once, and two checkouts
 * of the same repo serve byte-identical URLs — so a run can silently measure a tree nobody
 * intended. The fingerprint below is the answer: the served module is compared against the
 * local file this script was launched from, on marker identifiers that survive vite's dev
 * transform, and the git revision and dirty state of that same tree are printed. A run
 * whose fingerprint does not match is worth nothing and says so.
 */
let live = false;
let served = '';
try {
  const r = await fetch(`${base}/src/sim/BattleSystem.ts`, { signal: AbortSignal.timeout(4000) });
  live = r.ok;
  served = await r.text();
} catch { /* leave false */ }
const MARKERS = ['ENGAGE_REACH', 'closeToContact', 'MAX_SEPARATION_FIGHTING', 'rallyPoint'];
let localSrc = '';
try { localSrc = await readFile(path.join(ROOT, 'src/sim/BattleSystem.ts'), 'utf8'); } catch { /* */ }
const disagree = MARKERS.filter((m) => served.includes(m) !== localSrc.includes(m));
let rev = '?';
let dirty = '?';
try {
  rev = execSync('git rev-parse --short HEAD', { cwd: ROOT }).toString().trim();
  const st = execSync('git status --porcelain src/sim', { cwd: ROOT }).toString().trim();
  dirty = st ? st.split('\n').length + ' file(s) modified' : 'clean';
} catch { /* not a git tree */ }
console.log(
  `# probe-melee — server ${base} (${preexisting ? 'pre-existing' : 'started here'})\n` +
  `#   tree ${ROOT}\n` +
  `#   git ${rev}, src/sim ${dirty}\n` +
  `#   live source: ${live ? 'YES' : 'NO — SERVING STALE BUILD, RESULTS ARE MEANINGLESS'}` +
  `   fingerprint: ${live && disagree.length === 0 ? 'MATCHES this tree'
    : 'MISMATCH on [' + disagree.join(', ') + '] — THE SERVER IS SERVING A DIFFERENT TREE'}`
);
if (!live || disagree.length) process.exitCode = 2;

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});

const newPage = async (query) => {
  const page = await browser.newPage({ viewport: { width: 480, height: 270 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.setDefaultTimeout(240000);
  await page.goto(`${base}/?harness=1&quality=high&autoplay=1&w=480&h=270${query}`,
    { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__game?.ready === true, undefined, { timeout: 240000 });
  // Run the helper source through `new Function` rather than evaluating it directly:
  // `page.evaluate` serialises the value of the last expression back over the pipe, and
  // the helper bundle's value holds the live `BattleSystem`. Playwright dies trying to
  // stringify it ("Cannot create a string longer than 0x1fffffe8 characters").
  await page.evaluate((src) => { new Function(src)(); }, HELPERS);
  return { page, errors };
};

// ---------------------------------------------------------------------------
// Shared page-side helpers, injected as a string so each evaluate() has them.
// ---------------------------------------------------------------------------

const HELPERS = `
window.__pm = (() => {
  const g = window.__game;
  const b = g.battle;
  const ctx = g.engine.context;
  const p = b.pool;
  const DEAD = 11, DYING = 10, FIGHTING = 4;
  const alive = (i) => p.state[i] !== DEAD && p.state[i] !== DYING;

  /**
   * Stop a *rendering* fault in somebody else's in-flight edit from killing a
   * *simulation* measurement.
   *
   * Four agents share this tree, and \`engine.advance\` runs the full frame including
   * \`update\`/\`preRender\`. A half-saved renderer throws there and takes the whole probe
   * down with it, which says nothing at all about the sim. \`fixedUpdate\` is deliberately
   * left unwrapped — that is the thing under test and it must be allowed to fail loudly.
   * The count is reported, so this can never quietly hide a fault.
   */
  const shielded = { n: 0, where: new Set() };
  const shieldRender = () => {
    for (const s of (g.engine.systems || g.engine.subsystems || [])) {
      for (const hook of ['update', 'preRender', 'resize']) {
        const fn = s[hook];
        if (typeof fn !== 'function') continue;
        const bound = fn.bind(s);
        s[hook] = (...a) => {
          try { return bound(...a); }
          catch (e) { shielded.n++; shielded.where.add(s.name + '.' + hook + ': ' + e.message); }
        };
      }
    }
  };

  /** Silence everything that would re-order the units out from under a measurement. */
  const muteDirectors = () => {
    for (const name of ['tactical-ai', 'general-ai', 'battleFlow', 'autoEngage']) {
      const s = ctx.tryGet(name);
      if (s && s.fixedUpdate) s.fixedUpdate = () => {};
    }
    shieldRender();
  };
  const shieldReport = () => ({ n: shielded.n, where: [...shielded.where].slice(0, 3) });

  /** Kill every unit on the field so two fresh ones can be measured in isolation. */
  const teardown = async (live) => {
    for (const u of b.units) {
      if (u.destroyed) continue;
      for (const i of u.members) if (alive(i)) p.setState(i, DEAD);
      u.alive = 0;
      u.destroyed = true;
    }
    const shared = await import('/src/sim/combatShared.ts');
    shared.resetCombatShared();
    const mor = ctx.tryGet('morale');
    if (mor && mor.redeploy) mor.redeploy();
    // In live mode the AI and the battle-flow arbiter keep running, which is what the
    // real game does for every faction the player does not control.
    if (live) shieldRender(); else muteDirectors();
    return shared;
  };

  /**
   * Men of \`ua\` who have a living enemy inside their own weapon's acquisition radius.
   *
   * Deliberately a brute-force O(n*m) restatement of the rule \`Combat.acquireVisit\`
   * applies — same radius, same vertical gate, same liveness test — and *not* a call into
   * the sim. A probe that asks the system under test whether it is working can only ever
   * agree with it; this asks the geometry directly and compares.
   */
  const couldReach = (ua, ub, radius, dyGate) => {
    let n = 0;
    const r2 = radius * radius;
    for (const i of ua.members) {
      if (!alive(i)) continue;
      for (const j of ub.members) {
        if (!alive(j)) continue;
        if (Math.abs(p.y[j] - p.y[i]) > dyGate) continue;
        const dx = p.x[j] - p.x[i], dz = p.z[j] - p.z[i];
        if (dx * dx + dz * dz <= r2) { n++; break; }
      }
    }
    return n;
  };

  /** Distance from every living man of \`ua\` to his nearest living enemy in \`ub\`. */
  const nearestGaps = (ua, ub) => {
    const out = [];
    for (const i of ua.members) {
      if (!alive(i)) continue;
      let best = Infinity;
      for (const j of ub.members) {
        if (!alive(j)) continue;
        const dx = p.x[j] - p.x[i], dz = p.z[j] - p.z[i];
        const d2 = dx * dx + dz * dz;
        if (d2 < best) best = d2;
      }
      if (best < Infinity) out.push(Math.sqrt(best));
    }
    out.sort((x, y) => x - y);
    return out;
  };

  const pct = (sorted, q) => sorted.length
    ? Math.round(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] * 100) / 100
    : -1;

  const countState = (u, st) => {
    let n = 0;
    for (const i of u.members) if (p.state[i] === st) n++;
    return n;
  };

  const countTargets = (u) => {
    let n = 0;
    for (const i of u.members) if (p.target[i] >= 0 && alive(i)) n++;
    return n;
  };

  /** Median-ish centre of a unit's living men, and how far the outliers are from it. */
  const body = (u) => {
    const xs = [], zs = [];
    for (const i of u.members) if (alive(i)) { xs.push(p.x[i]); zs.push(p.z[i]); }
    if (!xs.length) return null;
    xs.sort((a, c) => a - c); zs.sort((a, c) => a - c);
    const cx = xs[xs.length >> 1], cz = zs[zs.length >> 1];
    const d = [];
    for (const i of u.members) if (alive(i)) d.push(Math.hypot(p.x[i] - cx, p.z[i] - cz));
    d.sort((a, c) => a - c);
    return { cx, cz, d, n: d.length };
  };

  /**
   * Count damage applications, split into melee and everything else by how far the
   * blow came from. \`b.damage\` is the single documented way a man loses hp, so wrapping
   * it counts blows that landed without depending on the event budget — \`meleeHit\` is
   * throttled to 22 non-lethal events a tick and would under-report a big melee badly.
   */
  const meterDamage = () => {
    const m = { blows: 0, kills: 0, missile: 0, byUnit: new Map() };
    const orig = b.damage.bind(b);
    b.damage = (i, amount, fx, fz, aid) => {
      const near = Math.hypot(fx - p.x[i], fz - p.z[i]) < 5;
      const lethal = orig(i, amount, fx, fz, aid);
      if (near) {
        m.blows++;
        if (lethal) m.kills++;
        const e = m.byUnit.get(aid) || { blows: 0, kills: 0 };
        e.blows++; if (lethal) e.kills++;
        m.byUnit.set(aid, e);
      } else { m.missile++; }
      return lethal;
    };
    m.restore = () => { b.damage = orig; };
    return m;
  };

  return { g, b, ctx, p, DEAD, DYING, FIGHTING, alive, muteDirectors, teardown, shieldReport,
           couldReach, nearestGaps, pct, countState, countTargets, body, meterDamage };
})();
`;

// ---------------------------------------------------------------------------
// Case: reach — do two units in contact actually fight?
// ---------------------------------------------------------------------------

/**
 * `approach` is the load-bearing variable and the reason this case has four modes.
 *
 * `attack` drives a unit at a named enemy and keeps re-aiming until the fronts touch.
 * `move` is what a player does — a right-click on the ground — and it ends in `Hold` the
 * moment the anchor arrives, wherever that happens to be. `hold` is a unit that is simply
 * standing there when an enemy walks up to it. The player's report is a *move*, so a
 * harness that only ever tests `attack` cannot see what he saw.
 */
const REACH_PAIRS = [
  { id: 'legio-vs-warband/attack', a: 'legio-cohort', b: 'juthungi-warband', fa: 'line', fb: 'horde', approach: 'attack' },
  { id: 'legio-vs-warband/move', a: 'legio-cohort', b: 'juthungi-warband', fa: 'line', fb: 'horde', approach: 'move' },
  { id: 'legio-vs-warband/hold+attack', a: 'legio-cohort', b: 'juthungi-warband', fa: 'line', fb: 'horde', approach: 'holdA' },
  // Nose to nose from the first tick, both on Hold: the sharpest possible statement of
  // "two units are standing in front of each other". Nothing here is allowed to be an
  // approach artefact.
  { id: 'legio-vs-warband/facing-off', a: 'legio-cohort', b: 'juthungi-warband', fa: 'line', fb: 'horde', approach: 'nose' },
  { id: 'legio-vs-chosen/move', a: 'legio-cohort', b: 'juthungi-chosen', fa: 'line', fb: 'line', approach: 'move' },
  { id: 'praetorian-vs-warband/move', a: 'praetorian-cohort', b: 'juthungi-warband', fa: 'line', fb: 'horde', approach: 'move' },
  // Long-reach control: both sides carry spears, so the acquisition radius comfortably
  // spans whatever gap the contact lock leaves. If this pair fights and the short-reach
  // pairs above do not, the fault is the gap and not the damage model.
  { id: 'urban-vs-spears/move', a: 'urban-cohort', b: 'juthungi-spears', fa: 'line', fb: 'line', approach: 'move' },
  { id: 'urban-vs-spears/attack', a: 'urban-cohort', b: 'juthungi-spears', fa: 'line', fb: 'line', approach: 'attack' },
];

const runReach = async (page, spec) => page.evaluate(async (spec) => {
  const P = window.__pm;
  const { b, ctx, p } = P;
  await P.teardown();
  b.unitSizeScale = 1;
  // `nose` starts the two blocks 5 m apart so they are in contact almost immediately;
  // every other mode starts them 90 m apart and lets the approach play out.
  const half = spec.approach === 'nose' ? 2.5 : 45;
  const idA = b.spawnUnit(spec.a, 0, half, Math.PI, spec.fa);
  const idB = b.spawnUnit(spec.b, 0, -half, 0, spec.fb);
  const A = b.unitById(idA), B = b.unitById(idB);
  if (!A || !B) return { error: 'spawn failed' };
  const defA = b.typeOf(A), defB = b.typeOf(B);

  const attack = (u, foe) => ctx.events.emit('orderIssued',
    { unitIds: [u.id], kind: 'attack', targetUnitId: foe.id });
  /** A player's right-click: walk to a point on the ground and stop there. */
  const moveAt = (u, foe) => ctx.events.emit('orderIssued', {
    unitIds: [u.id], kind: 'move',
    // Aim at the midpoint between the two blocks, which is what a player clicking
    // "engage that lot" actually does. Neither unit is told about the other.
    x: (u.x + foe.x) / 2, z: (u.z + foe.z) / 2,
    facing: Math.atan2(foe.x - u.x, foe.z - u.z), running: false,
  });
  const halt = (u) => ctx.events.emit('orderIssued', { unitIds: [u.id], kind: 'halt' });

  if (spec.approach === 'attack') { attack(A, B); attack(B, A); }
  else if (spec.approach === 'move') { moveAt(A, B); moveAt(B, A); }
  else if (spec.approach === 'holdA') { halt(A); attack(B, A); }
  else { halt(A); halt(B); }

  const SAME_LEVEL_DY = 1.9;
  const rA = defA.reach + 0.25, rB = defB.reach + 0.25;

  // Close the distance first; measurement only starts once somebody is locked.
  let contactT = -1;
  for (let t = 0; t < 120 && contactT < 0; t++) {
    P.g.advance(1);
    if (A.contactLock || B.contactLock || P.countState(A, 4) + P.countState(B, 4) > 0) contactT = t;
  }
  if (contactT < 0) {
    // Not making contact is itself a result, and the interesting one. Report the geometry
    // rather than bailing: how far apart did they actually stop, and did either lock?
    const gaps = P.nearestGaps(A, B);
    return {
      pair: spec.id, contactT: -1, neverContacted: true,
      reachA: Math.round(rA * 100) / 100, reachB: Math.round(rB * 100) / 100,
      frontGap: Math.round(Math.min(999, b.frontGapOf(A.id)) * 100) / 100,
      minGap: P.pct(gaps, 0), p10Gap: P.pct(gaps, 0.1), medGap: P.pct(gaps, 0.5),
      lockA: A.contactLock, lockB: B.contactLock, orderA: A.order, orderB: B.order,
      anchorSep: Math.round(Math.hypot(A.x - B.x, A.z - B.z) * 100) / 100,
    };
  }

  // Let the geometry settle for two seconds, then meter for sixty.
  P.g.advance(2);
  const meter = P.meterDamage();
  const t0 = P.g.simTime();
  const aliveA0 = A.alive, aliveB0 = B.alive;
  const samples = [];
  const WINDOW = 60;
  for (let t = 0; t < WINDOW; t++) {
    P.g.advance(1);
    const gapsA = P.nearestGaps(A, B);
    samples.push({
      t,
      fightA: P.countState(A, 4), fightB: P.countState(B, 4),
      tgtA: P.countTargets(A), tgtB: P.countTargets(B),
      reachA: P.couldReach(A, B, rA, SAME_LEVEL_DY),
      reachB: P.couldReach(B, A, rB, SAME_LEVEL_DY),
      aliveA: A.alive, aliveB: B.alive,
      frontGap: Math.round(Math.min(999, b.frontGapOf(A.id)) * 100) / 100,
      minGap: P.pct(gapsA, 0), p10Gap: P.pct(gapsA, 0.1), medGap: P.pct(gapsA, 0.5),
      lockA: A.contactLock, lockB: B.contactLock,
    });
    if (A.alive === 0 || B.alive === 0 || A.order === 5 || B.order === 5) break;
  }
  const elapsed = P.g.simTime() - t0;
  const m = { blows: meter.blows, kills: meter.kills, missile: meter.missile };
  meter.restore();

  const mean = (k) => Math.round(samples.reduce((s, x) => s + x[k], 0) / samples.length * 10) / 10;
  return {
    pair: spec.id, contactT,
    reachA: Math.round(rA * 100) / 100, reachB: Math.round(rB * 100) / 100,
    seconds: Math.round(elapsed * 10) / 10,
    blowsPerSec: Math.round(m.blows / elapsed * 100) / 100,
    killsPerMin: Math.round((aliveA0 - A.alive + aliveB0 - B.alive) / elapsed * 60 * 10) / 10,
    missileHits: m.missile,
    meanFightA: mean('fightA'), meanFightB: mean('fightB'),
    meanReachA: mean('reachA'), meanReachB: mean('reachB'),
    meanTgtA: mean('tgtA'), meanTgtB: mean('tgtB'),
    meanFrontGap: mean('frontGap'), meanMinGap: mean('minGap'),
    meanP10Gap: mean('p10Gap'), meanMedGap: mean('medGap'),
    lostA: aliveA0 - A.alive, lostB: aliveB0 - B.alive, shield: P.shieldReport(),
    initA: aliveA0, initB: aliveB0,
    samples: samples.filter((_, k) => k % 10 === 0),
  };
}, spec);

// ---------------------------------------------------------------------------
// Case: standoff — how close must two idle units be before they fight?
//
// The player's report is two formations standing in front of each other doing nothing.
// This sweeps the initial separation and, for each, reports whether a fight ever starts
// and what the sim believed at the end: the contact lock, the signals blackboard's
// `nearestEnemy`, and — the number that localises the mechanism — how far the front rank
// actually crept forward of its formation slot.
// ---------------------------------------------------------------------------

const runStandoff = async (page, gap, live) => page.evaluate(async ([gap, live]) => {
  const P = window.__pm;
  const { b, ctx, p } = P;
  const shared = await import('/src/sim/combatShared.ts');
  await P.teardown(live);
  b.unitSizeScale = 1;
  const idA = b.spawnUnit('legio-cohort', 0, gap / 2, Math.PI, 'line');
  const idB = b.spawnUnit('juthungi-warband', 0, -gap / 2, 0, 'horde');
  const A = b.unitById(idA), B = b.unitById(idB);
  if (!A || !B) return { gap, error: 'spawn failed' };
  /*
   * The soldier pool is a fixed-capacity high-water-mark allocator and the torn-down
   * siege leaves ~8,900 dead men in it. Spawning several pairs into one page silently
   * ran it dry and handed back units with no members at all — which read as "they never
   * fought" and was pure measurement artefact. One page per gap, and this assertion so
   * the failure can never be silent again.
   */
  if (A.alive < 100 || B.alive < 100) {
    return { gap, error: `pool exhausted: A=${A.alive} B=${B.alive} men` };
  }
  /*
   * Silence the javelins.
   *
   * `meterDamage` separates melee from missile by how far the blow came from, and that
   * classifier cannot work: `Projectiles` reports the impact from the projectile's own
   * previous position, which at 21 m/s and a 33 ms step is 0.7 m from the man it hits. So
   * every missile casualty was being counted as a melee blow — and since volleys are
   * suppressed by contact, the rows where the units *did* engage were reporting melee while
   * the rows where they did not were reporting pila under the same column heading. Both
   * sides carry two throwing weapons; that is the whole of the 77-104 "blows" and the 16-26
   * casualties in the rows that never fought. With the projectile system stopped, every
   * point of damage in this case is a melee blow by construction.
   */
  const proj = ctx.tryGet('projectiles');
  if (proj && proj.fixedUpdate) proj.fixedUpdate = () => {};
  ctx.events.emit('orderIssued', { unitIds: [A.id], kind: 'halt' });
  ctx.events.emit('orderIssued', { unitIds: [B.id], kind: 'halt' });
  P.g.advance(2);
  const startAlive = [A.alive, B.alive];
  const startFront = Math.round(Math.min(999, b.frontGapOf(A.id)) * 100) / 100;
  const startMinMan = P.pct(P.nearestGaps(A, B), 0);
  const meter = P.meterDamage();
  const t0 = P.g.simTime();
  let firstFight = -1;
  let anyRout = false;
  for (let t = 0; t < 60; t++) {
    P.g.advance(1);
    if (firstFight < 0 && P.countState(A, 4) + P.countState(B, 4) > 0) {
      firstFight = Math.round(P.g.simTime() - t0);
    }
    if (A.order === 5 || B.order === 5) anyRout = true;
  }
  const blows = meter.blows;
  meter.restore();

  // How far has the front rank crept forward of where the formation says it should be?
  // The unit frame's +Z is `facing`, and rank 0's slot offset is exactly zero, so for a
  // front-ranker this is simply his displacement from the anchor line along the facing.
  const s = Math.sin(A.facing), c = Math.cos(A.facing);
  let creep = 0, n = 0;
  for (const i of A.members) {
    if (!P.alive(i) || p.rank[i] !== 0) continue;
    creep += (p.x[i] - A.x) * s + (p.z[i] - A.z) * c;
    n++;
  }
  const sigA = shared.signalsOf(A.id);
  const gapsA = P.nearestGaps(A, B);
  const fin = (v) => (v > 1e5 ? -1 : Math.round(v * 100) / 100);
  return {
    gap, startFront, startMinMan,
    fought: firstFight >= 0, firstFight, blows, anyRout,
    aliveA: A.alive, aliveB: B.alive, lostA: startAlive[0] - A.alive, lostB: startAlive[1] - B.alive,
    lockA: A.contactLock, lockB: B.contactLock,
    nearestEnemySignal: fin(sigA.nearestEnemy),
    frontGap: fin(b.frontGapOf(A.id)),
    minManGap: P.pct(gapsA, 0), p10ManGap: P.pct(gapsA, 0.1),
    frontRankCreep: n ? Math.round(creep / n * 1000) / 1000 : -1,
    anchorDrift: Math.round(Math.hypot(A.x - 0, A.z - gap / 2) * 1000) / 1000,
    engagedFraction: Math.round(sigA.engagedFraction * 1000) / 1000,
    shield: P.shieldReport(),
  };
}, [gap, live]);

// ---------------------------------------------------------------------------
// Case: field — how much of a real battle is spent standing around?
//
// The staged standoff proves the mechanism; this proves it matters. The whole siege runs
// untouched, with every AI live, and each second we census the field for *standoff pairs*:
// two opposed formations whose front ranks are within `nearM` of each other and where not
// one man on either side is in melee. In a battle that works that number is near zero.
// ---------------------------------------------------------------------------

const runField = async (page, opts) => page.evaluate(async (opts) => {
  const P = window.__pm;
  const { b, p } = P;
  P.shieldReport();                       // force the shield in without muting the AI
  const shieldOnly = () => {
    for (const s of (P.g.engine.systems || [])) {
      for (const hook of ['update', 'preRender']) {
        const fn = s[hook];
        if (typeof fn !== 'function' || fn.__wrapped) continue;
        const bound = fn.bind(s);
        const w = (...a) => { try { return bound(...a); } catch { /* render only */ } };
        w.__wrapped = true;
        s[hook] = w;
      }
    }
  };
  shieldOnly();

  const fightingIn = (u) => {
    let n = 0;
    for (const i of u.members) if (p.state[i] === 4) n++;
    return n;
  };

  const rows = [];
  for (let t = 0; t < opts.seconds; t++) {
    P.g.advance(1);
    if (t % opts.every) continue;
    let pairs = 0, standoffs = 0, standoffMen = 0, fighting = 0, locked = 0;
    for (const u of b.units) {
      if (u.destroyed || u.alive === 0) continue;
      const fu = fightingIn(u);
      fighting += fu;
      if (u.contactLock) locked++;
      const gap = b.frontGapOf(u.id);
      const eid = b.frontEnemyOf(u.id);
      if (eid < 0 || !(gap < opts.nearM)) continue;
      const e = b.unitById(eid);
      if (!e || e.destroyed || e.alive === 0) continue;
      pairs++;
      if (fu === 0 && fightingIn(e) === 0) { standoffs++; standoffMen += u.alive; }
    }
    rows.push({ t, pairs, standoffs, standoffMen, fighting, locked,
                alive0: b.strength[0], alive1: b.strength[1] });
  }
  const tail = rows.slice(Math.floor(rows.length / 2));
  const avg = (k) => Math.round(tail.reduce((s, x) => s + x[k], 0) / Math.max(1, tail.length) * 10) / 10;
  return {
    rows,
    meanPairs: avg('pairs'), meanStandoffs: avg('standoffs'),
    meanStandoffMen: avg('standoffMen'), meanFighting: avg('fighting'), meanLocked: avg('locked'),
    standoffShare: avg('pairs') > 0 ? Math.round(avg('standoffs') / avg('pairs') * 100) : 0,
  };
}, opts);

// ---------------------------------------------------------------------------
// Case: pull — the player's actual action, in the real siege
//
// "I pulled some soldiers outside of the walls in the siege scenario to attack some of the
// war bands outside, but the units are right in front of each other just standing there
// not fighting." So: run the assault untouched with every AI live, then do exactly that —
// right-click a Roman cohort onto a point a few metres short of a warband's front — and
// count how many seconds it then spends parked in front of an enemy with nobody fighting.
//
// The AI is *not* muted for the German side. That is the point: the player's units are the
// only ones nobody is commanding, which is precisely why the defect is his to see.
// ---------------------------------------------------------------------------

const runPull = async (page, opts) => page.evaluate(async (opts) => {
  const P = window.__pm;
  const { b, ctx, p } = P;
  for (const s of (P.g.engine.systems || [])) {
    for (const hook of ['update', 'preRender']) {
      const fn = s[hook];
      if (typeof fn !== 'function' || fn.__w) continue;
      const bound = fn.bind(s);
      const w = (...a) => { try { return bound(...a); } catch { /* render only */ } };
      w.__w = true;
      s[hook] = w;
    }
  }
  P.g.advance(opts.warmup);

  const fightingIn = (u) => {
    let n = 0;
    for (const i of u.members) if (p.state[i] === 4) n++;
    return n;
  };

  // Pick Roman field units — not the wall garrison, which the siege system owns and which
  // is not what the player dragged out of the gate.
  const mine = b.units.filter((u) => !u.destroyed && u.faction === 0
    && u.alive > 40 && !b.siege.ownsUnit(u.id)).slice(0, opts.units);
  if (!mine.length) return { error: 'no free Roman field units in the assault' };

  const picked = [];
  for (const u of mine) {
    let foe = null, best = 1e9;
    for (const o of b.units) {
      if (o.destroyed || o.faction === u.faction || o.alive === 0) continue;
      const d = Math.hypot(o.x - u.x, o.z - u.z);
      if (d < best) { best = d; foe = o; }
    }
    if (!foe) continue;
    // A right-click a few metres short of the enemy's front — what "go and fight them"
    // looks like when a player aims with a mouse.
    const dx = foe.x - u.x, dz = foe.z - u.z;
    const d = Math.hypot(dx, dz) || 1;
    const gx = foe.x - (dx / d) * opts.standoffM;
    const gz = foe.z - (dz / d) * opts.standoffM;
    ctx.events.emit('orderIssued', {
      unitIds: [u.id], kind: 'move', x: gx, z: gz, facing: Math.atan2(dx, dz), running: true,
    });
    picked.push({ u, foeId: foe.id, startDist: Math.round(best) });
  }

  const meter = P.meterDamage();
  const t0 = P.g.simTime();
  const rows = [];
  const standoffSec = new Map();
  for (let t = 0; t < opts.seconds; t++) {
    P.g.advance(1);
    for (const q of picked) {
      const u = q.u;
      if (u.destroyed || u.alive === 0) continue;
      const gap = b.frontGapOf(u.id);
      const eid = b.frontEnemyOf(u.id);
      const e = eid >= 0 ? b.unitById(eid) : null;
      const fu = fightingIn(u);
      const fe = e ? fightingIn(e) : 0;
      // Parked in front of an enemy with not one man on either side swinging.
      if (gap < opts.nearM && fu === 0 && fe === 0) {
        standoffSec.set(u.id, (standoffSec.get(u.id) || 0) + 1);
      }
      if (t % opts.every === 0) {
        rows.push({ t, id: u.id, alive: u.alive, order: u.order, lock: u.contactLock,
                    gap: Math.round(Math.min(999, gap) * 10) / 10, fu, fe });
      }
    }
  }
  const elapsed = P.g.simTime() - t0;
  const m = { blows: meter.blows, kills: meter.kills };
  meter.restore();
  return {
    units: picked.map((q) => ({
      id: q.u.id, startDist: q.startDist, alive: q.u.alive,
      standoffSec: standoffSec.get(q.u.id) || 0,
      finalGap: Math.round(Math.min(999, b.frontGapOf(q.u.id)) * 10) / 10,
      lock: q.u.contactLock, order: q.u.order,
    })),
    seconds: Math.round(elapsed),
    blows: m.blows, kills: m.kills,
    totalStandoffSec: [...standoffSec.values()].reduce((s, v) => s + v, 0),
    rows,
  };
}, opts);

// ---------------------------------------------------------------------------
// Case: run — is the gait honoured?
// ---------------------------------------------------------------------------

const runGait = async (page) => page.evaluate(async () => {
  const P = window.__pm;
  const { b, ctx } = P;
  await P.teardown();
  b.unitSizeScale = 1;

  /** Mean anchor speed over a straight leg, sampled after the unit is up to speed. */
  const leg = (running) => {
    const id = b.spawnUnit('legio-cohort', running ? 300 : -300, 260, 0, 'line');
    const u = b.unitById(id);
    ctx.events.emit('orderIssued', {
      unitIds: [u.id], kind: 'move', x: u.x, z: u.z - 220, facing: 0, running,
    });
    P.g.advance(4);                       // accelerate and finish the wheel
    const x0 = u.x, z0 = u.z, t0 = P.g.simTime();
    P.g.advance(12);
    const d = Math.hypot(u.x - x0, u.z - z0);
    const dt = P.g.simTime() - t0;
    const out = { speed: Math.round(d / dt * 1000) / 1000, running: u.running, order: u.order,
                  fatigue: Math.round(u.fatigue * 1000) / 1000 };
    for (const i of u.members) P.p.setState(i, 11);
    u.alive = 0; u.destroyed = true;
    return out;
  };

  const walk = leg(false);
  const run = leg(true);

  // Does a real keypress reach the sim? Dispatch on every plausible listener target and
  // see whether any selected unit's `running` flag changes. The UI owns selection, so a
  // unit is selected through the same event the HUD uses.
  const id = b.spawnUnit('legio-cohort', 0, 300, 0, 'line');
  const u = b.unitById(id);
  ctx.events.emit('selectionChanged', { unitIds: [u.id] });
  ctx.events.emit('orderIssued', {
    unitIds: [u.id], kind: 'move', x: u.x, z: u.z - 200, facing: 0, running: false,
  });
  P.g.advance(1);
  const before = u.running;
  let sawEvent = false;
  const ordersSeen = [];
  ctx.events.on('orderIssued', (o) => { sawEvent = true; ordersSeen.push(o.kind + ':' + !!o.running); });
  for (const target of [window, document, document.body, document.querySelector('canvas')]) {
    if (!target) continue;
    for (const type of ['keydown', 'keyup']) {
      target.dispatchEvent(new KeyboardEvent(type, {
        key: type === 'keydown' ? 'r' : 'r', code: 'KeyR', keyCode: 82, which: 82,
        bubbles: true, cancelable: true,
      }));
    }
  }
  P.g.advance(0.5);
  const after = u.running;

  /**
   * The fix, at the sim boundary: change pace *mid-march* with a `gait` order.
   *
   * This is what the R key has to be able to do and currently cannot. Measured on a unit
   * already walking: speed over the four seconds before the order, then over the eight
   * after it. The UI half of the plumbing is reported as a patch; this proves the sim half
   * accepts the order and acts on it without disturbing the destination.
   */
  const gaitId = b.spawnUnit('legio-cohort', 600, 260, 0, 'line');
  const gu = b.unitById(gaitId);
  ctx.events.emit('orderIssued', {
    unitIds: [gu.id], kind: 'move', x: gu.x, z: gu.z - 260, facing: 0, running: false,
  });
  P.g.advance(4);
  const gx0 = gu.x, gz0 = gu.z, gt0 = P.g.simTime();
  P.g.advance(6);
  const beforeSpeed = Math.hypot(gu.x - gx0, gu.z - gz0) / (P.g.simTime() - gt0);
  const destBefore = { x: gu.targetX, z: gu.targetZ };
  ctx.events.emit('orderIssued', { unitIds: [gu.id], kind: 'gait', running: true });
  const midFlag = gu.running;
  P.g.advance(2);
  const gx1 = gu.x, gz1 = gu.z, gt1 = P.g.simTime();
  P.g.advance(6);
  const afterSpeed = Math.hypot(gu.x - gx1, gu.z - gz1) / (P.g.simTime() - gt1);

  const roster = b.typeOf(u);
  return {
    gaitBefore: Math.round(beforeSpeed * 1000) / 1000,
    gaitAfter: Math.round(afterSpeed * 1000) / 1000,
    gaitFlagSet: midFlag,
    gaitKeptDestination:
      Math.abs(destBefore.x - gu.targetX) < 0.01 && Math.abs(destBefore.z - gu.targetZ) < 0.01,
    walkSpeed: roster.walkSpeed, runSpeed: roster.runSpeed, chargeSpeed: roster.chargeSpeed,
    measuredWalk: walk.speed, measuredRun: run.speed,
    walkFlag: walk.running, runFlag: run.running,
    walkFatigue: walk.fatigue, runFatigue: run.fatigue,
    keyBefore: before, keyAfter: after, keyEmittedOrder: sawEvent, ordersSeen,
  };
});

// ---------------------------------------------------------------------------
// Case: gate — the chokepoint
//
// "Soldiers need to do a better job holding their ground, they kind of move around in a
// snake like pattern when fighting ... in the gate way. The weird movement sometimes means
// units can actually squeeze through the choke point."
//
// Three numbers, and the first version of this case measured none of them honestly:
//
//  - **Lateral drift while fighting.** Sideways motion, perpendicular to the man's own
//    unit heading, summed only over ticks he spends in `Fighting`. Forward and backward
//    give-and-take is the shoving match working; sideways is the snake. The first version
//    read a flat zero because the setup had killed every enemy on the map, so not one man
//    was ever in contact — a vacuous pass. There is now a warband contesting the arch.
//  - **Heading change.** Degrees per second of unit yaw. This is the "units start
//    rotating when they collide in that choke point".
//  - **Squeezing through.** Two independent measures, because the obvious one is wrong.
//    Counting men who end up outside and off the centre line counts everybody who
//    legitimately walked out and then spread into line, which is most of them. So:
//    man-ticks spent *inside solid masonry* (asked of the collision field itself, at the
//    man's own position), and crossings of the wall plane recorded at the instant they
//    happen with the lateral offset measured then.
// ---------------------------------------------------------------------------

const runGate = async (page, opts) => page.evaluate(async (opts) => {
  const P = window.__pm;
  const { b, ctx, p } = P;
  P.muteDirectors();
  const city = ctx.tryGet('city');
  const gates = city && city.getGates ? city.getGates() : [];
  if (!gates.length) return { error: 'no gates on this map' };
  const gate = gates[0];
  if (city.setGateOpen) city.setGateOpen(gate.id, true);

  // Gate frame: `fwd` points out of the city, `rt` across the carriageway.
  const fwd = { x: Math.sin(gate.facing), z: Math.cos(gate.facing) };
  const rt = { x: Math.cos(gate.facing), z: -Math.sin(gate.facing) };
  const along = (x, z) => (x - gate.x) * fwd.x + (z - gate.z) * fwd.z;
  const across = (x, z) => (x - gate.x) * rt.x + (z - gate.z) * rt.z;

  // Two Roman field units inside, one warband outside contesting the mouth. Everything
  // else leaves the field so the measurement is of the gate and not of the whole siege.
  const romans = [];
  let foe = null;
  for (const u of b.units) {
    if (u.destroyed) continue;
    if (u.faction === 0 && romans.length < opts.units && !b.siege.ownsUnit(u.id) && u.alive > 40) {
      romans.push(u); continue;
    }
    if (u.faction !== 0 && !foe && u.alive > 40 && !b.siege.ownsUnit(u.id)) { foe = u; continue; }
    for (const i of u.members) if (P.alive(i)) p.setState(i, 11);
    u.alive = 0; u.destroyed = true;
  }
  if (romans.length < 1 || !foe) {
    return { error: `need Romans and a warband, got ${romans.length} and ${foe ? 1 : 0}` };
  }

  const place = (u, alongM, acrossM) => {
    u.x = gate.x + fwd.x * alongM + rt.x * acrossM;
    u.z = gate.z + fwd.z * alongM + rt.z * acrossM;
    for (const i of u.members) {
      p.x[i] = u.x; p.z[i] = u.z; p.vx[i] = 0; p.vz[i] = 0;
      p.y[i] = b.groundAt(u.x, u.z);
    }
  };
  romans.forEach((u, k) => place(u, -34 - k * 16, (k - (romans.length - 1) / 2) * 20));
  place(foe, 26, 0);
  foe.facing = gate.facing + Math.PI;
  foe.targetFacing = foe.facing;
  P.g.advance(3);

  // Romans push out through the arch; the warband pushes in. They meet in the carriageway.
  for (const u of romans) {
    ctx.events.emit('orderIssued', {
      unitIds: [u.id], kind: 'move',
      x: gate.x + fwd.x * 42, z: gate.z + fwd.z * 42, facing: gate.facing, running: false,
    });
  }
  ctx.events.emit('orderIssued', {
    unitIds: [foe.id], kind: 'move',
    x: gate.x - fwd.x * 20, z: gate.z - fwd.z * 20,
    facing: gate.facing + Math.PI, running: false,
  });

  const watched = [...romans, foe];
  const prevX = new Float32Array(p.capacity);
  const prevZ = new Float32Array(p.capacity);
  const prevAlong = new Float32Array(p.capacity).fill(NaN);
  const prevFace = new Map();
  let lateralFight = 0, fightManSec = 0;
  let lateralAll = 0, allManSec = 0;
  let turn = 0, unitSec = 0;
  let insideMasonry = 0, manTicks = 0;
  let offAxisCrossings = 0, crossings = 0;
  const hit = { x: 0, z: 0, hit: false, blockedX: false, blockedZ: false };
  // Clear half-width of the carriageway a body centre may occupy. The arch is cut
  // `gateW` wide and a man is `SOLDIER_RADIUS` across, so anything beyond this is inside
  // the jamb or through it.
  const halfW = opts.gateW / 2 - 0.42;

  let ticks = 0;
  const hook = ctx.tryGet('abilities');
  const orig = hook && hook.fixedUpdate ? hook.fixedUpdate.bind(hook) : null;
  if (hook && orig) {
    hook.fixedUpdate = (dt, c) => {
      orig(dt, c);
      ticks++;
      for (const u of watched) {
        if (u.destroyed) continue;
        const pf = prevFace.get(u.id);
        if (pf !== undefined) {
          let d = u.facing - pf;
          while (d > Math.PI) d -= Math.PI * 2;
          while (d < -Math.PI) d += Math.PI * 2;
          turn += Math.abs(d);
          unitSec += dt;
        }
        prevFace.set(u.id, u.facing);
        const s = Math.sin(u.facing), c2 = Math.cos(u.facing);
        for (const i of u.members) {
          if (!P.alive(i)) continue;
          const a = along(p.x[i], p.z[i]);
          // Only ask about the gate. Counting the whole field conflated "wedged in the
          // arch" with "deployed on top of an insula thirty metres inside the city",
          // which is a property of where the probe parked them and not of the chokepoint:
          // it read 202 per mille that way, almost all of it men standing in buildings.
          if (Math.abs(a) < opts.gateWindow) {
            manTicks++;
            // Is this man standing inside solid stone right now? Asked of the collision
            // field at his own position: `resolve` reports `hit` when the point is solid.
            b.masonry.resolve(p.x[i], p.z[i], p.x[i], p.z[i], p.y[i], 0.42, hit);
            if (hit.hit) insideMasonry++;
          }

          const pa = prevAlong[i];
          if (!Number.isNaN(pa) && pa < 0 && a >= 0) {
            // He crossed the wall plane this tick. Where was he when he did it?
            crossings++;
            if (Math.abs(across(p.x[i], p.z[i])) > halfW) offAxisCrossings++;
          }
          prevAlong[i] = a;

          if (prevX[i] !== 0 || prevZ[i] !== 0) {
            const dx = p.x[i] - prevX[i], dz = p.z[i] - prevZ[i];
            const lat = Math.abs(dx * c2 - dz * s);
            lateralAll += lat; allManSec += dt;
            if (p.state[i] === 4) { lateralFight += lat; fightManSec += dt; }
          }
          prevX[i] = p.x[i]; prevZ[i] = p.z[i];
        }
      }
    };
  }

  const samples = [];
  for (let t = 0; t < opts.seconds; t++) {
    P.g.advance(1);
    if (t % 15 === 0 || t === opts.seconds - 1) {
      samples.push({
        t,
        rows: watched.map((u) => {
          const bd = P.body(u);
          let fighting = 0;
          for (const i of u.members) if (p.state[i] === 4) fighting++;
          return {
            id: u.id, f: u.faction, alive: u.alive, fighting,
            out: u.members.filter((i) => P.alive(i) && along(p.x[i], p.z[i]) > 0).length,
            far: bd ? bd.d.filter((v) => v > opts.strayM).length : 0,
            spread: bd ? Math.round(bd.d[bd.d.length - 1] * 10) / 10 : -1,
          };
        }),
      });
    }
  }
  if (hook && orig) hook.fixedUpdate = orig;

  const bodies = watched.map((u) => P.body(u)).filter(Boolean);
  const stray = bodies.reduce((s, bd) => s + bd.d.filter((v) => v > opts.strayM).length, 0);
  return {
    gate: { id: gate.id, x: Math.round(gate.x), z: Math.round(gate.z) },
    gateW: opts.gateW, halfW: Math.round(halfW * 100) / 100, gateWindow: opts.gateWindow,
    units: watched.length, men: watched.reduce((s, u) => s + u.alive, 0),
    lateralDriftFighting: fightManSec > 0
      ? Math.round(lateralFight / fightManSec * 1000) / 1000 : -1,
    fightManSeconds: Math.round(fightManSec),
    lateralDriftAll: allManSec > 0 ? Math.round(lateralAll / allManSec * 1000) / 1000 : -1,
    headingDegPerSec: unitSec > 0 ? Math.round(turn / unitSec * 180 / Math.PI * 100) / 100 : 0,
    insideMasonryPerMille: manTicks > 0
      ? Math.round(insideMasonry / manTicks * 10000) / 10 : 0,
    insideMasonryManTicks: insideMasonry, manTicks,
    crossings, offAxisCrossings,
    strayMen: stray, strayThreshold: opts.strayM,
    ticks, samples, shield: P.shieldReport(),
  };
}, opts);

// ---------------------------------------------------------------------------
// Case: stragglers — do separated men come back?
// ---------------------------------------------------------------------------

const runStragglers = async (page, opts) => page.evaluate(async (opts) => {
  const P = window.__pm;
  const { b, ctx, p } = P;
  P.muteDirectors();
  // The formation module, so the diagnostic below can recompute a man's slot exactly the
  // way `steerSoldiers` does rather than approximating it.
  window.__FORMS = await import('/src/sim/formations.ts');
  const city = ctx.tryGet('city');
  const gates = city && city.getGates ? city.getGates() : [];
  if (!gates.length) return { error: 'no gates on this map' };
  const gate = gates[0];
  if (city.setGateOpen) city.setGateOpen(gate.id, true);

  const keep = [];
  for (const u of b.units) {
    if (u.destroyed) continue;
    if (u.faction === 0 && keep.length < opts.units && !b.siege.ownsUnit(u.id) && u.alive > 40) {
      keep.push(u); continue;
    }
    for (const i of u.members) if (P.alive(i)) p.setState(i, 11);
    u.alive = 0; u.destroyed = true;
  }
  if (!keep.length) return { error: 'no free Roman units' };

  const fx = Math.sin(gate.facing), fz = Math.cos(gate.facing);
  const outX = gate.x + fx * 70, outZ = gate.z + fz * 70;
  const inX = gate.x - fx * 45, inZ = gate.z - fz * 45;
  keep.forEach((u, k) => {
    const off = (k - (keep.length - 1) / 2) * 26;
    const rx = Math.cos(gate.facing), rz = -Math.sin(gate.facing);
    u.x = inX + rx * off; u.z = inZ + rz * off;
    for (const i of u.members) {
      p.x[i] = u.x; p.z[i] = u.z; p.vx[i] = 0; p.vz[i] = 0; p.y[i] = b.groundAt(u.x, u.z);
    }
  });
  P.g.advance(3);
  keep.forEach((u) => ctx.events.emit('orderIssued', {
    unitIds: [u.id], kind: 'move', x: outX, z: outZ, facing: gate.facing, running: false,
  }));

  const transit = [];
  for (let t = 0; t < opts.transit; t++) {
    P.g.advance(1);
    if (t % 15 === 0) {
      transit.push({ t, rows: keep.map((u) => {
        const bd = P.body(u);
        return { id: u.id, far: bd ? bd.d.filter((v) => v > opts.strayM).length : 0,
                 max: bd ? Math.round(bd.d[bd.d.length - 1]) : -1 };
      }) });
    }
  }
  /*
   * Is the rally machinery even switched on? Reading the sim's own private state rather
   * than inferring it: whether the nav provider bound at all, how long each unit's
   * breadcrumb trail is, and how many men are actually steering to a rally point right
   * now. The first cut of the fix moved the stranded count by nothing at all, and without
   * these three numbers there was no way to tell "the idea is wrong" from "the trail was
   * shorter than the journey" — which is what it turned out to be.
   */
  const nav = ctx.tryGet('pathfinding');
  const diag = {
    navBound: !!b.nav,
    trails: keep.map((u) => (b.trailN ? b.trailN[u.id] : -1)),
    rallying: keep.map((u) => {
      let n = 0;
      if (b.rallyOn) for (const i of u.members) if (P.alive(i) && b.rallyOn[i]) n++;
      return n;
    }),
    // Which half of the rally condition is failing? Re-derive both halves here, from
    // outside the sim, for every man who is far enough from his slot to qualify. Without
    // this split, "one man in fifty-seven is rallying" is a symptom with two possible
    // causes and no way to choose between them.
    split: keep.map((u) => {
      const out = { qualified: 0, lineToSlotClear: 0, noCrumbVisible: 0 };
      if (!nav) return out;
      const s = Math.sin(u.facing), c = Math.cos(u.facing);
      const ranks = Math.max(1, Math.ceil(u.members.length / Math.max(1, u.width)));
      const off = { x: 0, z: 0 };
      const F = window.__FORMS;
      for (const i of u.members) {
        if (!P.alive(i)) continue;
        F.formation(u.formationId).offset(off, p.slot[i], u.width, ranks, u.spacingX, u.spacingZ);
        const tx = u.x + off.x * c + off.z * s;
        const tz = u.z - off.x * s + off.z * c;
        if (Math.hypot(tx - p.x[i], tz - p.z[i]) <= 14) continue;
        out.qualified++;
        if (nav.directRouteClear(p.x[i], p.z[i], tx, tz, 0.42)) { out.lineToSlotClear++; continue; }
        let seen = false;
        const base = u.id * 28;
        for (let k = (b.trailN ? b.trailN[u.id] : 0) - 1; k >= 0 && !seen; k--) {
          if (nav.directRouteClear(p.x[i], p.z[i], b.trailX[base + k], b.trailZ[base + k], 0.42)) seen = true;
        }
        if (!seen) out.noCrumbVisible++;
      }
      return out;
    }),
  };

  const atTransit = keep.map((u) => {
    const bd = P.body(u);
    return { id: u.id, alive: u.alive,
             far: bd ? bd.d.filter((v) => v > opts.strayM).length : 0,
             max: bd ? Math.round(bd.d[bd.d.length - 1]) : -1,
             wrongSide: u.members.filter((i) => P.alive(i)
               && ((p.x[i] - gate.x) * fx + (p.z[i] - gate.z) * fz) < 0).length };
  });
  // Give them a further minute standing still and see whether the strays close up.
  keep.forEach((u) => ctx.events.emit('orderIssued', { unitIds: [u.id], kind: 'halt' }));
  P.g.advance(opts.settle);
  const afterSettle = keep.map((u) => {
    const bd = P.body(u);
    return { id: u.id, alive: u.alive,
             far: bd ? bd.d.filter((v) => v > opts.strayM).length : 0,
             max: bd ? Math.round(bd.d[bd.d.length - 1]) : -1,
             wrongSide: u.members.filter((i) => P.alive(i)
               && ((p.x[i] - gate.x) * fx + (p.z[i] - gate.z) * fz) < 0).length };
  });
  return { gate: gate.id, strayThreshold: opts.strayM, transit, atTransit, afterSettle, diag };
}, opts);

// ---------------------------------------------------------------------------

const out = { port: PORT, live, cases: {} };

const wants = (c) => CASE === 'all' || CASE === c;

if (wants('reach')) {
  console.log('\n## reach — two opposed units in contact\n');
  out.cases.reach = [];
  for (const spec of REACH_PAIRS) {
    const { page, errors } = await newPage('');
    const r = await runReach(page, spec);
    await page.close();
    out.cases.reach.push(r);
    if (r.error) { console.log(`${spec.id}: ERROR ${r.error}`); continue; }
    if (r.neverContacted) {
      console.log(`${spec.id}  (r=${r.reachA} vs r=${r.reachB})`);
      console.log(`  NO CONTACT IN 120 s. front gap ${r.frontGap} m, anchors ${r.anchorSep} m apart, ` +
        `nearest man-to-man min ${r.minGap} p10 ${r.p10Gap} median ${r.medGap} m, ` +
        `lock ${r.lockA ? 'A' : '-'}${r.lockB ? 'B' : '-'}, orders ${r.orderA}/${r.orderB}`);
      console.log('');
      continue;
    }
    const engagedPct = r.meanReachA > 0 ? Math.round(r.meanFightA / r.meanReachA * 100) : 0;
    console.log(`${spec.id}  (${spec.a} r=${r.reachA} vs ${spec.b} r=${r.reachB})`);
    console.log(`  contact t+${r.contactT}s, metered ${r.seconds}s`);
    console.log(`  blows landed/s ${r.blowsPerSec}   kills/min ${r.killsPerMin}   ` +
                `losses A ${r.lostA}/${r.initA} B ${r.lostB}/${r.initB}`);
    console.log(`  A fighting ${r.meanFightA} of ${r.meanReachA} who could reach (${engagedPct}%)   ` +
                `with target ${r.meanTgtA}`);
    console.log(`  B fighting ${r.meanFightB} of ${r.meanReachB} who could reach   with target ${r.meanTgtB}`);
    console.log(`  front-rank gap ${r.meanFrontGap} m   nearest man-to-man: min ${r.meanMinGap} ` +
                `p10 ${r.meanP10Gap} median ${r.meanMedGap} m`);
    if (r.missileHits) console.log(`  (${r.missileHits} non-melee hits excluded)`);
    if (VERBOSE) for (const s of r.samples) console.log(`    ${JSON.stringify(s)}`);
    if (r.shield && r.shield.n) console.log(`  shielded ${r.shield.n} render-path throw(s) from another agent's edit: ${r.shield.where.join(' | ')}`);
    if (errors.length) console.log(`  ${errors.length} console error(s): ${[...new Set(errors)].slice(0, 2).join(' | ')}`);
    console.log('');
  }
}

if (wants('standoff')) {
  console.log('\n## standoff — how close must two idle units be before they fight?\n');
  out.cases.standoff = [];
  /*
   * `anchorGap` is the spawn separation of the two anchors, and it is NOT the distance
   * between the nearest men. The warband fights in `horde`, whose rank-0 slot carries a
   * bulge of up to 1.4*spacingZ plus jitter, so its foremost man stands about 2.0 m in
   * front of its own anchor while the cohort's front rank sits exactly on its own. Read
   * `startMinMan` — the measured nearest man-to-man distance at t=0 — as the real axis;
   * a legionary acquires at reach 1.1 + 0.25 = 1.35 m.
   */
  console.log('  anchorGap startMinMan fought  at  meleeBlows lostA lostB  lock  frontGap minMan creep');
  // The `live` rows leave the AI running for the Germanic side, which is what the real
  // game does. If the AI closes the gap the defect is cosmetic; if it does not, a player
  // unit standing three metres from an enemy genuinely never fights.
  const sweep = (args.get('gaps') ?? '2.5,3,3.5,4,5,7').split(',')
    .map((g) => [Number(g), 0]);
  if (!args.has('gaps')) sweep.push([4, 1], [7, 1]);
  for (const [gap, liveAI] of sweep) {
    const { page, errors } = await newPage('');
    const x = await runStandoff(page, gap, liveAI);
    x.liveAI = !!liveAI;
    await page.close();
    out.cases.standoff.push(x);
    if (x.error) { console.log(`  ${gap}: ERROR ${x.error}`); continue; }
    console.log(
      `  ${String(x.gap).padStart(9)} ${String(x.startMinMan).padStart(11)} ` +
      `${String(x.fought).padStart(6)} ${String(x.firstFight).padStart(3)} ${String(x.blows).padStart(10)}  ` +
      `${String(x.lostA).padStart(5)} ${String(x.lostB).padStart(5)}  ` +
      `${x.lockA ? 'A' : '-'}${x.lockB ? 'B' : '-'}  ` +
      `${String(x.frontGap).padStart(8)} ` +
      `${String(x.minManGap).padStart(6)} ${String(x.frontRankCreep).padStart(6)}` +
      (x.liveAI ? '  [AI live]' : '') + (x.anyRout ? '  (A SIDE ROUTED - cell confounded)' : '')
    );
    if (errors.length) console.log(`    ${errors.length} console error(s): ${[...new Set(errors)].slice(0, 1)}`);
  }
}

if (wants('field')) {
  console.log('\n## field — standoff pairs in the live siege\n');
  const { page, errors } = await newPage('&scenario=assault');
  const r = await runField(page, { seconds: 180, every: 15, nearM: 4.5 });
  await page.close();
  out.cases.field = r;
  console.log('     t  closePairs  standoffs  menIdle  fighting  locked   Rome  Germans');
  for (const x of r.rows) {
    console.log(
      `  ${String(x.t).padStart(4)} ${String(x.pairs).padStart(11)} ${String(x.standoffs).padStart(10)} ` +
      `${String(x.standoffMen).padStart(8)} ${String(x.fighting).padStart(9)} ${String(x.locked).padStart(7)} ` +
      `${String(x.alive0).padStart(6)} ${String(x.alive1).padStart(8)}`
    );
  }
  console.log(`  second-half means: ${r.meanPairs} close pairs, ${r.meanStandoffs} of them standoffs ` +
              `(${r.standoffShare}%), ${r.meanStandoffMen} men idle in one, ${r.meanFighting} fighting`);
  if (errors.length) console.log(`  ${errors.length} console error(s): ${[...new Set(errors)].slice(0, 2).join(' | ')}`);
}

if (wants('pull')) {
  console.log('\n## pull — player right-clicks a cohort onto a warband, live assault\n');
  const { page, errors } = await newPage('&scenario=assault');
  const r = await runPull(page, { warmup: 25, units: 4, standoffM: 3, seconds: 100, every: 20, nearM: 4.5 });
  await page.close();
  out.cases.pull = r;
  if (r.error) console.log(`  ERROR ${r.error}`);
  else {
    for (const u of r.units) {
      console.log(`  unit ${u.id}: started ${u.startDist} m away, ${u.alive} men, ` +
        `final front gap ${u.finalGap} m, lock ${u.lock}, order ${u.order}  ` +
        `-> ${u.standoffSec}s of ${r.seconds}s parked in front of an enemy with nobody fighting`);
    }
    console.log(`  TOTAL standoff: ${r.totalStandoffSec} unit-seconds of ${r.seconds * r.units.length}` +
      `   melee blows landed by anyone: ${r.blows}`);
    if (VERBOSE) for (const x of r.rows) console.log(`    ${JSON.stringify(x)}`);
  }
  if (errors.length) console.log(`  ${errors.length} console error(s): ${[...new Set(errors)].slice(0, 2).join(' | ')}`);
}

if (wants('run')) {
  console.log('\n## run — is the gait honoured?\n');
  const { page, errors } = await newPage('');
  const r = await runGait(page);
  await page.close();
  out.cases.run = r;
  console.log(`  roster: walkSpeed ${r.walkSpeed}  runSpeed ${r.runSpeed}  chargeSpeed ${r.chargeSpeed}`);
  console.log(`  measured walk ${r.measuredWalk} m/s (flag=${r.walkFlag})`);
  console.log(`  measured run  ${r.measuredRun} m/s (flag=${r.runFlag})`);
  console.log(`  ratio measured ${Math.round(r.measuredRun / r.measuredWalk * 100) / 100}x  ` +
              `vs roster ${Math.round(r.runSpeed / r.walkSpeed * 100) / 100}x`);
  console.log(`  synthetic KeyR: running ${r.keyBefore} -> ${r.keyAfter}, ` +
              `order emitted: ${r.keyEmittedOrder} ${JSON.stringify(r.ordersSeen)}`);
  console.log(`  mid-march 'gait' order: ${r.gaitBefore} -> ${r.gaitAfter} m/s ` +
              `(flag set ${r.gaitFlagSet}, destination preserved ${r.gaitKeptDestination})`);
  if (errors.length) console.log(`  ${errors.length} console error(s): ${[...new Set(errors)].slice(0, 2).join(' | ')}`);
}

if (wants('gate')) {
  console.log('\n## gate — the chokepoint\n');
  const { page, errors } = await newPage('&scenario=assault');
  // 5.3 m is the width the carriageway is cut at; see `SOLDIER_RADIUS` in BattleSystem.
  const r = await runGate(page, { units: 2, seconds: 120, gateW: 5.3, strayM: 30, gateWindow: 12 });
  await page.close();
  out.cases.gate = r;
  if (r.error) console.log(`  ERROR ${r.error}`);
  else {
    console.log(`  gate ${r.gate.id} at (${r.gate.x}, ${r.gate.z}), ${r.units} units / ${r.men} men, ` +
                `carriageway ${r.gateW} m -> ${r.halfW} m of clear half-width`);
    console.log(`  lateral drift while FIGHTING: ${r.lateralDriftFighting} m per man per second ` +
                `(${r.fightManSeconds} man-seconds in contact)`);
    console.log(`  lateral drift, all men:       ${r.lateralDriftAll} m per man per second`);
    console.log(`  unit heading change: ${r.headingDegPerSec} deg/s`);
    console.log(`  men inside solid masonry within ${r.gateWindow} m of the gate: ${r.insideMasonryPerMille} per mille ` +
                `(${r.insideMasonryManTicks} of ${r.manTicks} man-ticks in that window)`);
    console.log(`  wall-plane crossings: ${r.crossings}, of which off the carriageway: ${r.offAxisCrossings}`);
    console.log(`  men more than ${r.strayThreshold} m from their unit body: ${r.strayMen}`);
    for (const s of r.samples) {
      console.log(`    t+${String(s.t).padStart(3)}  ` +
        s.rows.map((x) => `u${x.id}(f${x.f}):${x.alive}a/${x.fighting}fight/${x.out}out/${x.far}far/sp${x.spread}`).join('  '));
    }
    if (r.shield && r.shield.n) console.log(`  shielded ${r.shield.n} render throw(s)`);
  }
  if (errors.length) console.log(`  ${errors.length} console error(s): ${[...new Set(errors)].slice(0, 2).join(' | ')}`);
}

if (wants('stragglers')) {
  console.log('\n## stragglers — do separated men rejoin?\n');
  const { page, errors } = await newPage('&scenario=assault');
  const r = await runStragglers(page, { units: 4, transit: 150, settle: 60, strayM: 30 });
  await page.close();
  out.cases.stragglers = r;
  if (r.error) console.log(`  ERROR ${r.error}`);
  else {
    console.log(`  gate ${r.gate}, stray threshold ${r.strayThreshold} m`);
    for (const s of r.transit) {
      console.log(`    t+${String(s.t).padStart(3)}  ` + s.rows.map((x) => `u${x.id}:${x.far}far/max${x.max}`).join('  '));
    }
    console.log('  at end of transit: ' + r.atTransit.map((x) =>
      `u${x.id} ${x.far} stray, max ${x.max} m, ${x.wrongSide} behind the wall`).join(' | '));
    console.log('  after 60 s settling: ' + r.afterSettle.map((x) =>
      `u${x.id} ${x.far} stray, max ${x.max} m, ${x.wrongSide} behind the wall`).join(' | '));
    if (r.diag) {
      console.log(`  rally machinery: nav bound ${r.diag.navBound}, ` +
        `breadcrumbs per unit ${JSON.stringify(r.diag.trails)}, ` +
        `men steering to a rally point ${JSON.stringify(r.diag.rallying)}`);
      console.log(`  rally condition split: ${JSON.stringify(r.diag.split)}`);
    }
  }
  if (errors.length) console.log(`  ${errors.length} console error(s): ${[...new Set(errors)].slice(0, 2).join(' | ')}`);
}

if (JSON_OUT) await writeFile(path.resolve(ROOT, JSON_OUT), JSON.stringify(out, null, 2));

await browser.close();
if (server) server.kill('SIGTERM');
process.exit(process.exitCode ?? 0);
