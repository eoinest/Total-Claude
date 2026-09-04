#!/usr/bin/env node
/**
 * Probe: what does a unit actually do when it is told to face the other way?
 *
 * The owner's two reports are one measurement apart. "My friend was trying to control the
 * cavalry but they kept running away — they were not routed, but they would not turn around
 * to face" and "there is no way for a unit to about-face; instead the entire unit rotates"
 * are the same event seen from two seats, *if* a facing change is a rigid rotation of the
 * slot lattice about the unit's anchor. Every man's slot then lands somewhere else in the
 * world, the man walks to it, and from the player's seat that is men running away rather
 * than men turning round. That is a hypothesis, and this is the instrument that decides it.
 *
 * Per man, over one facing order:
 *
 * **travel**   — path length, metres. The distance he actually walked.
 * **net**      — straight line start to finish, metres. How far he ended up from where he was.
 * **settle**   — seconds until his speed stays below `STILL` for the rest of the window.
 * **crossed**  — net displacement over half the block's own frontage: he ended up on the far
 *                side of his own unit. This is "he ran the long way round" as a count.
 * **turned**   — travel under `TURN_ONLY`, i.e. he turned rather than walked. This is the
 *                thing the owner asked for, as a count.
 * **faceErr**  — |wrap(p.facing[i] - ordered)| at the end, degrees. "They would not turn
 *                around to face" is a claim about *this* number and nothing else, and it is
 *                the one a screenshot cannot settle.
 *
 * And per unit the footprint: centroid shift and the block's extents in its own pre-order
 * frame, before and after. "The block keeps its footprint" is the spec, so the centroid
 * shift is the spec as a number.
 *
 * ## Why it advances in ticks and stops the clock
 *
 * Same reason `tools/probe-hivemind.mjs` does, and its header is the long version: the page's
 * rAF loop keeps stepping the world between Playwright round trips, so without
 * `stopClockOnReady` a case begins at a different tick every run and the probe reports load
 * average. Every step here is `advanceTicks(1)`, never `advance(seconds)`.
 *
 * ## Why the teardown, and why there is a `--live` arm anyway
 *
 * The shipped battle is 8,632 men who are busy. A facing order given inside it is measured
 * against morale, missiles, contact locks and an AI that will countermand it, so the
 * synthetic cases spawn their subject onto empty ground and the only thing in the number is
 * the order. But a lab result that never touches the shipped battle is the failure mode this
 * repository keeps finding in its own instruments, so `--live` gives the same order to a real
 * unit of the real order of battle on real ground, and the two are expected to agree.
 *
 * Usage:
 *   node tools/probe-aboutface.mjs --port=5942 [--json=path] [--label=before] [--live]
 */

import { writeFile } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { launchBrowser, startVite } from './lib/browser-budget.mjs';
import { stopClockOnReady } from './lib/simclock.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const args = new Map(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
}));
const PORT = Number(args.get('port') ?? 5942);
const JSON_OUT = args.get('json') ?? null;
const LABEL = args.get('label') ?? '';
const LIVE = args.get('live') === 'true';

let rev = 'unknown';
try {
  rev = execSync('git rev-parse --short HEAD', { cwd: ROOT }).toString().trim();
  if (execSync('git status --porcelain -- src/', { cwd: ROOT }).toString().trim()) rev += '+dirty';
} catch { /* not a checkout */ }

// Browser first, then the server, and the server takes the browser's slot. A run that is
// queueing for a browser should not be sitting on a port while it waits.
const browser = await launchBrowser({ label: 'probe-aboutface', port: PORT, root: ROOT });
const { base, close: closeServer } = await startVite({
  port: PORT, root: ROOT, label: 'probe-aboutface', slot: browser.budgetSlot,
});

const HELPERS = `
window.__af = (() => {
  const g = window.__game, b = g.battle, ctx = g.engine.context, p = b.pool;
  const DEAD = 11, DYING = 10;
  const alive = (i) => p.state[i] !== DEAD && p.state[i] !== DYING;
  const teardown = async () => {
    for (const u of b.units) {
      if (u.destroyed) continue;
      for (const i of u.members) if (alive(i)) p.setState(i, DEAD);
      u.alive = 0; u.destroyed = true;
    }
    const shared = await import('/src/sim/combatShared.ts');
    shared.resetCombatShared();
    const mor = ctx.tryGet('morale');
    if (mor && mor.redeploy) mor.redeploy();
    for (const name of ['tactical-ai', 'general-ai', 'battleFlow', 'projectiles']) {
      const s = ctx.tryGet(name);
      if (s && s.fixedUpdate) s.fixedUpdate = () => {};
    }
    for (const s of (g.engine.systems || g.engine.subsystems || [])) {
      for (const hook of ['update', 'preRender', 'resize']) {
        const fn = s[hook];
        if (typeof fn !== 'function') continue;
        const bound = fn.bind(s);
        s[hook] = (...a) => { try { return bound(...a); } catch (e) { /* shielded */ } };
      }
    }
  };
  const wrap = (a) => {
    let v = a;
    while (v > Math.PI) v -= 2 * Math.PI;
    while (v < -Math.PI) v += 2 * Math.PI;
    return v;
  };
  return { g, b, ctx, p, alive, teardown, wrap };
})();
`;

const CASES = `
window.__afRun = async (spec) => {
  const H = window.__af, { g, b, ctx, p } = H;
  if (!spec.live) { await H.teardown(); b.unitSizeScale = 1; }

  let subject;
  if (spec.live) {
    // The two AIs are stopped and nothing else is. The subject is a unit the *player* is
    // commanding, and leaving the tactical AI running means the order under test is
    // countermanded within a second by a general who has other plans: the first cut of this
    // arm measured a squadron that was still executing its own attack order, reported 85 m
    // of travel before and 85 m after, and would have said the fix did nothing. Morale,
    // combat, projectiles and the terrain all stay live, so this is still the shipped
    // battle on the shipped ground.
    for (const name of ['tactical-ai', 'general-ai']) {
      const s = ctx.tryGet(name);
      if (s && s.fixedUpdate) s.fixedUpdate = () => {};
    }
    // A real unit from the shipped order of battle: the largest of its class not yet in
    // contact, so the order is measured against the battle rather than against a lab.
    const want = spec.mounted
      ? (u) => u.typeId === 'equites' || u.typeId === 'juthungi-riders'
      : (u) => u.typeId === 'legio-cohort' || u.typeId === 'juthungi-warband';
    const cands = b.units.filter((u) => !u.destroyed && want(u) && !u.contactLock);
    cands.sort((a, c) => (c.alive - a.alive) || (a.id - c.id));
    subject = cands[0];
    if (!subject) return { case: spec.id, error: 'no live subject' };
    ctx.events.emit('orderIssued', { unitIds: [subject.id], kind: 'halt' });
    g.advanceTicks((spec.settle ?? 6) * 30);
  } else {
    const id = b.spawnUnit(spec.type, 0, 0, spec.facing0 ?? 0, spec.form);
    subject = b.unitById(id);
    if (!subject) return { case: spec.id, error: 'spawn failed' };
    if (subject.alive < 20) return { case: spec.id, error: 'pool exhausted ' + subject.alive };
    ctx.events.emit('orderIssued', { unitIds: [subject.id], kind: 'halt' });
    g.advanceTicks((spec.settle ?? 10) * 30);
  }

  const men = subject.members.filter(H.alive);
  const n = men.length;
  if (n < 10) return { case: spec.id, error: 'subject too small ' + n };

  // ---- the block before the order --------------------------------------------
  const bx = new Float64Array(n), bz = new Float64Array(n);
  for (let k = 0; k < n; k++) { const i = men[k]; bx[k] = p.x[i]; bz[k] = p.z[i]; }
  const f0 = subject.facing, ax0 = subject.x, az0 = subject.z;
  const c0 = Math.cos(f0), s0 = Math.sin(f0);
  // The pre-order block's own frame: +z along its facing, +x to its right. Every extent
  // below is in this frame and in no other, so before and after are comparable.
  const locX = (x, z) => (x - ax0) * c0 - (z - az0) * s0;
  const locZ = (x, z) => (x - ax0) * s0 + (z - az0) * c0;
  let minLX = Infinity, maxLX = -Infinity, minLZ = Infinity, maxLZ = -Infinity;
  let cx0 = 0, cz0 = 0;
  for (let k = 0; k < n; k++) {
    const lx = locX(bx[k], bz[k]), lz = locZ(bx[k], bz[k]);
    if (lx < minLX) minLX = lx;
    if (lx > maxLX) maxLX = lx;
    if (lz < minLZ) minLZ = lz;
    if (lz > maxLZ) maxLZ = lz;
    cx0 += bx[k]; cz0 += bz[k];
  }
  cx0 /= n; cz0 /= n;
  const frontage = maxLX - minLX;
  const depth = maxLZ - minLZ;

  // ---- the order --------------------------------------------------------------
  const ordered = H.wrap(f0 + spec.turn);
  if (spec.gesture === 'move') {
    // What the player's right-click-drag actually sends. The UI has no pure-facing verb at
    // all: every facing a player sets rides on a move order, which is the first half of the
    // owner's second report and is worth measuring on its own.
    ctx.events.emit('orderIssued', {
      unitIds: [subject.id], kind: 'move', x: subject.x, z: subject.z, facing: ordered,
    });
  } else {
    ctx.events.emit('orderIssued', { unitIds: [subject.id], kind: 'facing', facing: ordered });
  }

  // ---- watch ------------------------------------------------------------------
  const TICKS = spec.ticks ?? 900;              // 30 s at 30 Hz
  const STILL = 0.15;                           // m/s below which a man is standing
  const travel = new Float64Array(n);
  const lastMoveTick = new Int32Array(n).fill(-1);
  const px = new Float64Array(n), pz = new Float64Array(n);
  for (let k = 0; k < n; k++) { px[k] = bx[k]; pz[k] = bz[k]; }
  const anchorPath = [];
  for (let t = 0; t < TICKS; t++) {
    g.advanceTicks(1);
    for (let k = 0; k < n; k++) {
      const i = men[k];
      if (!H.alive(i)) continue;
      const dx = p.x[i] - px[k], dz = p.z[i] - pz[k];
      const d = Math.sqrt(dx * dx + dz * dz);
      travel[k] += d;
      if (d * 30 > STILL) lastMoveTick[k] = t;
      px[k] = p.x[i]; pz[k] = p.z[i];
    }
    if (t % 60 === 0) {
      anchorPath.push([Math.round(subject.x * 100) / 100, Math.round(subject.z * 100) / 100]);
    }
  }

  // ---- after -------------------------------------------------------------------
  const net = new Float64Array(n), faceErr = new Float64Array(n);
  // The facing figure has to be attributable or it is not a finding. A man who is in melee
  // keeps his opponent's bearing and a man who is still walking keeps his travel bearing —
  // both by design — so a median taken over the whole unit is a median over three different
  // populations. The settled men are the ones the order is about: neither of those two.
  const FIGHTING = 4;
  const settledErr = [];
  let nFighting = 0, nWalking = 0;
  let cx1 = 0, cz1 = 0, live = 0;
  let minLX1 = Infinity, maxLX1 = -Infinity, minLZ1 = Infinity, maxLZ1 = -Infinity;
  for (let k = 0; k < n; k++) {
    const i = men[k];
    const dx = p.x[i] - bx[k], dz = p.z[i] - bz[k];
    net[k] = Math.sqrt(dx * dx + dz * dz);
    faceErr[k] = Math.abs(H.wrap(p.facing[i] - ordered)) * 180 / Math.PI;
    const speed = Math.sqrt(p.vx[i] * p.vx[i] + p.vz[i] * p.vz[i]);
    if (p.state[i] === FIGHTING) nFighting++;
    else if (speed > 0.22) nWalking++;
    else settledErr.push(faceErr[k]);
    cx1 += p.x[i]; cz1 += p.z[i]; live++;
    const lx = locX(p.x[i], p.z[i]), lz = locZ(p.x[i], p.z[i]);
    if (lx < minLX1) minLX1 = lx;
    if (lx > maxLX1) maxLX1 = lx;
    if (lz < minLZ1) minLZ1 = lz;
    if (lz > maxLZ1) maxLZ1 = lz;
  }
  cx1 /= live; cz1 /= live;

  const pct = (arr, q) => {
    const a = Array.from(arr).sort((x, y) => x - y);
    return a[Math.min(a.length - 1, Math.floor(a.length * q))] ?? 0;
  };
  const mean = (arr) => { let s = 0; for (const v of arr) s += v; return s / Math.max(1, arr.length); };
  const maxOf = (arr) => { let m = 0; for (const v of arr) if (v > m) m = v; return m; };
  const r2 = (v) => Math.round(v * 100) / 100;
  const settle = Array.from(lastMoveTick, (t) => (t + 1) / 30);

  // "He ran the long way round": he ended up further from where he stood than half his own
  // unit is wide, which for a block that kept its ground means he is on the other side of it.
  const CROSS = Math.max(2, frontage * 0.5);
  const TURN_ONLY = 0.5;
  let crossed = 0, turnedOnly = 0, walked = 0;
  for (let k = 0; k < n; k++) {
    if (net[k] > CROSS) crossed++;
    if (travel[k] < TURN_ONLY) turnedOnly++; else walked++;
  }

  return {
    case: spec.id, n, ticks: TICKS, live: !!spec.live,
    unit: subject.typeId, formation: subject.formationId, width: subject.width,
    frontage: r2(frontage), depth: r2(depth),
    turnDeg: Math.round(spec.turn * 180 / Math.PI),
    gesture: spec.gesture ?? 'facing',
    travel: { p50: r2(pct(travel, 0.5)), p95: r2(pct(travel, 0.95)), max: r2(maxOf(travel)), mean: r2(mean(travel)) },
    net: { p50: r2(pct(net, 0.5)), p95: r2(pct(net, 0.95)), max: r2(maxOf(net)), mean: r2(mean(net)) },
    settle: { p50: r2(pct(settle, 0.5)), p95: r2(pct(settle, 0.95)), max: r2(maxOf(settle)) },
    faceErr: { p50: r2(pct(faceErr, 0.5)), p95: r2(pct(faceErr, 0.95)), max: r2(maxOf(faceErr)), mean: r2(mean(faceErr)) },
    settledFaceErr: {
      n: settledErr.length,
      p50: r2(pct(settledErr, 0.5)), p95: r2(pct(settledErr, 0.95)), max: r2(maxOf(settledErr)),
    },
    stillFighting: nFighting, stillWalking: nWalking,
    crossed, crossedThresh: r2(CROSS), turnedOnly, walked,
    footprint: {
      centroidShift: r2(Math.sqrt((cx1 - cx0) * (cx1 - cx0) + (cz1 - cz0) * (cz1 - cz0))),
      beforeLX: [r2(minLX), r2(maxLX)], afterLX: [r2(minLX1), r2(maxLX1)],
      beforeLZ: [r2(minLZ), r2(maxLZ)], afterLZ: [r2(minLZ1), r2(maxLZ1)],
    },
    unitFacingErrDeg: r2(Math.abs(H.wrap(subject.facing - ordered)) * 180 / Math.PI),
    anchorPath,
  };
};
`;

const SPECS = [
  { id: 'inf-180', type: 'legio-cohort', form: 'line', turn: Math.PI, ticks: 900 },
  { id: 'cav-180', type: 'equites', form: 'line', turn: Math.PI, ticks: 900 },
  { id: 'inf-90', type: 'legio-cohort', form: 'line', turn: Math.PI / 2, ticks: 900 },
  { id: 'cav-90', type: 'equites', form: 'line', turn: Math.PI / 2, ticks: 900 },
  { id: 'cav-180-wedge', type: 'equites', form: 'wedge', turn: Math.PI, ticks: 900 },
  // The player's real gesture: a right-click-drag is a move order carrying a facing.
  { id: 'inf-180-drag', type: 'legio-cohort', form: 'line', turn: Math.PI, ticks: 900, gesture: 'move' },
  { id: 'cav-180-drag', type: 'equites', form: 'line', turn: Math.PI, ticks: 900, gesture: 'move' },
];

const LIVE_SPECS = [
  { id: 'live-inf-180', live: true, mounted: false, turn: Math.PI, ticks: 600 },
  { id: 'live-cav-180', live: true, mounted: true, turn: Math.PI, ticks: 600 },
];

const report = (r) => {
  if (r.error) { console.log(`\n${r.case}: ERROR ${r.error}`); return; }
  console.log(`\n=== ${r.case} — ${r.unit} ${r.formation}, ${r.n} men, ${r.width} wide, `
    + `${r.frontage} m front x ${r.depth} m deep, ordered ${r.turnDeg} deg via '${r.gesture}' ===`);
  console.log(`  travel  p50 ${r.travel.p50.toFixed(2)}  p95 ${r.travel.p95.toFixed(2)}  max ${r.travel.max.toFixed(2)} m   (mean ${r.travel.mean.toFixed(2)})`);
  console.log(`  net     p50 ${r.net.p50.toFixed(2)}  p95 ${r.net.p95.toFixed(2)}  max ${r.net.max.toFixed(2)} m`);
  console.log(`  settle  p50 ${r.settle.p50.toFixed(1)}  p95 ${r.settle.p95.toFixed(1)}  max ${r.settle.max.toFixed(1)} s`);
  console.log(`  facing  p50 ${r.faceErr.p50.toFixed(1)}  p95 ${r.faceErr.p95.toFixed(1)}  max ${r.faceErr.max.toFixed(1)} deg off the order   (unit heading off by ${r.unitFacingErrDeg.toFixed(1)})`);
  console.log(`  ...of the ${r.settledFaceErr.n} who are settled: p50 ${r.settledFaceErr.p50.toFixed(1)}  p95 ${r.settledFaceErr.p95.toFixed(1)} deg`
    + `   [${r.stillFighting} in melee, ${r.stillWalking} still walking — both keep their own bearing by design]`);
  console.log(`  crossed the block (net > ${r.crossedThresh} m): ${r.crossed}/${r.n}     turned without walking (< 0.5 m): ${r.turnedOnly}/${r.n}`);
  console.log(`  footprint: centroid moved ${r.footprint.centroidShift.toFixed(2)} m; `
    + `along-facing extent ${r.footprint.beforeLZ.join('..')} -> ${r.footprint.afterLZ.join('..')}, `
    + `lateral ${r.footprint.beforeLX.join('..')} -> ${r.footprint.afterLX.join('..')}`);
};

const page = await browser.newPage({ viewport: { width: 480, height: 270 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.setDefaultTimeout(300000);
// Before goto, and not negotiable: without it the page's rAF loop keeps stepping the world
// between Playwright round trips and every case starts at a different tick. See
// tools/lib/simclock.mjs.
await stopClockOnReady(page);
await page.goto(`${base}/?harness=1&quality=high&autoplay=1&w=480&h=270`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__game?.ready === true, undefined, { timeout: 300000 });
await page.evaluate(() => window.__game.engine.stop());   // belt as well as braces
await page.evaluate((s) => { new Function(s)(); }, HELPERS);
await page.evaluate((s) => { new Function(s)(); }, CASES);

console.log(`[probe-aboutface] tree ${rev}${LABEL ? ` — ${LABEL}` : ''}`);
const results = [];

// The live cases run first: they need the shipped battle intact, and the synthetic ones
// tear it down.
for (const spec of (LIVE ? LIVE_SPECS : [])) {
  const r = await page.evaluate((s) => window.__afRun(s), spec);
  results.push(r);
  report(r);
}
for (const spec of SPECS) {
  const r = await page.evaluate((s) => window.__afRun(s), spec);
  results.push(r);
  report(r);
}

if (errors.length) console.log('\n[page errors]', errors.slice(0, 3));

await page.close();
await browser.close();
await closeServer();
if (JSON_OUT) {
  await writeFile(JSON_OUT, JSON.stringify({ rev, label: LABEL, results }, null, 2));
  console.log(`\nwrote ${JSON_OUT}`);
}
