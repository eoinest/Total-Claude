#!/usr/bin/env node
/**
 * How much height does a wall link bridge, and is there stone under it?
 *
 * `Siege.recut()` severs a run when consecutive stations differ by more than 0.62 m in y.
 * `Siege.buildLinks()` then rejoins two runs on **horizontal gap alone** — it computed
 * `const step = Math.abs(sy[b] - sy[a])` and the next line was `void step;`. So the number
 * that split the run was measured, named, and thrown away by the code that put it back.
 *
 * This reads every link off the live sim and prints the height it spans, the pitch of the
 * path a man is actually walked along, and what the *city* says is under his feet there.
 *
 * **It checks itself before it reports.** Four cross-checks, each against a source that is
 * not the one being measured, because roughly as many defects in this project have been in
 * the instruments as in the product:
 *
 *   1. every link's `ay`/`by` against `sy[stationA]`/`sy[stationB]` — the probe's `dy` must
 *      be the same subtraction `buildLinks` did, not a similar one;
 *   2. every walk link's `dy` against `|walkY|` of the two `GarrisonBay`s the stations
 *      belong to — an independent publisher of the same height;
 *   3. run, station and link counts against `Siege.wallReport()` — a second, public
 *      accessor that walks the same arrays by a different route;
 *   4. `recut`'s own invariant: no two consecutive stations *inside* one run may differ by
 *      more than 0.62 m. If that fails the sever threshold is not what this says it is and
 *      nothing below it means anything.
 *
 * And one measurement that is deliberately made against the *other* subsystem: the height
 * of the drawn walking surface, `CitySystem.walkableTopAt`, sampled along the crossing. A
 * path that floats above the stone or runs inside it is a man walking on nothing, and that
 * cannot be seen by comparing the link with the stations it was built from.
 *
 * Usage:
 *   node tools/scratch/probe-linkstep.mjs --port=5949
 *   node tools/scratch/probe-linkstep.mjs --port=5949 --map=carthage
 *   node tools/scratch/probe-linkstep.mjs --port=5949 --json
 */
import { chromium } from 'playwright';

const arg = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split('=')[1];
const PORT = Number(arg('port', 5931));
const MAP = arg('map', 'campus-martius');
const AS_JSON = process.argv.includes('--json');

/** `recut`'s sever threshold. A step over this splits the run; both files must use one number. */
const WALK_STEP = 0.62;
/**
 * Tread module: 0.31 m rise on 0.34 m going, which is `Siege.STAIR_SLOPE` inverted and the
 * same pair `wall.ts` lays the tower flight out from. A crossing steeper than this cannot be
 * built out of the stairs this project builds stairs from.
 */
const STAIR_PITCH = 0.31 / 0.34;

const token = Buffer.from(JSON.stringify({ map: MAP, scenario: 'assault' })).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const url = `http://127.0.0.1:${PORT}/?harness=1&w=1280&h=720&quality=ultra&scenario=assault&battle=${token}`;
const r = await fetch(`http://127.0.0.1:${PORT}/src/main.ts`).catch(() => null);
if (!r || !r.ok) { console.error('no dev server on', PORT); process.exit(2); }

const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal'] });
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
const pageErrors = [];
p.on('pageerror', (e) => pageErrors.push(String(e)));
await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
await p.waitForFunction(() => window.__game && window.__game.ready, null, { timeout: 180000 });

const out = await p.evaluate(({ WALK_STEP }) => {
  const g = window.__game;
  const S = g.battle?.elevation ?? g.battle?.siege;
  const links = S.links;               // private, but this is a probe
  const city = S.city;
  const bays = city ? city.getGarrisonBays() : [];
  const bayY = new Map();
  for (const q of bays) bayY.set(q.index, q.walkY);
  const KIND = ['TowerPass', 'Step', 'Stair', 'Breach'];

  const rows = links.map((l) => {
    const gap = Math.hypot(l.bx - l.ax, l.bz - l.az);
    const dy = Math.abs(l.by - l.ay);
    const row = {
      id: l.id, kind: KIND[l.kind], runA: l.runA, runB: l.runB,
      stationA: l.stationA, stationB: l.stationB,
      gap: +gap.toFixed(2), dy: +dy.toFixed(2),
      ax: +l.ax.toFixed(1), ay: +l.ay.toFixed(2), by: +l.by.toFixed(2),
      pitch: gap > 1e-6 ? +(dy / gap).toFixed(3) : Infinity,
      deg: gap > 1e-6 ? +((Math.atan2(dy, gap) * 180) / Math.PI).toFixed(1) : 90,
      // Arc of the authored path, and what the sim will actually charge for it. The path is
      // built lazily, so ask for it; `pace` is the crossing's own, not an assumption.
      arc: 0, pace: 0, secs: 0,
      // How far the authored path is from the surface the city says is there, worst sample.
      offStone: 0, offStoneAt: 0,
      bayA: -1, bayB: -1, bayDy: -1,
    };
    if (l.stationA >= 0) row.bayA = S.sBay[l.stationA];
    if (l.stationB >= 0) row.bayB = S.sBay[l.stationB];
    if (row.bayA >= 0 && row.bayB >= 0 && bayY.has(row.bayA) && bayY.has(row.bayB)) {
      row.bayDy = +Math.abs(bayY.get(row.bayB) - bayY.get(row.bayA)).toFixed(2);
    }
    const c = S.linkPath(l, true);
    row.arc = +c.arc[c.n - 1].toFixed(2);
    row.pace = +c.pace.toFixed(3);
    /*
     * Seconds, leg by leg, at the speed `advanceQueue` will actually use.
     *
     * The crossing's own `pace` is not the answer and printing it was the probe's own
     * version of the defect it is measuring: `segmentAt` overrides it to `CROSS_CLIMB` on any
     * leg whose *sine* exceeds 0.6, so on the steep joints the nominal 1.05 m/s is a number
     * nobody ever moves at. 0.78 and 0.6 are read off `Siege.ts`; if either moves this goes
     * with it, and the mismatch is the sort of thing the self-checks above exist for.
     */
    let secs = 0;
    for (let k = 1; k < c.n; k++) {
      const len = c.arc[k] - c.arc[k - 1];
      if (len <= 1e-6) continue;
      const dyLeg = Math.abs(c.pts[k * 3 + 1] - c.pts[(k - 1) * 3 + 1]);
      secs += len / (dyLeg / len > 0.6 ? 0.78 : c.pace);
    }
    row.secs = +secs.toFixed(1);
    if (city && city.walkableTopAt) {
      // 40 samples by arc, skipping the two endpoints: those sit on the stations themselves
      // and the interesting failure is in the middle of the span.
      let worst = 0; let worstAt = 0;
      const total = c.arc[c.n - 1];
      for (let k = 1; k < 40; k++) {
        const s = (total * k) / 40;
        let seg = 1;
        while (seg < c.n - 1 && c.arc[seg] < s) seg++;
        const t0 = c.arc[seg - 1]; const t1 = c.arc[seg];
        const f = t1 > t0 ? (s - t0) / (t1 - t0) : 0;
        const px = c.pts[(seg - 1) * 3] + (c.pts[seg * 3] - c.pts[(seg - 1) * 3]) * f;
        const py = c.pts[(seg - 1) * 3 + 1] + (c.pts[seg * 3 + 1] - c.pts[(seg - 1) * 3 + 1]) * f;
        const pz = c.pts[(seg - 1) * 3 + 2] + (c.pts[seg * 3 + 2] - c.pts[(seg - 1) * 3 + 2]) * f;
        const top = city.walkableTopAt(px, pz, py + 1.6);
        if (!isFinite(top)) continue;
        const d = py - top;
        if (Math.abs(d) > Math.abs(worst)) { worst = d; worstAt = +(s / total).toFixed(2); }
      }
      row.offStone = +worst.toFixed(2);
      row.offStoneAt = worstAt;
    }
    return row;
  });

  // ---- self-checks, each against a source that is not the one being measured ----------
  const faults = [];
  for (const l of links) {
    if (l.stationA >= 0 && Math.abs(l.ay - S.sy[l.stationA]) > 1e-6) {
      faults.push(`link ${l.id}: ay ${l.ay} != sy[${l.stationA}] ${S.sy[l.stationA]}`);
    }
    if (l.stationB >= 0 && l.kind !== 2 && Math.abs(l.by - S.sy[l.stationB]) > 1e-6) {
      faults.push(`link ${l.id}: by ${l.by} != sy[${l.stationB}] ${S.sy[l.stationB]}`);
    }
  }
  for (const row of rows) {
    if (row.kind !== 'TowerPass' && row.kind !== 'Step') continue;
    if (row.bayDy < 0) { faults.push(`link ${row.id}: no bay walkY to check dy against`); continue; }
    if (Math.abs(row.bayDy - row.dy) > 0.011) {
      faults.push(`link ${row.id}: dy ${row.dy} but bays ${row.bayA}/${row.bayB} step ${row.bayDy}`);
    }
  }
  const w = S.wallReport();
  const counted = { TowerPass: 0, Step: 0, Stair: 0, Breach: 0 };
  for (const row of rows) counted[row.kind]++;
  if (w.runs !== S.nRuns) faults.push(`wallReport runs ${w.runs} != nRuns ${S.nRuns}`);
  if (w.stations !== S.nStations) faults.push(`wallReport stations ${w.stations} != nStations ${S.nStations}`);
  for (const [k, v] of Object.entries({ towerPass: counted.TowerPass, step: counted.Step,
    stair: counted.Stair, breach: counted.Breach })) {
    if (w.links[k] !== v) faults.push(`wallReport ${k} ${w.links[k]} != counted ${v}`);
  }
  let worstInRun = 0;
  for (let i = 1; i < S.nStations; i++) {
    if (S.sRun[i] !== S.sRun[i - 1]) continue;
    const d = Math.abs(S.sy[i] - S.sy[i - 1]);
    if (d > worstInRun) worstInRun = d;
  }
  if (worstInRun > WALK_STEP + 1e-6) {
    faults.push(`recut left a ${worstInRun.toFixed(2)} m step inside a run, over its own ${WALK_STEP}`);
  }

  // The station heights against the stone under them: `Siege` puts every station of a bay at
  // `bay.walkY`, and `CitySystem.walkableTopAt` ramps the walk through the tower footprint.
  // Where those disagree the man is standing off the stone before he ever reaches a link.
  let worstStation = 0; let worstStationAt = -1;
  if (city && city.walkableTopAt) {
    for (let i = 0; i < S.nStations; i++) {
      if (S.sDead[i]) continue;
      const top = city.walkableTopAt(S.sx[i], S.sz[i], S.sy[i] + 1.6);
      if (!isFinite(top)) continue;
      const d = S.sy[i] - top;
      if (Math.abs(d) > Math.abs(worstStation)) { worstStation = d; worstStationAt = i; }
    }
  }

  // Which runs a man on the ground can reach, and how much wall that leaves stranded. Run
  // counts flatter a short run and punish a long one equally, so this is also in stations
  // and in metres of x, which is what a player actually loses.
  const seen = new Set();
  {
    const stack = links.filter((l) => l.kind === 2 && l.runB >= 0).map((l) => l.runB);
    while (stack.length) {
      const q = stack.pop();
      if (q < 0 || q >= S.nRuns || seen.has(q)) continue;
      seen.add(q);
      if (S.runNext[q] >= 0) stack.push(q + 1);
      if (q > 0 && S.runNext[q - 1] >= 0) stack.push(q - 1);
    }
  }
  const runInfo = [];
  for (let q = 0; q < S.nRuns; q++) {
    const lo = S.runLo[q]; const hi = S.runHi[q];
    if (lo < 0) continue;
    runInfo.push({
      run: q, reachable: seen.has(q), stations: hi - lo + 1,
      x0: +S.sx[lo].toFixed(1), x1: +S.sx[hi].toFixed(1),
      metres: +Math.abs(S.sx[hi] - S.sx[lo]).toFixed(1),
      bay: S.sBay[lo],
    });
  }

  return {
    nRuns: S.nRuns, nStations: S.nStations, rows, faults, worstInRun, runInfo,
    unbridged: w.unbridged, refusedSteps: w.refusedSteps, stairSource: w.source,
    worstStep: +w.worstStep.toFixed(2), worstPitch: +w.worstPitch.toFixed(3),
    reachable: w.reachable, stairsOn: [...new Set(links.filter((l) => l.kind === 2)
      .map((l) => l.runB))].sort((x, y) => x - y),
    worstStation: +worstStation.toFixed(2), worstStationAt,
    stationX: worstStationAt >= 0 ? +S.sx[worstStationAt].toFixed(1) : 0,
  };
}, { WALK_STEP });

const walk = out.rows.filter((r2) => r2.kind === 'TowerPass' || r2.kind === 'Step');
walk.sort((a, b2) => b2.dy - a.dy);

/** Flood the run chain from every run a stair lands on, given a set of surviving links. */
function reachableUnder(keep) {
  const kept = new Set(keep.map((l) => l.runA));
  const seen = new Set();
  const stack = [...out.stairsOn];
  while (stack.length) {
    const r2 = stack.pop();
    if (r2 < 0 || r2 >= out.nRuns || seen.has(r2)) continue;
    seen.add(r2);
    if (kept.has(r2)) stack.push(r2 + 1);
    if (kept.has(r2 - 1)) stack.push(r2 - 1);
  }
  let components = 1;
  for (let r2 = 0; r2 + 1 < out.nRuns; r2++) if (!kept.has(r2)) components++;
  return { reachable: seen.size, components };
}

const RULES = [
  ['ship  (gap only, height voided)', () => true],
  ['dy <= 0.62  (recut\'s own)', (l) => l.dy <= WALK_STEP + 1e-6],
  ['dy <= 1.2   (STAIR_STEP_OVER)', (l) => l.dy <= 1.2 + 1e-6],
  ['dy <= 3.0   (a storey)', (l) => l.dy <= 3.0 + 1e-6],
  ['pitch <= 0.912 (tread module)', (l) => l.dy <= l.gap * STAIR_PITCH + 1e-6],
  ['pitch <= 1.0   (45 deg)', (l) => l.dy <= l.gap + 1e-6],
];

if (AS_JSON) {
  console.log(JSON.stringify({ map: MAP, ...out, pageErrors }, null, 2));
} else {
  console.log(`map ${MAP}: runs ${out.nRuns}, stations ${out.nStations}, `
    + `walk-to-walk links ${walk.length}, reachable ${out.reachable}/${out.nRuns}`);
  if (pageErrors.length) console.log(`PAGE ERRORS: ${pageErrors.length}\n  ${pageErrors.join('\n  ')}`);

  console.log(`\nself-checks: ${out.faults.length === 0 ? 'clean' : `${out.faults.length} FAULTS`}`);
  for (const f of out.faults.slice(0, 12)) console.log(`  ! ${f}`);
  console.log(`  worst y step inside a run: ${out.worstInRun.toFixed(3)} m (recut severs over ${WALK_STEP})`);
  console.log(`  worst station off the drawn walk: ${out.worstStation >= 0 ? '+' : ''}`
    + `${out.worstStation.toFixed(2)} m at station ${out.worstStationAt}, x ${out.stationX}`);

  console.log('\nworst height a walk-to-walk crossing bridges:');
  console.log('  kind        runs      x       gap     ay      by      dy   pitch   deg    arc  pace  secs  offStone');
  for (const l of walk.slice(0, 14)) {
    console.log(`  ${l.kind.padEnd(10)} ${String(l.runA).padStart(3)}→${String(l.runB).padEnd(3)} `
      + `${String(l.ax).padStart(7)} ${String(l.gap).padStart(7)} ${String(l.ay).padStart(7)} `
      + `${String(l.by).padStart(7)} ${String(l.dy).padStart(7)} ${String(l.pitch).padStart(6)} `
      + `${String(l.deg).padStart(5)} ${String(l.arc).padStart(6)} ${String(l.pace).padStart(5)} `
      + `${String(l.secs).padStart(5)} ${String(l.offStone).padStart(9)}`);
  }

  const over = (t) => walk.filter((l) => l.dy > t).length;
  console.log(`\nover 0.62 m (recut's own threshold): ${over(0.62)} of ${walk.length}`);
  console.log(`over 1.2 m  (STAIR_STEP_OVER, mid-thigh): ${over(1.2)}`);
  console.log(`over 3.0 m  (a storey):                   ${over(3.0)}`);
  console.log(`over 6.0 m  (the whole curtain):          ${over(6.0)}`);
  const steeper = walk.filter((l) => l.pitch > STAIR_PITCH + 1e-6).length;
  console.log(`steeper than the 0.31/0.34 tread module:  ${steeper}`);

  console.log('\nwhat each candidate rule would keep, and what the wall becomes:');
  console.log('  rule                              kept  refused  components  reachable');
  for (const [name, ok] of RULES) {
    const keep = walk.filter(ok);
    const { reachable, components } = reachableUnder(keep);
    console.log(`  ${name.padEnd(33)} ${String(keep.length).padStart(4)} `
      + `${String(walk.length - keep.length).padStart(8)} ${String(components).padStart(11)} `
      + `${String(reachable).padStart(10)}/${out.nRuns}`);
  }

  const strand = out.runInfo.filter((q) => !q.reachable);
  const totStations = out.runInfo.reduce((a, q) => a + q.stations, 0);
  const strandStations = strand.reduce((a, q) => a + q.stations, 0);
  const totM = out.runInfo.reduce((a, q) => a + q.metres, 0);
  const strandM = strand.reduce((a, q) => a + q.metres, 0);
  console.log(`\nwallReport: stairs ${out.stairSource}, ${out.unbridged} unbridged boundaries, ${out.refusedSteps} of them `
    + `refused by the step classifier; worst bridged step ${out.worstStep} m at pitch ${out.worstPitch}`);
  console.log(`stranded from the ground: ${strand.length} run(s), ${strandStations} of ${totStations} `
    + `stations (${((100 * strandStations) / totStations).toFixed(1)} %), `
    + `${strandM.toFixed(0)} of ${totM.toFixed(0)} m of walk`);
  if (strand.length) {
    console.log(`  runs ${strand.map((q) => `${q.run}[bay ${q.bay}, x ${q.x0}..${q.x1}]`).join(', ')}`);
  }

  const s = out.rows.filter((r2) => r2.kind === 'Stair');
  if (s.length) {
    console.log(`\nstairs ${s.length}, rise ${Math.min(...s.map((x) => x.dy)).toFixed(2)}`
      + `–${Math.max(...s.map((x) => x.dy)).toFixed(2)} m`);
  }
}
await b.close();
if (out.faults.length > 0) process.exitCode = 1;
