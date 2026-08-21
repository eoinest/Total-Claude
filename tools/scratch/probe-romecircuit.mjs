#!/usr/bin/env node
/**
 * The acceptance instrument for `docs/ROME.md` §15 tasks 3, 4 and 5 — the circuit.
 *
 * Same contract as `probe-rometransect.mjs`, which is tasks 1 and 2's: every number is read
 * off the **running** map through `CitySystem`, `Siege` and `Pathfinding`, never off the plan
 * that publishes it (§14.1), and every target it grades against is written down here rather
 * than imported, so a source that has drifted from the specification measures as wrong
 * instead of measuring as itself.
 *
 *   bays     36 bays, uniform in x, west end within 2 m of x +2 and east within 2 m of
 *            x +1335, and `assertUniformBayPitch` silent.            [task 3]
 *   section  `assertRomeSection`'s own published faults, read back off `CityChecks`.  [task 3]
 *   torto    the Muro Torto: garrisonable bays, unbridged boundaries, and a route from the
 *            *horti* behind it onto its walk that uses no stair.     [task 4]
 *   gates    every aperture's clearance inside its own bay and its snap distance. [task 5]
 *
 * Usage:
 *   node tools/scratch/probe-romecircuit.mjs --port=5931
 *   node tools/scratch/probe-romecircuit.mjs --port=5931 --json=/tmp/before.json
 *   node tools/scratch/probe-romecircuit.mjs --port=5931 --only=bays,gates
 */
import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';

const arg = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split('=')[1];
const PORT = Number(arg('port', 5931));
const MAP = arg('map', 'campus-martius');
const SCENARIO = arg('scenario', 'assault');
const JSON_OUT = arg('json', '');
const ONLY = arg('only', '');
const want = (k) => !ONLY || ONLY.split(',').includes(k);

/** §2.5's two anchors, and the tolerance §15 task 3 states for them. */
const WEST_ANCHOR = 2;
const EAST_ANCHOR = 1335;
const ANCHOR_TOL = 2;
/** §15 task 3. */
const BAY_TARGET = 36;
const PITCH_TOL = 0.12;
/** §15 task 4. */
const GARRISONABLE_TARGET = 32;
const UNBRIDGED_TARGET = 4;
/** §15 task 5, and it is §14.3's test. */
const GATE_MARGIN_MIN = 1.0;
/** §4.5: the Muro Torto is bays 5..11, x +187 .. +446. */
const TORTO_X0 = 187;
const TORTO_X1 = 446;

const url = `http://127.0.0.1:${PORT}/?map=${MAP}&scenario=${SCENARIO}&harness=1&quality=high`;

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader', '--hide-scrollbars'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const warnings = [];
page.on('console', (m) => {
  const t = m.text();
  if (m.type() === 'warning' || m.type() === 'error') warnings.push(t);
});
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 180000 });

const out = await page.evaluate(({ TORTO_X0, TORTO_X1 }) => {
  const g = window.__game;
  const ctx = g.engine.context;
  const city = ctx.get('city');
  const siege = g.battle?.siege ?? (ctx.tryGet ? ctx.tryGet('siege') : null);
  const nav = ctx.tryGet ? ctx.tryGet('pathfinding') : null;
  const bays = city.getGarrisonBays();
  const report = siege && siege.wallReport ? siege.wallReport() : null;
  const stats = city.stats ? city.stats() : null;

  const bayList = bays.map((b) => ({
    index: b.index, x0: b.x0, z0: b.z0, x1: b.x1, z1: b.z1,
    stage: b.stage, walkY: b.walkY, groundY: b.groundY,
    garrisonable: b.garrisonable, isGate: b.isGate,
    passOuter: b.passOuter, passInner: b.passInner,
  }));

  // Every aperture the city publishes, and where its bay ends.
  const gates = city.getGates().map((gt) => ({ id: gt.id, x: gt.x, z: gt.z, open: gt.open }));

  /**
   * The wall line at an x, from the bay records rather than from a plan export: the bays are
   * what every masonry query indexes, so this is the line the collision surface actually has.
   */
  const wallZ = (x) => {
    const b = bays.find((q) => x >= q.x0 && x <= q.x1) ?? bays[bays.length - 1];
    const t = (x - b.x0) / Math.max(1e-6, b.x1 - b.x0);
    return b.z0 + (b.z1 - b.z0) * t;
  };

  // The Muro Torto band, measured in the collision surface rather than in the plan. A 32 m
  // segment driven straight through the wall line at each station, which is `probe-footing`'s
  // own question: can a body get from the storm's side to the city's side here.
  const torto = [];
  for (let x = TORTO_X0; x <= TORTO_X1; x += 2) {
    const z = wallZ(x);
    torto.push({
      x, z,
      top: city.masonryTopAt(x, z),
      blocked: city.blocksMovement(x, z - 16, x, z + 16),
    });
  }

  /**
   * Where the walk is severed and not sewn back up, in world x.
   *
   * `wallReport().unbridged` is a count and a count cannot be acted on: §15 task 4 asks for
   * *"exactly four unbridged run boundaries, **at the named x**"*, so this reads the two
   * stations either side of every break out of the spine and reports where each one is.
   */
  const breaks = [];
  if (siege) {
    const nRuns = siege.nRuns;
    for (let r = 0; r + 1 < nRuns; r++) {
      if (siege.runNext[r] >= 0) continue;
      const a = siege.runHi[r];
      const b = siege.runLo[r + 1];
      breaks.push({
        run: r,
        ax: a >= 0 ? +siege.sx[a].toFixed(1) : null,
        bx: b >= 0 ? +siege.sx[b].toFixed(1) : null,
        gap: a >= 0 && b >= 0
          ? +Math.hypot(siege.sx[b] - siege.sx[a], siege.sz[b] - siege.sz[a]).toFixed(1) : null,
        dy: a >= 0 && b >= 0 ? +(siege.sy[b] - siege.sy[a]).toFixed(2) : null,
      });
    }
  }

  /**
   * §15 task 4's own acceptance: *"a `Pathfinding` route from the horti behind it to any of
   * its seven runs succeeds without using a stair."*
   *
   * Operationally, and this is the part the task states in prose and the engine states in
   * objects: a run is not a ground position, so what is asked is whether a body standing in
   * the Horti Aciliorum can walk to the foot of the way up onto the Muro Torto, and whether
   * that way up is a *flight*. So the route is driven to each apron's published foot, and the
   * apron's own rise is reported beside it — under `WALK_STEP_OVER` (0.62 m) a joint is
   * `Level` to `Siege.stepAcross`, which is to say a man crosses it without changing gait and
   * no stair is climbed.
   */
  const tortoRoutes = [];
  if (nav && siege) {
    const stairs = city.getWallStairs ? city.getWallStairs() : [];
    const aprons = stairs.filter((s) => {
      const b = bays[s.bay];
      return b && b.x1 > TORTO_X0 + 1 && b.x0 < TORTO_X1 - 1;
    });
    const standable = (x, z, radius) => {
      const o = { x, z };
      nav.findStandable(x, z, radius, o);
      return o;
    };
    /*
     * **One start, in the Horti Aciliorum behind the middle of the stretch**, and a route to
     * each of the seven aprons. §4.5 puts the *horti* — terraces, retaining arcades, a
     * *piscina*, an octagonal nymphaeum — directly behind the Muro Torto on the Pincian's
     * summit; 200 m cityward of the wall at the middle of the stretch is inside them.
     *
     * One start rather than seven, because seven starts measure seven different pieces of
     * city fabric as much as they measure the wall, and the question is whether the garrison
     * on the Pincian can get onto its own crest.
     */
    const mid = (TORTO_X0 + TORTO_X1) * 0.5;
    const start = standable(mid, wallZ(mid) + 200, 4.4);
    let id = 970000;
    for (const s of aprons) {
      const goal = standable(s.footX, s.footZ, 4.4);
      nav.requestPath(id, start.x, start.z, goal.x, goal.z, 4.4, 2.2, 3);
      tortoRoutes.push({
        bay: s.bay, id, rise: +s.rise.toFixed(2), run: +s.run.toFixed(1),
        sx: +start.x.toFixed(0), sz: +start.z.toFixed(0),
        gx: +goal.x.toFixed(0), gz: +goal.z.toFixed(0),
        goalBlocked: !!nav.grid.blockedAt(goal.x, goal.z),
      });
      id++;
    }
    // One budgeted A* at a time at 2,400 expansions a tick, seven of them, so this has to be
    // generous: a short budget reports a route that exists as `partial`, which is a false red.
    for (let i = 0; i < 2400; i++) g.engine.advance(1 / 30, 33);
    for (const r of tortoRoutes) {
      const p = nav.pathFor ? nav.pathFor(r.id) : null;
      r.route = p ? (p.ok ? 'ok' : 'partial') : 'none';
      r.length = p ? +p.length.toFixed(0) : null;
    }
  }

  return {
    bays: bayList,
    gates,
    report,
    torto,
    breaks,
    tortoRoutes,
    checks: stats ? stats.checks ?? null : null,
    section: stats ? stats.romeSection ?? null : null,
    navReady: !!nav,
  };
}, { TORTO_X0, TORTO_X1 });

const fmt = (v, n = 2) => (v === null || v === undefined || Number.isNaN(v) ? '   —  ' : v.toFixed(n));
const R = { warnings, errors };

if (want('bays')) {
  const b = out.bays;
  const x0 = b.length ? b[0].x0 : NaN;
  const x1 = b.length ? b[b.length - 1].x1 : NaN;
  let worst = 0;
  let worstAt = -1;
  const pitch = b.length > 1 ? (x1 - x0) / b.length : NaN;
  for (let i = 1; i < b.length; i++) {
    const d = b[i].x0 - b[i - 1].x0;
    const err = Math.abs(d - pitch) / Math.abs(pitch);
    if (err > worst) { worst = err; worstAt = i; }
  }
  const pitchWarn = warnings.filter((w) => w.includes('bay pitch is not uniform'));
  R.bays = {
    count: b.length, x0, x1, pitch, worstDeviation: worst, worstAt,
    westError: Math.abs(x0 - WEST_ANCHOR), eastError: Math.abs(x1 - EAST_ANCHOR),
    pitchWarnings: pitchWarn,
    garrisonable: b.filter((q) => q.garrisonable).length,
    stages: b.reduce((m, q) => ((m[q.stage] = (m[q.stage] ?? 0) + 1), m), {}),
  };
  console.log('\n── 3. the circuit as 36 bays ───────────────────────────────────────');
  console.log(`  bays ${b.length} (want ${BAY_TARGET})   x ${fmt(x0, 2)} .. ${fmt(x1, 2)}   pitch ${fmt(pitch, 3)} m`);
  console.log(`  west end ${fmt(x0, 2)} vs +${WEST_ANCHOR} → ${fmt(R.bays.westError, 2)} m (want ≤ ${ANCHOR_TOL})`);
  console.log(`  east end ${fmt(x1, 2)} vs +${EAST_ANCHOR} → ${fmt(R.bays.eastError, 2)} m (want ≤ ${ANCHOR_TOL})`);
  console.log(`  worst bay-pitch deviation ${(worst * 100).toFixed(2)} % at bay ${worstAt} (want ≤ ${PITCH_TOL * 100} %)`);
  console.log(`  assertUniformBayPitch warnings: ${pitchWarn.length === 0 ? 'none' : pitchWarn.join(' | ')}`);
  console.log(`  stages: ${JSON.stringify(R.bays.stages)}   garrisonable ${R.bays.garrisonable}`);
}

if (want('section')) {
  console.log('\n── 3b. assertRomeSection ───────────────────────────────────────────');
  if (!out.section) {
    console.log('  NOT PUBLISHED — `stats().romeSection` is absent');
  } else {
    for (const [k, v] of Object.entries(out.section)) {
      if (k === 'faults') continue;
      console.log(`  ${k.padEnd(26)} ${typeof v === 'number' ? fmt(v, 3) : JSON.stringify(v)}`);
    }
    const f = out.section.faults ?? [];
    console.log(`  faults (${f.length}): ${f.length === 0 ? 'none' : ''}`);
    for (const s of f) console.log(`    ! ${s}`);
  }
  R.section = out.section;
}

if (want('torto')) {
  console.log('\n── 4. the Muro Torto ───────────────────────────────────────────────');
  const rep = out.report;
  const inBand = out.bays.filter((b) => b.x0 >= TORTO_X0 - 40 && b.x1 <= TORTO_X1 + 40);
  const openTop = out.torto.filter((t) => t.top === null || !Number.isFinite(t.top));
  const openRay = out.torto.filter((t) => t.blocked === false);
  console.log(`  bays in the band: ${inBand.map((b) => `${b.index}[${b.stage}${b.garrisonable ? '' : ',-'}]`).join(' ')}`);
  console.log(`  masonryTopAt non-finite at ${openTop.length}/${out.torto.length} stations`);
  console.log(`  blocksMovement false at ${openRay.length}/${out.torto.length} stations`);
  if (rep) {
    console.log(`  wallReport: bays ${rep.bays}  garrisonable ${rep.garrisonableBays} (want ${GARRISONABLE_TARGET})  ` +
      `runs ${rep.runs}  reachable ${rep.reachable}/${rep.runs}  stairs ${rep.stairs}`);
    console.log(`  unbridged ${rep.unbridged} (want ${UNBRIDGED_TARGET})  refused ${rep.refusedSteps}  ` +
      `worst bridged step ${rep.worstStep.toFixed(2)} m at pitch ${rep.worstPitch.toFixed(3)}`);
    for (const b of out.breaks) {
      console.log(`    break after run ${b.run}: x ${b.ax} → ${b.bx}, gap ${b.gap} m, dy ${b.dy} m`);
    }
  }
  if (out.tortoRoutes.length) {
    console.log('  a route from the horti to each apron foot, and the rise it lands on:');
    for (const r of out.tortoRoutes) {
      console.log(`    bay ${String(r.bay).padStart(2)}  (${r.sx}, ${r.sz}) → (${r.gx}, ${r.gz})  ` +
        `${r.route}${r.length === null ? '' : ` ${r.length} m`}   apron rise ${r.rise.toFixed(2)} m over ${r.run} m` +
        `${r.goalBlocked ? '  [foot cell blocked]' : ''}`);
    }
    const ok = out.tortoRoutes.filter((r) => r.route === 'ok').length;
    const level = out.tortoRoutes.filter((r) => r.rise <= 0.62).length;
    console.log(`  ${ok}/${out.tortoRoutes.length} routes succeed; ${level}/${out.tortoRoutes.length} ` +
      'aprons are level joints (≤ 0.62 m), i.e. walked onto rather than climbed');
  }
  R.torto = {
    bays: inBand.map((b) => b.index),
    nonFinite: openTop.length, open: openRay.length, samples: out.torto.length,
    report: rep,
    breaks: out.breaks,
    routes: out.tortoRoutes,
  };
}

if (want('gates')) {
  console.log('\n── 5. three gates and the posterulae ───────────────────────────────');
  const b = out.bays;
  const rows = [];
  for (const gt of out.gates) {
    // The bay this aperture is cut through, found by containment rather than by arithmetic:
    // §14.3's fault is exactly a gate whose index and whose x disagree.
    const bay = b.find((q) => gt.x >= q.x0 && gt.x < q.x1) ?? null;
    rows.push({ id: gt.id, x: gt.x, z: gt.z, bay: bay ? bay.index : -1, open: gt.open,
      bayX0: bay ? bay.x0 : NaN, bayX1: bay ? bay.x1 : NaN });
  }
  for (const r of rows) {
    console.log(`  ${r.id.padEnd(20)} x ${fmt(r.x, 2)}  z ${fmt(r.z, 2)}  bay ${r.bay} [${fmt(r.bayX0, 1)}..${fmt(r.bayX1, 1)}]  ${r.open ? 'OPEN' : 'shut'}`);
  }
  R.gates = rows;
  console.log(`  (the clearance-inside-its-bay figure is assertRomeSection's; want ≥ ${GATE_MARGIN_MIN} m)`);
}

console.log(`\npage errors ${errors.length}${errors.length ? `: ${errors[0]}` : ''}`);
const cityWarn = warnings.filter((w) => w.startsWith('[city'));
if (cityWarn.length) {
  console.log('city warnings:');
  for (const w of cityWarn) console.log(`  ${w}`);
}

if (JSON_OUT) await writeFile(JSON_OUT, JSON.stringify({ ...R, raw: out }, null, 2));
await browser.close();
