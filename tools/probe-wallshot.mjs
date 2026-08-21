#!/usr/bin/env node
/**
 * Wall-shot probe: does a stone from a siege engine actually stop on the city's masonry?
 *
 * The report that started this was by eye — "catapult projectiles pass through walls". A still
 * frame cannot separate the causes, and neither can reading `integrate`: the masonry test there
 * is a point sample at the end of each step, which *looks* like it should tunnel, but a boulder
 * leaves the muzzle at 52 m/s and a tick is 1/30 s, so it advances 1.73 m into a 6 m curtain and
 * cannot step over it. So the arithmetic acquits the obvious suspect and something else is wrong.
 *
 * This probe therefore does not test a theory. It follows **one** projectile, tick by tick, from
 * the muzzle to whatever ends it, and prints alongside each sample the three numbers that decide
 * the collision: the projectile's own `y`, what `masonryTopAt` answers at that `(x, z)`, and the
 * signed perpendicular offset from the wall's centreline so the plan band is visible. The tick
 * where it should have hit and did not is then a line in a table rather than an argument.
 *
 * INSTRUMENT CHECK RUNS FIRST AND ITS FAILURE IS FATAL. Roughly as many defects in this repo have
 * been in the instruments as in the product, so before any claim about artillery this asserts:
 *
 *   1. the city system is present and `masonryTopAt` is a live function (`Projectiles.init`
 *      reaches it through `as unknown as` with an optional-method check, so a rename would
 *      silently leave `this.city === null` and *nothing* would collide with masonry);
 *   2. `masonryTopAt` answers *above the local ground* somewhere on the curtain, i.e. there is
 *      masonry there at all to be hit;
 *   3. a POSITIVE CONTROL — an arrow fired point blank into the curtain from 12 m registers on
 *      the masonry census. If the control fails, the plumbing is broken and every "passes
 *      through" result below is a measurement of the probe, not of the game.
 *
 * Every trace is driven through the real `ProjectileSystem.launchBallistic` and the real
 * `fixedUpdate`, at `spread: 0` so the shot is deterministic and repeatable.
 *
 *   node tools/probe-wallshot.mjs --port=5741
 *   node tools/probe-wallshot.mjs --port=5741 --json=out.json
 *   node tools/probe-wallshot.mjs --port=5741 --kinds=boulder,arrow,bolt
 */

import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');
const args = new Map(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
  })
);
const PORT = Number(args.get('port') ?? 5741);
const JSON_OUT = args.get('json') ?? null;
const KINDS = String(args.get('kinds') ?? 'boulder,arrow,bolt,javelin,sling-stone,pilum')
  .split(',').filter(Boolean);
const SCENARIO = args.get('scenario') ?? 'assault';
const base = `http://127.0.0.1:${PORT}`;

const pad = (s, n) => String(s).padEnd(n);
const num = (s, n) => String(s).padStart(n);

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal'] });
const page = await browser.newPage({ viewport: { width: 640, height: 400 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

console.log(`probe-wallshot against ${base} (scenario=${SCENARIO})`);
await page.goto(`${base}/?harness=1&quality=low&autoplay=0&scenario=${SCENARIO}&w=640&h=400`,
  { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 240000 });

const results = { port: PORT, scenario: SCENARIO };

/**
 * Clear the field so nothing but our own shot is in the air, and stop the AI re-ordering
 * armies that no longer exist. Same teardown `probe-artillery.mjs` uses.
 */
await page.evaluate(async () => {
  const g = window.__game;
  const b = g.battle;
  const ctx = g.engine.context;
  const p = b.pool;
  for (const u of b.units) {
    if (u.destroyed) continue;
    for (const i of u.members) if (p.aliveAt(i)) p.setState(i, 11 /* Dead */);
    u.alive = 0;
    u.destroyed = true;
  }
  const shared = await import('/src/sim/combatShared.ts');
  shared.resetCombatShared();
  for (const n of ['tactical-ai', 'general-ai', 'pathfinding', 'battleFlow', 'autoEngage', 'siege']) {
    const s = ctx.tryGet(n);
    if (s?.fixedUpdate) s.fixedUpdate = () => {};
  }
});

// ---------------------------------------------------------------------------
// 0. Instrument check. Fatal on failure.
// ---------------------------------------------------------------------------
console.log('\n=== instrument check ===');
const inst = await page.evaluate(() => {
  const g = window.__game;
  const ctx = g.engine.context;
  const b = g.battle;
  const city = ctx.tryGet('city');
  const pr = ctx.get('projectiles');
  const out = {
    cityRegistered: !!city,
    masonryTopAtIsFn: typeof city?.masonryTopAt === 'function',
    // Does the *system under test* believe it has a city? `init` stores it privately after an
    // optional-method check; if that check ever fails this is null and nothing hits masonry.
    projectilesHasCity: !!pr.city,
    bays: [],
  };
  if (!city?.masonryTopAt) return out;
  const bays = city.getGarrisonBays ? city.getGarrisonBays() : [];
  out.bayCount = bays.length;
  /**
   * Bays from the MIDDLE of the circuit, sampled at the MIDDLE of each bay's own run.
   *
   * Both of those are the probe's own bug, found by this check failing. `masonryTopAt` resolves
   * its bay by `floor((x - bayX0) / bayPitch)` and answers `-Infinity` off either end, and the
   * wall runs diagonally — 35.5 m of x per bay against 12.7 m of z — so a muzzle stood off 12 m
   * along the outward normal of bay 0 sits 4 m *west of `bayX0`* and reports no masonry along
   * the entire outward half of its own approach. Sampling at `t = 0` put the aim point exactly
   * on that boundary. Aiming at mid-run, mid-circuit, keeps 700 m of x either side.
   */
  const mid = bays.length >> 1;
  for (let k = 0; k < bays.length; k++) {
    const bay = bays[(mid + k) % bays.length];
    if (!bay.walkable || bay.stage !== 'finished') continue;
    const cx = (bay.x0 + bay.x1) * 0.5;
    const cz = (bay.z0 + bay.z1) * 0.5;
    const top = city.masonryTopAt(cx, cz);
    const gnd = b.groundAt(cx, cz);
    out.bays.push({
      index: bay.index,
      x0: +bay.x0.toFixed(2), z0: +bay.z0.toFixed(2),
      x1: +bay.x1.toFixed(2), z1: +bay.z1.toFixed(2),
      midX: cx, midZ: cz, length: +bay.length.toFixed(2),
      dx: bay.dx, dz: bay.dz, nx: bay.nx, nz: bay.nz,
      halfThickness: +bay.halfThickness.toFixed(3),
      walkY: +bay.walkY.toFixed(2), crestY: +bay.crestY.toFixed(2),
      sillY: +bay.sillY.toFixed(2),
      parapetInner: +bay.parapetInner.toFixed(3),
      parapetOuter: +bay.parapetOuter.toFixed(3),
      stage: bay.stage, walkable: bay.walkable,
      topAtCentre: Number.isFinite(top) ? +top.toFixed(2) : String(top),
      groundAtCentre: +gnd.toFixed(2),
      standsProud: Number.isFinite(top) && top > gnd + 1,
    });
    if (out.bays.length >= 4) break;
  }
  return out;
});
results.instrument = inst;
console.log(`  city system registered .......... ${inst.cityRegistered}`);
console.log(`  city.masonryTopAt is a function . ${inst.masonryTopAtIsFn}`);
console.log(`  ProjectileSystem.city bound ..... ${inst.projectilesHasCity}`);
console.log(`  garrison bays ................... ${inst.bayCount ?? 0}`);
for (const b of inst.bays) {
  console.log(`    bay ${b.index} run (${b.x0}, ${b.z0}) -> (${b.x1}, ${b.z1}) len ${b.length} m` +
    `  halfThickness ${b.halfThickness}`);
  console.log(`      walkY ${b.walkY}  sillY ${b.sillY}  crestY ${b.crestY}` +
    `  parapetInner ${b.parapetInner}  parapetOuter ${b.parapetOuter}  stage ${b.stage}`);
  console.log(`      masonryTopAt(mid-run) ${b.topAtCentre} over ground ${b.groundAtCentre}` +
    (b.standsProud ? '' : '   <-- NO MASONRY HERE'));
}
if (!inst.cityRegistered || !inst.masonryTopAtIsFn || !inst.projectilesHasCity) {
  console.error('\nINSTRUMENT FAILED: the collision source is not reachable. ' +
    'Every result below would be meaningless. Stopping.');
  await browser.close();
  process.exit(3);
}
const probeBay = inst.bays.find((b) => b.standsProud);
if (!probeBay) {
  console.error('\nINSTRUMENT FAILED: no bay reports masonry standing above its own ground.');
  await browser.close();
  process.exit(3);
}

/**
 * Fire one shot and follow exactly that pool slot to its end.
 *
 * `launchBallistic` returns the boolean but not the index, so the free-list head is read
 * immediately before the call and confirmed alive immediately after: latching "the first live
 * projectile" instead is what made an earlier trace in this repo follow a different shot.
 */
const trace = async (spec) => page.evaluate(async (s) => {
  const g = window.__game;
  const ctx = g.engine.context;
  const b = g.battle;
  const pr = ctx.get('projectiles');
  const city = ctx.tryGet('city');
  const rng = b.rng.fork(`probe-wallshot-${s.tag}`);

  const before = new Set();
  for (let i = 0; i < pr.highWater; i++) if (pr.alive[i] === 1) before.add(i);

  const ok = pr.launchBallistic({
    kind: s.kind,
    fromX: s.fromX, fromY: s.fromY, fromZ: s.fromZ,
    toX: s.toX, toY: s.toY, toZ: s.toZ,
    damage: 40, apDamage: 20, spread: 0,
    ownerUnit: -1, rng, lofted: !!s.lofted,
  });
  if (!ok) return { launched: false };

  let idx = -1;
  for (let i = 0; i < pr.highWater; i++) {
    if (pr.alive[i] === 1 && !before.has(i)) { idx = i; break; }
  }
  if (idx < 0) return { launched: true, latched: false };

  const bay = s.bay;
  // Signed perpendicular offset from this bay's centreline, positive outward — the same
  // arithmetic `masonryTopAt` runs, recomputed here so the plan band is visible in the trace.
  const offAt = (x, z) => {
    const t = (x - bay.x0) * bay.dx + (z - bay.z0) * bay.dz;
    const px = bay.x0 + bay.dx * t;
    const pz = bay.z0 + bay.dz * t;
    return { t, off: (x - px) * bay.nx + (z - pz) * bay.nz };
  };
  // Whether masonryTopAt can resolve a bay for this x at all — its answer is -Infinity off
  // either end of the circuit, which is not the same fact as "no stone in the cross-section".
  const inCircuit = (x) => !!(city.bayAt && city.bayAt(x));

  const samples = [];
  const m0 = pr.masonryHits;
  let tick = 0;
  let end = 'still alive at cap';
  const start = {
    x: pr.px[idx], y: pr.py[idx], z: pr.pz[idx],
    vx: pr.vx[idx], vy: pr.vy[idx], vz: pr.vz[idx],
  };
  for (tick = 0; tick < 900; tick++) {
    const x0 = pr.px[idx];
    const y0 = pr.py[idx];
    const z0 = pr.pz[idx];
    g.advance(1 / 30);
    const alive = pr.alive[idx] === 1;
    const x1 = alive ? pr.px[idx] : pr.ox[idx];
    const y1 = alive ? pr.py[idx] : pr.oy[idx];
    const z1 = alive ? pr.pz[idx] : pr.oz[idx];
    const a = offAt(x0, z0);
    const c = offAt(x1, z1);
    /**
     * The whole question, measured rather than argued.
     *
     * `integrate` asks `masonryTopAt` once, at the FAR END of the step. Walk the same step in
     * 200 substeps and ask at every one. If any substep is inside masonry (`y <= top`) while
     * the far end is not, then a swept test would have registered an impact the shipped point
     * sample threw away — and that is a tunnelling miss, at a measured depth and offset.
     */
    let missed = null;
    const SUB = 200;
    for (let q = 1; q <= SUB; q++) {
      const f = q / SUB;
      const sx = x0 + (x1 - x0) * f;
      const sy = y0 + (y1 - y0) * f;
      const sz = z0 + (z1 - z0) * f;
      const st = city ? city.masonryTopAt(sx, sz) : -Infinity;
      if (sy <= st) {
        missed = { f: +f.toFixed(3), y: +sy.toFixed(2), top: +st.toFixed(2),
          off: +offAt(sx, sz).off.toFixed(2), depth: +(st - sy).toFixed(2) };
        break;
      }
    }
    samples.push({
      missed,
      tick: tick + 1,
      x0: +x0.toFixed(2), y0: +y0.toFixed(2), z0: +z0.toFixed(2),
      x1: +x1.toFixed(2), y1: +y1.toFixed(2), z1: +z1.toFixed(2),
      // masonryTopAt at BOTH ends of the step, which is the whole question: the sim only
      // ever asks at the far end.
      top0: city ? city.masonryTopAt(x0, z0) : -Infinity,
      top1: city ? city.masonryTopAt(x1, z1) : -Infinity,
      off0: +a.off.toFixed(2), off1: +c.off.toFixed(2),
      t1: +c.t.toFixed(1),
      ground1: +b.groundAt(x1, z1).toFixed(2),
      inCirc1: inCircuit(x1),
      step: +Math.hypot(x1 - x0, y1 - y0, z1 - z0).toFixed(2),
      alive,
    });
    if (!alive) {
      end = pr.masonryHits > m0 ? 'MASONRY' : 'ground/other';
      break;
    }
  }
  return {
    launched: true, latched: true, idx, start, end, ticks: tick + 1,
    masonryHitDelta: pr.masonryHits - m0,
    samples,
  };
}, spec);

// ---------------------------------------------------------------------------
// 0b. Positive control: an arrow point blank into the curtain must register.
// ---------------------------------------------------------------------------
const geom = await page.evaluate((bay) => {
  const g = window.__game;
  const b = g.battle;
  // Stand off along the OUTWARD normal and aim at the middle of the wall's own thickness,
  // at mid-parapet height, from a muzzle 12 m out. Point blank, flat, unmissable.
  const standoff = 12;
  const fx = bay.midX + bay.nx * standoff;
  const fz = bay.midZ + bay.nz * standoff;
  return {
    fromX: fx, fromZ: fz, fromY: b.groundAt(fx, fz) + 1.6,
    toX: bay.midX, toZ: bay.midZ, toY: (bay.walkY + bay.crestY) * 0.5,
  };
}, probeBay);

// ---------------------------------------------------------------------------
// 0a. Geometry audit: is there masonry in the COLLISION model everywhere the
//     OBSTACLE model says a solid stands?
//
// `masonryTopAt` is what a projectile is tested against. `getObstacles()` is what a *body*
// is tested against. They are two independent descriptions of the same stone, so any solid
// whose footprint the heightfield answers `-Infinity` over is masonry that men walk around
// and shots fly through. This compares them box by box rather than trusting either.
// ---------------------------------------------------------------------------
console.log('\n=== geometry audit: obstacle solids vs the projectile heightfield ===');
const audit = await page.evaluate(() => {
  const g = window.__game;
  const ctx = g.engine.context;
  const b = g.battle;
  const city = ctx.tryGet('city');
  const obs = city.getObstacles ? city.getObstacles() : [];
  const byKind = new Map();
  for (const o of obs) {
    // Sample the box's own footprint on a 5x5 grid in its local frame, inset slightly so a
    // sample cannot land exactly on an edge and pick up the neighbour.
    const c = Math.cos(o.rot);
    const sn = Math.sin(o.rot);
    let covered = 0;
    let total = 0;
    let worstGap = -1;
    let sumTop = 0;
    let nTop = 0;
    for (let iu = -2; iu <= 2; iu++) {
      for (let iv = -2; iv <= 2; iv++) {
        const u = (iu / 2.4) * o.hw;
        const v = (iv / 2.4) * o.hd;
        // Obstacle boxes use rot as the yaw of the u axis about +Y, matching occRot.
        const x = o.x + u * c + v * sn;
        const z = o.z - u * sn + v * c;
        const top = city.masonryTopAt(x, z);
        total++;
        if (Number.isFinite(top)) {
          covered++;
          sumTop += top;
          nTop++;
          const gap = o.topY - top;
          if (gap > worstGap) worstGap = gap;
        } else {
          worstGap = Math.max(worstGap, o.topY - b.groundAt(x, z));
        }
      }
    }
    const k = o.kind;
    if (!byKind.has(k)) {
      byKind.set(k, { kind: k, boxes: 0, samples: 0, covered: 0, fullyTransparent: 0,
        maxGap: -1e9, sumTopY: 0, examples: [] });
    }
    const e = byKind.get(k);
    e.boxes++;
    e.samples += total;
    e.covered += covered;
    e.sumTopY += o.topY;
    if (covered === 0) {
      e.fullyTransparent++;
      if (e.examples.length < 3) {
        e.examples.push({ x: +o.x.toFixed(1), z: +o.z.toFixed(1),
          hw: +o.hw.toFixed(2), hd: +o.hd.toFixed(2), topY: +o.topY.toFixed(2),
          groundY: +b.groundAt(o.x, o.z).toFixed(2) });
      }
    }
    if (worstGap > e.maxGap) e.maxGap = worstGap;
    e.meanTopAt = nTop ? +(sumTop / nTop).toFixed(2) : null;
  }
  return {
    obstacleCount: obs.length,
    kinds: [...byKind.values()].map((e) => ({
      kind: e.kind, boxes: e.boxes,
      coveredPct: +(100 * e.covered / e.samples).toFixed(1),
      fullyTransparent: e.fullyTransparent,
      meanTopY: +(e.sumTopY / e.boxes).toFixed(2),
      maxGapM: +e.maxGap.toFixed(2),
      examples: e.examples,
    })),
  };
});
results.audit = audit;
console.log(`  ${audit.obstacleCount} obstacle boxes from the city`);
console.log(`  ${pad('kind', 12)}${num('boxes', 7)}${num('covered%', 10)}` +
  `${num('transparent', 13)}${num('meanTopY', 10)}${num('maxGap m', 10)}`);
for (const k of audit.kinds) {
  console.log(`  ${pad(k.kind, 12)}${num(k.boxes, 7)}${num(k.coveredPct, 10)}` +
    `${num(k.fullyTransparent, 13)}${num(k.meanTopY, 10)}${num(k.maxGapM, 10)}` +
    (k.fullyTransparent === k.boxes && k.boxes > 0
      ? '   <-- EVERY BOX INVISIBLE TO PROJECTILES' : ''));
  for (const x of k.examples) {
    console.log(`      e.g. box at (${x.x}, ${x.z}) ${x.hw}x${x.hd} m rising to ${x.topY}` +
      ` over ground ${x.groundY} — masonryTopAt says -Infinity across its whole footprint`);
  }
}

/** Raw dump of every tick, used when the control fails and the probe is the suspect. */
const showControl = (t) => {
  const f = (v) => (Number.isFinite(v) ? v.toFixed(2) : '-inf');
  console.log(`    ${num('tick', 5)}${num('x1', 10)}${num('y1', 9)}${num('z1', 10)}` +
    `${num('top1', 10)}${num('off1', 8)}${num('t1', 8)}${num('gnd', 8)}${num('step', 7)}`);
  for (const s of t.samples) {
    console.log(`    ${num(s.tick, 5)}${num(s.x1.toFixed(2), 10)}${num(s.y1.toFixed(2), 9)}` +
      `${num(s.z1.toFixed(2), 10)}${num(f(s.top1), 10)}${num(s.off1, 8)}${num(s.t1, 8)}` +
      `${num(s.ground1, 8)}${num(s.step, 7)}${s.alive ? '' : '  <-- ended'}`);
  }
};

console.log('\n  positive control: arrow point blank into the curtain from 12 m');
console.log(`    muzzle (${geom.fromX.toFixed(1)}, ${geom.fromY.toFixed(1)}, ${geom.fromZ.toFixed(1)})` +
  ` -> aim (${geom.toX.toFixed(1)}, ${geom.toY.toFixed(1)}, ${geom.toZ.toFixed(1)})`);
const ctrl = await trace({ ...geom, kind: 'arrow', lofted: false, bay: probeBay, tag: 'ctrl' });
results.control = ctrl;
if (!ctrl.launched || !ctrl.latched) {
  console.error(`  CONTROL FAILED: launch=${ctrl.launched} latch=${ctrl.latched}`);
  await browser.close();
  process.exit(3);
}
console.log(`    ended on ${ctrl.end} after ${ctrl.ticks} ticks` +
  ` (masonryHits +${ctrl.masonryHitDelta})`);
if (ctrl.end !== 'MASONRY') showControl(ctrl);
if (ctrl.end !== 'MASONRY') {
  console.error('  CONTROL FAILED: an arrow fired point blank into 6 m of curtain did not ' +
    'register on masonry. The probe or the plumbing is wrong; artillery results below are void.');
  await browser.close();
  process.exit(3);
}
console.log('    control OK — masonry collision is reachable and works for this shot.');

// ---------------------------------------------------------------------------
// 1. The reported case: a stone lobbed at the wall.
// ---------------------------------------------------------------------------
const showTrace = (t, label) => {
  console.log(`\n  --- ${label} ---`);
  if (!t.launched) { console.log('    launch refused (no ballistic solution at this range)'); return; }
  if (!t.latched) { console.log('    could not latch the slot'); return; }
  console.log(`    muzzle v = ${Math.hypot(t.start.vx, t.start.vy, t.start.vz).toFixed(1)} m/s` +
    `   ended on ${t.end} after ${t.ticks} ticks`);
  console.log(`    ${num('tick', 5)}${num('y1', 9)}${num('top1', 10)}${num('top0', 10)}` +
    `${num('off0', 8)}${num('off1', 8)}${num('t', 8)}${num('gnd', 8)}${num('step', 7)}  note`);
  // Print only what matters: the approach to the wall and the end. Everything while the shot
  // is far outside the plan band is noise.
  const band = probeBay.halfThickness;
  for (const s of t.samples) {
    const near = Math.min(Math.abs(s.off0), Math.abs(s.off1)) < band + 8;
    const isLast = s === t.samples[t.samples.length - 1];
    if (!near && !isLast) continue;
    const inBand0 = Math.abs(s.off0) <= band;
    const inBand1 = Math.abs(s.off1) <= band;
    const crossed = (s.off0 > band && s.off1 < -band) || (s.off0 < -band && s.off1 > band);
    const notes = [];
    if (crossed) notes.push('STEPPED CLEAN OVER THE PLAN BAND');
    else if (inBand1) notes.push('endpoint inside plan band');
    else if (inBand0) notes.push('start inside plan band');
    if (inBand1 && s.y1 <= s.top1) notes.push('y1<=top1 SHOULD HAVE HIT');
    if (s.missed && s.alive) {
      notes.push(`SWEPT TEST WOULD HAVE HIT at ${(s.missed.f * 100).toFixed(0)}% of the step` +
        ` (off ${s.missed.off}, y ${s.missed.y} vs top ${s.missed.top}, ${s.missed.depth} m inside)`);
    }
    if (!s.alive) notes.push('<-- ended here');
    const f = (v) => (Number.isFinite(v) ? v.toFixed(2) : '-inf');
    console.log(`    ${num(s.tick, 5)}${num(s.y1.toFixed(2), 9)}${num(f(s.top1), 10)}` +
      `${num(f(s.top0), 10)}${num(s.off0, 8)}${num(s.off1, 8)}${num(s.t1, 8)}` +
      `${num(s.ground1, 8)}${num(s.step, 7)}  ${notes.join('; ')}`);
  }
};

console.log('\n=== the reported case: artillery lobbing a stone at the wall ===');
results.cases = {};

/**
 * A real catapult stands off and lobs. 180 m out, aiming at the parapet — which is what a
 * battery does when the garrison is on the wall, and is the shot the owner watched.
 */
for (const kind of KINDS) {
  for (const [label, standoff, aimAt, lofted] of [
    [`${kind} lobbed at the parapet from 180 m`, 180, 'crest', true],
    [`${kind} flat at the wall face from 180 m`, 180, 'face', false],
  ]) {
    const g2 = await page.evaluate(({ bay, standoff, aimAt }) => {
      const g = window.__game;
      const b = g.battle;
      const fx = bay.midX + bay.nx * standoff;
      const fz = bay.midZ + bay.nz * standoff;
      return {
        fromX: fx, fromZ: fz, fromY: b.groundAt(fx, fz) + 2.2,
        toX: bay.midX, toZ: bay.midZ,
        toY: aimAt === 'crest' ? bay.crestY : (bay.walkY + bay.crestY) * 0.5,
      };
    }, { bay: probeBay, standoff, aimAt });
    const t = await trace({ ...g2, kind, lofted, bay: probeBay, tag: label });
    results.cases[label] = t;
    showTrace(t, label);
  }
}

// ---------------------------------------------------------------------------
// 2. Per-kind summary
// ---------------------------------------------------------------------------
console.log('\n=== summary: which kinds stop on masonry ===');
console.log(`  ${pad('case', 52)}${pad('ended on', 16)}${num('ticks', 6)}${num('tunnelled', 10)}`);
const summary = [];
for (const [label, t] of Object.entries(results.cases)) {
  const ended = !t.launched ? 'launch refused' : !t.latched ? 'no latch' : t.end;
  const misses = (t.samples ?? []).filter((s) => s.missed && s.alive).length;
  summary.push({ label, ended, ticks: t.ticks ?? 0, tunnelledTicks: misses });
  console.log(`  ${pad(label, 52)}${pad(ended, 16)}${num(t.ticks ?? '-', 6)}` +
    `${num(misses, 10)} ticks tunnelled` +
    (ended === 'ground/other' && misses > 0 ? '   <-- PASSED THROUGH MASONRY' : ''));
}
results.summary = summary;

if (errors.length) {
  console.log('\npage errors:');
  for (const e of errors.slice(0, 20)) console.log(`  ${e}`);
}
results.pageErrors = errors;

// ---------------------------------------------------------------------------
// 2b. Shots into a TOWER.
//
// A tower is pushed into the obstacle set as a solid box projecting 3.5 m beyond the outer
// face and rising `towerRise` above the crest, but `masonryTopAt` has no tower branch at all:
// it resolves a bay and tests the curtain cross-section. So the audit above finds every tower
// only ~62 % covered. This fires into the part the heightfield cannot see — the upper storey,
// above the crest — and into the projecting outer face, and reports whether the stone stops.
// ---------------------------------------------------------------------------
console.log('\n=== shots into a tower: the part of the wall the heightfield does not model ===');
const towerGeom = await page.evaluate(() => {
  const g = window.__game;
  const b = g.battle;
  const city = g.engine.context.tryGet('city');
  const obs = (city.getObstacles ? city.getObstacles() : []).filter((o) => o.kind === 'tower');
  if (!obs.length) return null;
  // A tower in the middle of the circuit, so `bayAt` has plenty of x either side.
  const o = obs[obs.length >> 1];
  const bay = city.bayAt(o.x);
  const top = city.masonryTopAt(o.x, o.z);
  return {
    x: o.x, z: o.z, hw: o.hw, hd: o.hd, topY: o.topY,
    nx: bay ? bay.nx : 0, nz: bay ? bay.nz : 1,
    crestY: bay ? bay.crestY : 0, walkY: bay ? bay.walkY : 0,
    halfThickness: bay ? bay.halfThickness : 3,
    dx: bay ? bay.dx : 1, dz: bay ? bay.dz : 0,
    x0: bay ? bay.x0 : o.x, z0: bay ? bay.z0 : o.z,
    midX: o.x, midZ: o.z,
    groundY: b.groundAt(o.x, o.z),
    masonryTopAtCentre: Number.isFinite(top) ? +top.toFixed(2) : String(top),
  };
});
results.tower = { geom: towerGeom, cases: {} };
if (!towerGeom) {
  console.log('  no tower obstacles on this city');
} else {
  console.log(`  tower box at (${towerGeom.x.toFixed(1)}, ${towerGeom.z.toFixed(1)})` +
    ` ${towerGeom.hw.toFixed(2)} x ${towerGeom.hd.toFixed(2)} m,` +
    ` rising to ${towerGeom.topY.toFixed(2)}`);
  console.log(`    the bay under it: walkY ${towerGeom.walkY.toFixed(2)}` +
    `  crestY ${towerGeom.crestY.toFixed(2)}  halfThickness ${towerGeom.halfThickness}`);
  console.log(`    masonryTopAt at the tower's own centre: ${towerGeom.masonryTopAtCentre}` +
    `  (the obstacle says solid to ${towerGeom.topY.toFixed(2)})`);
  console.log(`    so ${(towerGeom.topY - towerGeom.crestY).toFixed(2)} m of tower stands above` +
    ` the highest thing the projectile model knows about here.`);

  /*
   * Every machine's own missile, lofted onto the tower's upper storey.
   *
   * The transparent region was a property of position, not of weapon — the audit above proves
   * it was invisible to anything — but only a projectile that actually *flies* through it can
   * demonstrate the difference, and that is what separates the machines. A stone-thrower is
   * `arc: 'high'` and comes down on a tower roof; a bolt-thrower is `arc: 'flat'` and strikes
   * the curtain face below the walk, so it never reached the hole and never showed the fault.
   */
  const towerCases = [];
  for (const kind of ['boulder', 'bolt', 'bow', 'sling', 'javelin']) {
    towerCases.push([`${kind} lofted into the tower upper storey`,
      (towerGeom.crestY + towerGeom.topY) * 0.5, kind, true]);
  }
  towerCases.push(['bolt flat into the tower upper storey',
    (towerGeom.crestY + towerGeom.topY) * 0.5, 'bolt', false]);
  for (const [label, aimY, kind, lofted] of towerCases) {
    const gm = await page.evaluate(({ t, aimY }) => {
      const g = window.__game;
      const b = g.battle;
      const standoff = t.standoff ?? 150;
      const fx = t.x + t.nx * standoff;
      const fz = t.z + t.nz * standoff;
      return {
        fromX: fx, fromZ: fz, fromY: b.groundAt(fx, fz) + 2.2,
        toX: t.x, toZ: t.z, toY: aimY,
      };
    }, { t: { ...towerGeom, standoff: kind === 'javelin' ? 28 : kind === 'bow' ? 90 : 150 }, aimY });
    const bayFrame = { ...towerGeom, halfThickness: towerGeom.hw };
    const t = await trace({ ...gm, kind, lofted, bay: bayFrame, tag: label });
    results.tower.cases[label] = t;
    const ended = !t.launched ? 'launch refused' : !t.latched ? 'no latch' : t.end;
    console.log(`    ${pad(label, 48)}${pad(ended, 15)}` +
      (ended === 'MASONRY' ? 'stopped on the tower' : 'PASSED THROUGH THE TOWER'));
  }
}

// ---------------------------------------------------------------------------
// 3. The real assault, unmodified: where does every shot actually end up?
//
// The synthetic traces above answer "what does the collision code do to a shot I aimed".
// This answers the owner's sentence. Every projectile is followed to its death and classified
// by the signed normal-offset of the point it died at, against the bay it died over:
//
//   outside   |off| > halfThickness and off > 0  — died in front of the wall, normal
//   inside    off < -halfThickness               — died BEHIND the wall, on the city side
//   in-wall   |off| <= halfThickness             — died in the cross-section, i.e. on masonry
//
// A shot that started outside and died inside crossed 6 m of curtain. If it did that without
// registering on the masonry census, it passed through the wall — which is the report.
// ---------------------------------------------------------------------------
if (!args.has('no-live')) {
  const LIVE_S = Number(args.get('seconds') ?? 100);
  console.log(`\n=== the real assault for ${LIVE_S} s: where every shot ends up ===`);
  await page.goto(`${base}/?harness=1&quality=low&autoplay=1&scenario=assault&w=640&h=400`,
    { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 240000 });
  const live = await page.evaluate(async (secs) => {
    const g = window.__game;
    const ctx = g.engine.context;
    const b = g.battle;
    const pr = ctx.get('projectiles');
    const city = ctx.tryGet('city');
    pr.debugResetCensus?.();

    // Resolved ONCE. Calling `debugProjectiles()` per death rebuilt the whole census object
    // thousands of times and made the interval too slow to run.
    const kindTable = pr.debugProjectiles ? pr.debugProjectiles().kinds.map((k) => k.kind) : [];
    const kindName = (ki) => kindTable[ki] ?? `#${ki}`;
    // Signed normal-offset of a point against the bay it stands over, or null off the circuit.
    const offOf = (x, z) => {
      const bay = city?.bayAt ? city.bayAt(x) : undefined;
      if (!bay) return null;
      const t = (x - bay.x0) * bay.dx + (z - bay.z0) * bay.dz;
      const px = bay.x0 + bay.dx * t;
      const pz = bay.z0 + bay.dz * t;
      return { off: (x - px) * bay.nx + (z - pz) * bay.nz, half: bay.halfThickness };
    };

    const tracked = new Map();
    const tally = new Map();
    const bump = (kind, field) => {
      if (!tally.has(kind)) {
        tally.set(kind, { kind, died: 0, outside: 0, inWall: 0, inside: 0,
          offCircuit: 0, crossedIn: 0 });
      }
      tally.get(kind)[field]++;
    };

    const ticks = Math.round(secs * 30);
    for (let n = 0; n < ticks; n++) {
      g.advance(1 / 30);
      for (let i = 0; i < pr.highWater; i++) {
        if (pr.alive[i] === 1) {
          const o = offOf(pr.px[i], pr.pz[i]);
          const prev = tracked.get(i);
          tracked.set(i, {
            ki: pr.kindIdx[i],
            startedOutside: prev ? prev.startedOutside
              : (o ? o.off > o.half : true),
            off: o ? o.off : null,
            half: o ? o.half : null,
            x: pr.px[i], y: pr.py[i], z: pr.pz[i],
          });
        } else if (tracked.has(i)) {
          const t = tracked.get(i);
          tracked.delete(i);
          const kind = kindName(t.ki);
          bump(kind, 'died');
          if (t.off === null) bump(kind, 'offCircuit');
          else if (t.off < -t.half) {
            bump(kind, 'inside');
            if (t.startedOutside) bump(kind, 'crossedIn');
          } else if (Math.abs(t.off) <= t.half) bump(kind, 'inWall');
          else bump(kind, 'outside');
        }
      }
    }
    return {
      census: pr.debugProjectiles ? pr.debugProjectiles().kinds : null,
      masonryHits: pr.masonryHits,
      fate: [...tally.values()],
    };
  }, LIVE_S);
  results.live = live;

  console.log(`  masonryHits over the interval: ${live.masonryHits}`);
  if (live.census) {
    console.log(`\n  ${pad('kind', 10)}${num('launched', 10)}${num('hitMan', 8)}` +
      `${num('intoMasonry', 13)}${num('intoGround', 12)}${num('masonry%', 10)}`);
    for (const k of live.census) {
      if (!k.launched) continue;
      const pct = k.launched ? (100 * k.intoMasonry / k.launched).toFixed(1) : '-';
      console.log(`  ${pad(k.kind, 10)}${num(k.launched, 10)}${num(k.hitMan, 8)}` +
        `${num(k.intoMasonry, 13)}${num(k.intoGround, 12)}${num(pct, 10)}` +
        (k.launched > 20 && k.intoMasonry === 0
          ? '   <-- NEVER ONCE STOPPED ON MASONRY' : ''));
    }
  }
  console.log(`\n  where each kind's shots died, by offset from the wall centreline:`);
  console.log(`  ${pad('kind', 10)}${num('died', 8)}${num('outside', 9)}${num('in-wall', 9)}` +
    `${num('inside', 8)}${num('crossedIn', 11)}${num('offCirc', 9)}`);
  for (const f of live.fate) {
    console.log(`  ${pad(f.kind, 10)}${num(f.died, 8)}${num(f.outside, 9)}${num(f.inWall, 9)}` +
      `${num(f.inside, 8)}${num(f.crossedIn, 11)}${num(f.offCircuit, 9)}` +
      (f.crossedIn > 0 ? '   <-- crossed the curtain and died on the city side' : ''));
  }
}

if (JSON_OUT) {
  await writeFile(path.resolve(ROOT, JSON_OUT), JSON.stringify(results, null, 2));
  console.log(`\nwrote ${JSON_OUT} (with live)`);
}
await browser.close();
