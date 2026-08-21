#!/usr/bin/env node
/**
 * The acceptance instrument for `docs/ROME.md` §15 tasks 1 and 2 — the ground.
 *
 * Five measurements, each of which the task list names as the thing that closes it. Every
 * one is taken off the *running* map through `TerrainSystem.heightAt`, `CitySystem` and
 * `Siege`, never off the plan that publishes it (§14.1), and every target this file compares
 * against is written down **here** rather than imported, so a source that has drifted from
 * the specification is measured as wrong instead of measured as itself.
 *
 *   tiber    the twelve survey points of §3.2, projected through `city/rome/survey.ts`'s own
 *            `worldOf`, against `riverCentreX(z)`. Task 1 wants worst error <= 25 world m.
 *   relief   `heightAt` along the published wall line at 5 m, against §3.5's seven-band
 *            staircase. Task 2 wants +-1.5 m at every station.
 *   bench    how wide the graded ground under the wall is, per station. Task 2 wants >= 40 m
 *            under 100 % of them, on Carthage's `WALL_BENCH_HALF = 40` pattern.
 *   walk     the bay-to-bay `walkY` step. Task 2 wants the worst under 6 m against 28.39.
 *   deploy   water and slope inside the two deployment masks. Tasks 1 and 2 both want none;
 *            `tools/probe-ground.mjs` carries the same audit for the graded shot list.
 *
 * **Why the twelve points are re-projected rather than read.** `terrain/topography.ts`
 * cannot import `city/rome/survey.ts` — `survey.ts`'s `GATE_X` is the fixed point of
 * `roadCentreX(crestZAt(x))`, both of which live in `topography.ts`, so the dependency only
 * runs one way. The river's polyline therefore has to be stored in `topography.ts` already
 * projected, in world metres, which is exactly the kind of transcription that rots. This
 * probe is the thing that stops it rotting: it starts from latitude and longitude, runs them
 * through the survey's own affine map, and fails if the stored table has drifted.
 *
 * Usage:
 *   node tools/scratch/probe-rometransect.mjs --port=5941
 *   node tools/scratch/probe-rometransect.mjs --port=5941 --json=/tmp/before.json
 *   node tools/scratch/probe-rometransect.mjs --port=5941 --only=tiber,relief
 */
import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';

const arg = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split('=')[1];
const PORT = Number(arg('port', 5941));
const MAP = arg('map', 'campus-martius');
const SCENARIO = arg('scenario', 'assault');
const JSON_OUT = arg('json', '');
const ONLY = arg('only', '');
const want = (k) => !ONLY || ONLY.split(',').includes(k);

/**
 * The Tiber, as latitude and longitude, in the order §3.2 lists it.
 *
 * These are the twelve of `tools/scratch/rome-geo.mjs`'s eighteen that the specification
 * kept: a course from above the Pons Milvius to below the Aventine, monotone in z, which is
 * what lets it be a function of z at all.
 */
const TIBER_LATLON = [
  [41.9450, 12.4600], [41.9352, 12.4670], [41.9270, 12.4700], [41.9200, 12.4712],
  [41.9130, 12.4718], [41.9052, 12.4723], [41.9013, 12.4665], [41.8965, 12.4640],
  [41.8930, 12.4700], [41.8905, 12.4778], [41.8820, 12.4760], [41.8700, 12.4720],
];
/** The survey frame's origin and its metres-per-degree, from `docs/ROME.md` §2.3. */
const LAT0 = 41.8925;
const LON0 = 12.4823;
const MLAT = 111132;
const MLON = 82857;

/**
 * §3.5's relief, as knots in (x, metres above the regional plain).
 *
 * The table's seven bands overlap once — "+100 … +250 | 0 → 2" and "+187 … +446 | 2 → 38"
 * both claim x 187…250 — and the Muro Torto row is the one with arithmetic attached to it
 * ("36 m over 259 world m = 1:7.2 built"), so its start is taken as the precise one and the
 * neck's end as the loose one. The knots are therefore the band ends, read down the "rise
 * above the plain" column, which §3.5's own header says is the authoritative one: *"Heights
 * are above `WATER_LEVEL`-datum ground, i.e. add them to `regionalPlain(x, z)`."*
 */
const RELIEF_KNOTS = [
  [2, 0], [100, 0], [187, 2], [446, 38], [620, 43], [790, 23], [1050, 36], [1335, 38],
];
const reliefRise = (x) => {
  if (x <= RELIEF_KNOTS[0][0]) return RELIEF_KNOTS[0][1];
  for (let i = 1; i < RELIEF_KNOTS.length; i++) {
    const [x0, y0] = RELIEF_KNOTS[i - 1];
    const [x1, y1] = RELIEF_KNOTS[i];
    if (x <= x1) return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
  }
  return RELIEF_KNOTS[RELIEF_KNOTS.length - 1][1];
};

/** §3.4: the datum and the regional tilt, which are already the real ones and do not move. */
const regionalPlain = (x, z) => 12.2 + x * 0.0020 + z * 0.0026;
/** `src/terrain/topography.ts`. Water is drawn wherever the ground is under this. */
const WATER_LEVEL = 5.0;
/** `src/sim/Obstacles.ts`. Above this gradient the pathfinder refuses the cell outright. */
const ROUGH_SLOPE_IMPASSABLE = 0.62;
/** `src/city/carthage/topography.ts`. The bench Rome is being given one of. */
const WALL_BENCH_HALF = 40;

const token = Buffer.from(JSON.stringify({ map: MAP, scenario: SCENARIO })).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const url = `http://127.0.0.1:${PORT}/?harness=1&w=1280&h=720&quality=ultra&scenario=${SCENARIO}&battle=${token}`;
const probe = await fetch(`http://127.0.0.1:${PORT}/src/main.ts`).catch(() => null);
if (!probe || !probe.ok) { console.error('no dev server on', PORT); process.exit(2); }

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForFunction(() => window.__game && window.__game.ready, null, { timeout: 240000 });

const out = await page.evaluate(async (K) => {
  const g = window.__game;
  const terrain = g.engine.ctx.get('terrain');
  const city = g.engine.ctx.tryGet('city');
  const siege = g.battle?.elevation ?? g.battle?.siege ?? null;
  const topo = await import('/src/terrain/topography.ts');
  const survey = await import('/src/city/rome/survey.ts');
  const circuit = await import('/src/city/rome/circuit.ts');

  const h = (x, z) => terrain.heightAt(x, z);
  /**
   * The published wall line. `wallCrestZ` is the export §14.5 asks every consumer to share;
   * before task 2 it was `crestZAt` under another name, and reading it by name here means
   * this probe follows the line wherever the source moves it instead of assuming one.
   */
  const wallZ = (x) => circuit.wallCrestZ(x);
  const xMin = circuit.WALL_X_MIN;
  const xMax = circuit.WALL_X_MAX;

  // ---- tiber ----------------------------------------------------------------
  const tiber = K.TIBER_LATLON.map(([lat, lon]) => {
    const e = (lon - K.LON0) * K.MLON;
    const n = (lat - K.LAT0) * K.MLAT;
    const w = survey.worldOf(e, n);
    const model = topo.riverCentreX(w.z);
    return {
      lat, lon, e: +e.toFixed(0), n: +n.toFixed(0),
      x: +w.x.toFixed(1), z: +w.z.toFixed(1),
      model: +model.toFixed(1), err: +(model - w.x).toFixed(1),
    };
  });

  // ---- relief, and the bench under it ---------------------------------------
  // §3.5's table is written for the redesigned circuit, x +2 … +1335. Sample its whole
  // domain and the wall's own span separately: the first says whether the ground was built
  // to the specification, the second whether the wall is standing on it.
  const relief = [];
  for (let x = 2; x <= 1335; x += 5) {
    const z = wallZ(x);
    const ground = h(x, z);
    // `target` and `err` are filled in on the node side: `page.evaluate` cannot carry a
    // function across, and the §3.5 knots must have exactly one definition (see above).
    // Width of the ground that is level with the wall's own footing, measured across the
    // line. 1.5 m is the same tolerance the relief is held to, so "on the bench" and "built
    // to the table" are the same claim measured in two directions.
    let lo = 0;
    let hi = 0;
    for (let d = 1; d <= 90; d++) { if (Math.abs(h(x, z - d) - ground) > 1.5) break; lo = d; }
    for (let d = 1; d <= 90; d++) { if (Math.abs(h(x, z + d) - ground) > 1.5) break; hi = d; }
    relief.push({
      x, z: +z.toFixed(1), ground: +ground.toFixed(2), target: 0, err: 0,
      benchLo: lo, benchHi: hi, bench: lo + hi,
      onWall: x >= xMin && x <= xMax,
    });
  }

  // ---- walk -----------------------------------------------------------------
  const bays = city ? city.getGarrisonBays() : [];
  const walkY = bays.map((b) => b.walkY ?? 0);
  const steps = walkY.slice(1).map((v, i) => +(v - walkY[i]).toFixed(2));
  let worstStep = 0;
  let worstStepAt = 0;
  /*
   * And the same step counted only where both sides carry a wall-walk.
   *
   * `walkY` on an unfinished bay is not a construction level, it is the top of whatever is
   * standing — `unfinishedTopAt` puts a footing's pour 2.35 m over the *low* end of the bay
   * — so a footing beside a finished curtain reports a step that is four metres of missing
   * masonry plus a bay's worth of grade, and no man can be on either side of it. §4.1's
   * 28.39 m at x -524.5 was exactly that: bay 2, a footing, against bay 3, finished, across
   * the west-end cliff. Both numbers are reported because the published one is the
   * all-bays one and the one that describes the walk is this.
   */
  let worstWalkStep = 0;
  let worstWalkStepAt = 0;
  let worstWalkStepBays = '';
  // Both sides built to the full 6.5 m. A footing's top is a 1.35 m plinth course and a
  // half-built bay's is 3.4 m of rubble, so a step across either is mostly masonry that was
  // never laid rather than ground: bay 11 -> 12 is 3.13 m of grade and 5.15 m of missing
  // curtain. That is `bayStage`'s doing (§4.7, §15 task 7), not the heightfield's.
  const carries = (b) => b.stage === 'finished' || b.stage === 'no-parapet';
  for (let i = 0; i < steps.length; i++) {
    if (Math.abs(steps[i]) > Math.abs(worstStep)) { worstStep = steps[i]; worstStepAt = bays[i + 1].x0; }
    if (!carries(bays[i]) || !carries(bays[i + 1])) continue;
    if (Math.abs(steps[i]) > Math.abs(worstWalkStep)) {
      worstWalkStep = steps[i];
      worstWalkStepAt = bays[i + 1].x0;
      worstWalkStepBays = `${bays[i].index}(${bays[i].stage}) -> ${bays[i + 1].index}(${bays[i + 1].stage})`;
    }
  }
  const stageAt = bays.map((b) => `${b.index}:${b.stage}`);

  /**
   * The bench under the *stations*, which is what the acceptance actually asks for.
   *
   * Measured twice on purpose. `drawn` reads `CitySystem.walkableTopAt` — the surface the
   * masonry presents — and `stationY` reads `Siege.sy`, the height the man is put at. Those
   * differ by up to 3.16 m on this circuit because `buildSpine` clips a bay's west end by
   * `towerHalf + 0.55` and its east by 0.55, which is a recorded defect belonging to
   * somebody else; saying which one a bench measurement was taken against is the only way
   * the two passes do not confound each other.
   */
  const stations = [];
  if (siege) {
    for (let i = 0; i < siege.nStations; i++) {
      const sx = siege.sx[i];
      const sz = siege.sz[i];
      const ground = h(sx, sz);
      let lo = 0;
      let hi = 0;
      for (let d = 1; d <= 90; d++) { if (Math.abs(h(sx, sz - d) - ground) > 1.5) break; lo = d; }
      for (let d = 1; d <= 90; d++) { if (Math.abs(h(sx, sz + d) - ground) > 1.5) break; hi = d; }
      const drawn = city && city.walkableTopAt ? city.walkableTopAt(sx, sz, siege.sy[i] + 1.6) : NaN;
      stations.push({
        i, x: +sx.toFixed(1), z: +sz.toFixed(1), ground: +ground.toFixed(2),
        bench: lo + hi, dead: !!siege.sDead[i],
        stationY: +siege.sy[i].toFixed(2),
        offDrawn: Number.isFinite(drawn) ? +(siege.sy[i] - drawn).toFixed(2) : null,
      });
    }
  }

  // ---- wetunits ---------------------------------------------------------------
  /*
   * How much of the order of battle is standing in the Tiber.
   *
   * §3.2: *"Do not attempt this change without also moving the deployment box; a cohort
   * deployed in the Tiber is the failure mode."* The remedy it names does not reach: the
   * deployment *masks* flatten ground and exclude vegetation, and `sim/scenario.ts` places
   * every unit at a fixed x about zero without reading them. So this asks the men.
   *
   * Three categories, because they are three different problems. "wet" is standing below
   * `WATER_LEVEL` and is a bug in any tree. "far bank" is dry ground on the wrong side of
   * 94 m of unfordable water — §6.6's ager Vaticanus, from which the battle cannot be
   * joined. "off the parade ground" is outside both deployment masks, which means ungraded
   * ground with trees standing in the formation.
   */
  const wetunits = [];
  if (g.battle && g.battle.pool) {
    const pool = g.battle.pool;
    const units = new Map();
    for (let i = 0; i < pool.count; i++) {
      if (pool.alive && !pool.alive[i]) continue;
      const ux = pool.x[i];
      const uz = pool.z[i];
      const u = pool.unit ? pool.unit[i] : -1;
      let r = units.get(u);
      if (!r) { r = { unit: u, men: 0, wet: 0, farBank: 0, offGround: 0, x: 0, z: 0 }; units.set(u, r); }
      r.men++; r.x += ux; r.z += uz;
      if (h(ux, uz) < K.WATER_LEVEL) r.wet++;
      if (ux < topo.riverBankX(uz, -1)) r.farBank++;
      if (Math.max(topo.germanDeployMask(ux, uz), topo.romanDeployMask(ux, uz)) < 0.02) r.offGround++;
    }
    for (const r of units.values()) {
      r.x = +(r.x / r.men).toFixed(0);
      r.z = +(r.z / r.men).toFixed(0);
      wetunits.push(r);
    }
    wetunits.sort((a, b) => a.x - b.x);
  }

  // ---- funnel ---------------------------------------------------------------
  // Where the water actually ends, row by row. §3.2's second consequence is that the
  // corrected river turns the approach into a funnel, and every deployment box, ford and
  // wall terminus on the west side of this map has to be sized against these numbers
  // rather than against the centreline.
  const funnel = [];
  for (let z = -400; z <= 600; z += 20) {
    let east = null;
    let west = null;
    for (let x = -1390; x <= 700; x += 2) {
      if (h(x, z) < K.WATER_LEVEL) { if (west === null) west = x; east = x; }
    }
    funnel.push({ z, centre: +topo.riverCentreX(z).toFixed(1), west, east });
  }

  // ---- deploy ---------------------------------------------------------------
  // The masks are smooth, so "inside" needs a threshold. 0.02 is ten times the 0.002 the
  // heightfield itself uses to decide whether a cell is worth flattening, which makes this
  // strictly the stronger claim: everywhere the terrain build thought it was levelling.
  const deploy = { german: null, roman: null };
  for (const [name, mask] of [['german', topo.germanDeployMask], ['roman', topo.romanDeployMask]]) {
    let cells = 0;
    let wet = 0;
    let steep = 0;
    let minH = Infinity;
    let maxSlope = 0;
    let wettest = null;
    let steepest = null;
    for (let z = -400; z <= 400; z += 4) {
      for (let x = -700; x <= 700; x += 4) {
        const m = mask(x, z);
        if (m < 0.02) continue;
        cells++;
        const hh = h(x, z);
        if (hh < minH) minH = hh;
        if (hh < K.WATER_LEVEL) { wet++; if (!wettest || hh < wettest.h) wettest = { x, z, h: +hh.toFixed(2) }; }
        const gx = (h(x + 4, z) - h(x - 4, z)) / 8;
        const gz = (h(x, z + 4) - h(x, z - 4)) / 8;
        const s = Math.hypot(gx, gz);
        if (s > maxSlope) { maxSlope = s; steepest = { x, z, s: +s.toFixed(3) }; }
        if (s > K.ROUGH_SLOPE_IMPASSABLE) steep++;
      }
    }
    deploy[name] = {
      cells, wet, steep, minH: +minH.toFixed(2), maxSlope: +maxSlope.toFixed(3), wettest, steepest,
    };
  }

  return {
    tiber, relief, stations, deploy, funnel, wetunits,
    wall: {
      xMin: +xMin.toFixed(1), xMax: +xMax.toFixed(1), bays: bays.length,
      walkYMin: walkY.length ? +Math.min(...walkY).toFixed(2) : null,
      walkYMax: walkY.length ? +Math.max(...walkY).toFixed(2) : null,
      worstStep, worstStepAt: +worstStepAt.toFixed(1), steps, stageAt,
      worstWalkStep, worstWalkStepAt: +worstWalkStepAt.toFixed(1), worstWalkStepBays,
    },
    report: siege ? (() => {
      const w = siege.wallReport();
      return {
        runs: w.runs, stations: w.stations, reachable: w.reachable, stairs: w.stairs,
        source: w.source, links: w.links, unbridged: w.unbridged, refusedSteps: w.refusedSteps,
        worstStep: +w.worstStep.toFixed(2), worstPitch: +w.worstPitch.toFixed(3),
      };
    })() : null,
  };
}, {
  TIBER_LATLON, LAT0, LON0, MLAT, MLON, WATER_LEVEL, ROUGH_SLOPE_IMPASSABLE,
});

// `page.evaluate` cannot take a function in an object, so the relief target is recomputed
// here from the same knots and folded back in. Same arithmetic, one definition, above.
for (const r of out.relief) {
  r.target = +(regionalPlain(r.x, r.z) + reliefRise(r.x)).toFixed(2);
  r.err = +(r.ground - r.target).toFixed(2);
}

const fmt = (n, w = 7) => String(n).padStart(w);
const lines = [];
const say = (s) => { lines.push(s); console.log(s); };

say(`map ${MAP}  wall x ${out.wall.xMin} .. ${out.wall.xMax}, ${out.wall.bays} bays`);
if (pageErrors.length) say(`PAGE ERRORS ${pageErrors.length}:\n  ${pageErrors.join('\n  ')}`);

if (want('tiber')) {
  say('\n── 1. the Tiber, twelve survey points through worldOf ──────────────');
  say('     lat      lon  |      e |     n |      x |      z | riverCentreX |   error');
  let worst = 0;
  for (const t of out.tiber) {
    if (Math.abs(t.err) > Math.abs(worst)) worst = t.err;
    say(`  ${t.lat.toFixed(4)} ${t.lon.toFixed(4)} | ${fmt(t.e, 6)} | ${fmt(t.n, 5)} | ${fmt(t.x)} | `
      + `${fmt(t.z)} | ${fmt(t.model, 12)} | ${fmt(t.err.toFixed(1))}`);
  }
  say(`  WORST ERROR ${Math.abs(worst).toFixed(1)} world m   (task 1 accepts <= 25)`);
  out.tiberWorst = +Math.abs(worst).toFixed(1);
}

if (want('relief')) {
  const dom = out.relief;
  const onWall = dom.filter((r) => r.onWall);
  const worstOf = (rows) => rows.reduce((a, r) => (Math.abs(r.err) > Math.abs(a.err) ? r : a), rows[0] ?? { err: 0, x: 0 });
  say('\n── 2a. relief along the published wall line, against §3.5 ──────────');
  say('       x |     z |  ground |  target |   error');
  for (const r of dom) {
    if (r.x % 50 !== 2 && r.x % 50 !== 0) continue;
    say(`  ${fmt(r.x, 6)} | ${fmt(r.z, 5)} | ${fmt(r.ground)} | ${fmt(r.target)} | ${fmt(r.err.toFixed(2))}`
      + (r.onWall ? '' : '   (no wall here)'));
  }
  const wd = worstOf(dom);
  const ww = worstOf(onWall);
  const over = dom.filter((r) => Math.abs(r.err) > 1.5).length;
  const overWall = onWall.filter((r) => Math.abs(r.err) > 1.5).length;
  say(`  §3.5 domain x 2..1335: worst ${wd.err} m at x ${wd.x}; ${over} of ${dom.length} stations over ±1.5`);
  say(`  under the wall only:   worst ${ww.err} m at x ${ww.x}; ${overWall} of ${onWall.length} stations over ±1.5`);
  out.reliefWorst = wd.err;
  out.reliefWorstOnWall = ww.err;
  out.reliefOver = over;
  out.reliefOverOnWall = overWall;
}

if (want('bench')) {
  say('\n── 2b. the graded bench ────────────────────────────────────────────');
  const onWall = out.relief.filter((r) => r.onWall);
  const narrow = onWall.filter((r) => r.bench < WALL_BENCH_HALF);
  say(`  5 m transect along the wall: ${onWall.length - narrow.length}/${onWall.length} stations carry`
    + ` >= ${WALL_BENCH_HALF} m of ground level with the footing`
    + ` (${(((onWall.length - narrow.length) / Math.max(1, onWall.length)) * 100).toFixed(1)} %)`);
  if (onWall.length) {
    const widths = onWall.map((r) => r.bench).sort((a, b) => a - b);
    say(`    width min ${widths[0]} m, median ${widths[widths.length >> 1]} m, max ${widths[widths.length - 1]} m`);
    if (narrow.length) say(`    worst at x ${narrow[0].x} (${narrow[0].bench} m: ${narrow[0].benchLo} behind, ${narrow[0].benchHi} in front)`);
  }
  const live = out.stations.filter((s) => !s.dead);
  if (live.length) {
    const bad = live.filter((s) => s.bench < WALL_BENCH_HALF);
    say(`  spine stations: ${live.length - bad.length}/${live.length} carry >= ${WALL_BENCH_HALF} m`
      + ` (${(((live.length - bad.length) / live.length) * 100).toFixed(1)} %)`);
    const widths = live.map((s) => s.bench).sort((a, b) => a - b);
    say(`    width min ${widths[0]} m, median ${widths[widths.length >> 1]} m, max ${widths[widths.length - 1]} m`);
    const worstOff = live.reduce((a, s) => (Math.abs(s.offDrawn ?? 0) > Math.abs(a.offDrawn ?? 0) ? s : a), live[0]);
    say(`    (measured at the station's own ground; worst station-vs-drawn-walk offset ${worstOff.offDrawn} m at x ${worstOff.x})`);
    out.benchStationsOk = live.length - bad.length;
    out.benchStationsTotal = live.length;
  }
}

if (want('walk')) {
  say('\n── 2c. the wall-walk ───────────────────────────────────────────────');
  say(`  walkY ${out.wall.walkYMin} .. ${out.wall.walkYMax} m over ${out.wall.bays} bays`);
  say(`  WORST BAY-TO-BAY STEP ${Math.abs(out.wall.worstStep).toFixed(2)} m at x ${out.wall.worstStepAt}`
    + '   (all bays; §4.1 measured 28.39)');
  say(`  worst step where both sides are built to full height: ${Math.abs(out.wall.worstWalkStep).toFixed(2)} m`
    + ` at x ${out.wall.worstWalkStepAt}, bays ${out.wall.worstWalkStepBays || 'n/a'}`
    + '   (task 2 accepts < 6)');
  if (out.report) {
    const r = out.report;
    say(`  runs ${r.runs}, stations ${r.stations}, REACHABLE FROM A STAIR ${r.reachable}/${r.runs}`
      + `, stairs ${r.stairs} (${r.source})`);
    say(`  links ${JSON.stringify(r.links)}; ${r.unbridged} unbridged, ${r.refusedSteps} refused;`
      + ` worst bridged step ${r.worstStep} m at pitch ${r.worstPitch}`);
  }
}

if (want('wetunits')) {
  say('\n── the order of battle against the corrected river ─────────────────');
  const tot = out.wetunits.reduce((a, u) => a + u.men, 0);
  const wet = out.wetunits.reduce((a, u) => a + u.wet, 0);
  const far = out.wetunits.reduce((a, u) => a + u.farBank, 0);
  const off = out.wetunits.reduce((a, u) => a + u.offGround, 0);
  say(`  ${out.wetunits.length} units, ${tot} men:  ${wet} standing in water,`
    + `  ${far} on the far bank,  ${off} off the graded deployment ground`);
  for (const u of out.wetunits) {
    if (u.wet === 0 && u.farBank === 0) continue;
    say(`    unit ${String(u.unit).padStart(3)} at (${fmt(u.x, 6)}, ${fmt(u.z, 5)}): ${u.men} men,`
      + ` ${u.wet} wet, ${u.farBank} on the far bank`);
  }
}

if (want('funnel')) {
  say('\n── the funnel: where the water ends, per row ───────────────────────');
  say('       z |  centre |   west |   east');
  for (const f of out.funnel) {
    say(`  ${fmt(f.z, 6)} | ${fmt(f.centre)} | ${fmt(f.west, 6)} | ${fmt(f.east, 6)}`);
  }
}

if (want('deploy')) {
  say('\n── 1b/2d. the deployment masks ─────────────────────────────────────');
  for (const [name, d] of Object.entries(out.deploy)) {
    say(`  ${name.padEnd(7)} ${fmt(d.cells, 6)} cells   under water ${fmt(d.wet, 5)}`
      + `   over ${ROUGH_SLOPE_IMPASSABLE} slope ${fmt(d.steep, 5)}`
      + `   lowest ${d.minH} m   steepest ${d.maxSlope}`);
    if (d.wettest) say(`          wettest (${d.wettest.x}, ${d.wettest.z}) at ${d.wettest.h} m`);
    if (d.steepest) say(`          steepest (${d.steepest.x}, ${d.steepest.z}) at ${d.steepest.s}`);
  }
}

if (JSON_OUT) {
  await writeFile(JSON_OUT, JSON.stringify({ map: MAP, pageErrors, ...out }, null, 1));
  console.log(`\nwrote ${JSON_OUT}`);
}
await browser.close();
