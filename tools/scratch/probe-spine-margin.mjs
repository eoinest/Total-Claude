#!/usr/bin/env node
/**
 * Where does `Siege.buildSpine` put a man, and is the stone it levels him to under his feet?
 *
 * `buildSpine` lays a station every `STATION_PITCH` along each garrisonable bay between two
 * clips: `t0 = bay.towerHalf + 0.55` at the west end and `t1 = bay.length - 0.55` at the
 * east. Those two are not the same sentence. The west one names the tower that stands at the
 * bay's own origin; the east one names nothing at all, so the run walks straight into the
 * *next* bay's tower — and every station in it is still levelled to this bay's `walkY`, while
 * `CitySystem.curtainWalkAt` has already begun ramping the drawn walk toward the next bay's.
 *
 * Four things measured, each against a source that is not `buildSpine`:
 *
 *   1. **Inside a tower.** The oriented box `CitySystem.buildObstacles` stamps — half-extents
 *      `towerHalf` about a bay's origin, on `hasTower` and not on `towerHalf > 0`, which is
 *      that file's own distinction. A station inside one is inside a ballista chamber.
 *   2. **Off the drawn walk.** `CitySystem.walkableTopAt` at each station's own plan point.
 *      This is the other subsystem's answer to "what is under his feet", and it is the only
 *      one of the four that cannot be derived from the bay record `buildSpine` reads.
 *   3. **Tower gaps**, against `LINK_MAX_GAP`. Measured at the run boundaries `recut`
 *      produced *and* independently from the bay geometry, because the first is downstream
 *      of the thing being changed and the second is not.
 *   4. **Link classification** — walk-to-walk links, how many the rake test refuses, and how
 *      many runs a man can reach from a stair — read off `Siege.wallReport()`.
 *
 * Self-checks first, and the run is worthless if any of them fires:
 *   a. station count against `wallReport().stations`;
 *   b. every station's recovered along-run `t` must put it back within a millimetre of its
 *      own recorded plan position — otherwise the frame this probe reasons in is not the
 *      frame the spine was laid in;
 *   c. `bay.length` against the chord to the next bay's origin, measured. `curtainWalkAt`
 *      distrusts `bay.length` on a bowed run and this probe would inherit the error;
 *   d. the observed first and last `t` of each bay's stations against the clips recomputed
 *      here from the bay record. If those disagree the probe is not reading the code it
 *      thinks it is — which is how the "after" arm gets measured on the "before" tree.
 *
 * Usage:
 *   node tools/scratch/probe-spine-margin.mjs --port=5953 [--map=carthage] [--json]
 */
import { chromium } from 'playwright';

const arg = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split('=')[1];
const PORT = Number(arg('port', 5953));
const MAP = arg('map', 'campus-martius');
const LABEL = arg('label', '');
const AS_JSON = process.argv.includes('--json');
/** `Siege.LINK_MAX_GAP`. Read off the file; if it moves this goes with it. */
const LINK_MAX_GAP = 14;
/** `Siege.STATION_PITCH`. */
const PITCH = 0.86;

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

const out = await p.evaluate(({ PITCH }) => {
  const g = window.__game;
  const S = g.battle?.elevation ?? g.battle?.siege;
  const city = S.city;
  const bays = city.getGarrisonBays();
  const faults = [];

  // Bays are indexed by array position everywhere in this file; say so out loud once.
  for (let i = 0; i < bays.length; i++) {
    if (bays[i].index !== i) faults.push(`bay ${i} publishes index ${bays[i].index}`);
  }

  /** Chord from a bay's origin to the next bay's, along its own run direction. */
  const lenToNext = (i) => {
    const q = bays[i]; const n = bays[i + 1];
    if (!n) return q.length;
    return (n.x0 - q.x0) * q.dx + (n.z0 - q.z0) * q.dz;
  };
  const bayRows = bays.map((q, i) => ({
    i, garrisonable: q.garrisonable, walkable: q.walkable, isGate: q.isGate,
    hasTower: q.hasTower, towerHalf: +q.towerHalf.toFixed(3),
    length: +q.length.toFixed(3), toNext: +lenToNext(i).toFixed(3),
    walkY: +q.walkY.toFixed(3), x0: +q.x0.toFixed(1),
    nextTowerHalf: bays[i + 1] && bays[i + 1].hasTower ? +bays[i + 1].towerHalf.toFixed(3) : 0,
  }));
  // (c) `bay.length` against the measured chord. `curtainWalkAt` refuses to trust the first.
  let worstLenDrift = 0;
  for (let i = 0; i + 1 < bays.length; i++) {
    const d = Math.abs(bays[i].length - lenToNext(i));
    if (d > worstLenDrift) worstLenDrift = d;
  }

  /** Every tower on the circuit, as the oriented box `buildObstacles` stamps. */
  const towers = [];
  for (const q of bays) {
    if (!q.hasTower || q.towerHalf <= 0) continue;
    towers.push({ x: q.x0, z: q.z0, dx: q.dx, dz: q.dz, nx: q.nx, nz: q.nz, h: q.towerHalf, bay: q.index });
  }

  // ---- station census --------------------------------------------------------------
  const perBay = new Map();
  let inTower = 0; let worstIn = 0; let worstInAt = -1;
  let worstOff = 0; let worstOffAt = -1;
  const offBins = { p05: 0, p50: 0, p100: 0, p200: 0 };
  let checkedOff = 0;
  let worstT = 0;
  const offRows = [];
  for (let i = 0; i < S.nStations; i++) {
    const bi = S.sBay[i];
    const q = bays[bi];
    const t = (S.sx[i] - q.x0) * q.dx + (S.sz[i] - q.z0) * q.dz;
    // (b) the frame round-trips.
    const rx = q.x0 + q.dx * t; const rz = q.z0 + q.dz * t;
    const drift = Math.hypot(rx - S.sx[i], rz - S.sz[i]);
    if (drift > worstT) worstT = drift;
    let e = perBay.get(bi);
    if (!e) { e = { bay: bi, n: 0, t0: Infinity, t1: -Infinity }; perBay.set(bi, e); }
    e.n++; if (t < e.t0) e.t0 = t; if (t > e.t1) e.t1 = t;

    // 1. inside a tower box
    let deep = 0;
    for (const w of towers) {
      const ex = S.sx[i] - w.x; const ez = S.sz[i] - w.z;
      const a = Math.abs(ex * w.dx + ez * w.dz);
      const c = Math.abs(ex * w.nx + ez * w.nz);
      if (a <= w.h && c <= w.h) { const d = w.h - a; if (d > deep) deep = d; }
    }
    if (deep > 0) { inTower++; if (deep > worstIn) { worstIn = deep; worstInAt = i; } }

    // 2. off the drawn walk
    const top = city.walkableTopAt(S.sx[i], S.sz[i], S.sy[i] + 1.6);
    if (isFinite(top)) {
      checkedOff++;
      const d = S.sy[i] - top;
      const ad = Math.abs(d);
      if (ad > 0.05) offBins.p05++;
      if (ad > 0.5) offBins.p50++;
      if (ad > 1.0) offBins.p100++;
      if (ad > 2.0) offBins.p200++;
      if (ad > Math.abs(worstOff)) { worstOff = d; worstOffAt = i; }
      if (ad > 0.5) {
        offRows.push({ i, bay: bi, x: +S.sx[i].toFixed(1), sy: +S.sy[i].toFixed(2),
          top: +top.toFixed(2), off: +d.toFixed(2), t: +t.toFixed(2), inTower: deep > 0 });
      }
    }
  }
  offRows.sort((m, n) => Math.abs(n.off) - Math.abs(m.off));

  // (d) the clips this build actually used, per bay, against what the bay record implies.
  const clip = [];
  for (const e of perBay.values()) {
    const q = bays[e.bay];
    const n = bays[e.bay + 1];
    clip.push({
      bay: e.bay, n: e.n,
      t0: +e.t0.toFixed(3), t1: +e.t1.toFixed(3),
      westFree: +(e.t0 - q.towerHalf).toFixed(3),
      eastFree: +(lenToNext(e.bay) - (n && n.hasTower ? n.towerHalf : 0) - e.t1).toFixed(3),
    });
  }
  clip.sort((m, n) => m.bay - n.bay);

  // ---- 3. gaps ---------------------------------------------------------------------
  // (i) at the run boundaries `recut` produced.
  const runGaps = [];
  for (let q = 0; q + 1 < S.nRuns; q++) {
    const a = S.runHi[q]; const c = S.runLo[q + 1];
    if (a < 0 || c < 0) continue;
    const gap = Math.hypot(S.sx[c] - S.sx[a], S.sz[c] - S.sz[a]);
    const dy = S.sy[c] - S.sy[a];
    // A tower stands between these two stations iff one of the boxes contains the midpoint.
    const mx = (S.sx[a] + S.sx[c]) * 0.5; const mz = (S.sz[a] + S.sz[c]) * 0.5;
    let overTower = false;
    for (const w of towers) {
      const ex = mx - w.x; const ez = mz - w.z;
      if (Math.abs(ex * w.dx + ez * w.dz) <= w.h && Math.abs(ex * w.nx + ez * w.nz) <= w.h) overTower = true;
    }
    runGaps.push({ r: q, gap: +gap.toFixed(2), dy: +dy.toFixed(2), overTower,
      x: +S.sx[a].toFixed(1), linked: S.runNext[q] >= 0 });
  }
  // (ii) from the bay geometry, independent of `recut`: for every tower, the clear span the
  // clips leave either side of it.
  const towerSpans = [];
  for (const w of towers) {
    const east = bays[w.bay];          // the bay whose origin the tower sits on
    const west = bays[w.bay - 1];
    if (!west || !west.garrisonable || !east.garrisonable) continue;
    const wLen = (east.x0 - west.x0) * west.dx + (east.z0 - west.z0) * west.dz;
    const eW = perBay.get(west.index); const eE = perBay.get(east.index);
    if (!eW || !eE) continue;
    towerSpans.push({ bay: w.bay, towerHalf: +w.h.toFixed(2),
      span: +((wLen - eW.t1) + eE.t0).toFixed(2) });
  }

  const w = S.wallReport();
  return {
    nStations: S.nStations, nRuns: S.nRuns,
    reportStations: w.stations, reportRuns: w.runs,
    links: w.links, unbridged: w.unbridged, refusedSteps: w.refusedSteps,
    reachable: w.reachable, worstStep: +w.worstStep.toFixed(2), worstPitch: +w.worstPitch.toFixed(3),
    stairSource: w.source,
    bayRows, clip, runGaps, towerSpans, offRows: offRows.slice(0, 12),
    inTower, worstIn: +worstIn.toFixed(2), worstInAt,
    worstOff: +worstOff.toFixed(4), worstOffAt, offBins, checkedOff,
    worstOffX: worstOffAt >= 0 ? +S.sx[worstOffAt].toFixed(1) : 0,
    worstInX: worstInAt >= 0 ? +S.sx[worstInAt].toFixed(1) : 0,
    worstLenDrift: +worstLenDrift.toFixed(4), worstT: +worstT.toFixed(6), faults,
    nTowers: towers.length,
    // Reachable runs recomputed here from `runNext` and the stair links, so the number is
    // not just `wallReport`'s own word for it.
    reachCheck: (() => {
      const stairRuns = w.linkUse.filter((l) => l.kind === 'stair').map((l) => l.runB);
      const seen = new Set(); const stack = [...stairRuns];
      while (stack.length) {
        const q = stack.pop();
        if (q < 0 || q >= S.nRuns || seen.has(q)) continue;
        seen.add(q);
        if (S.runNext[q] >= 0) stack.push(q + 1);
        if (q > 0 && S.runNext[q - 1] >= 0) stack.push(q - 1);
      }
      return seen.size;
    })(),
  };
}, { PITCH });

if (out.reportStations !== out.nStations) out.faults.push(`wallReport stations ${out.reportStations} != ${out.nStations}`);
if (out.reportRuns !== out.nRuns) out.faults.push(`wallReport runs ${out.reportRuns} != ${out.nRuns}`);
if (out.worstT > 1e-3) out.faults.push(`station frame drifts ${out.worstT} m; the probe's t is not the spine's`);
if (out.reachCheck !== out.reachable) out.faults.push(`reachable ${out.reachable} but flood says ${out.reachCheck}`);
if (pageErrors.length) out.faults.push(`${pageErrors.length} page errors: ${pageErrors.join(' | ')}`);

const q = (a) => { const s = [...a].sort((m, n) => m - n); return s.length ? s[Math.floor(s.length / 2)] : 0; };
const tg = out.runGaps.filter((r2) => r2.overTower).map((r2) => r2.gap);
const ng = out.runGaps.filter((r2) => !r2.overTower).map((r2) => r2.gap);
const spans = out.towerSpans.map((s) => s.span);
const summary = {
  map: MAP, label: LABEL,
  stations: out.nStations, runs: out.nRuns, towers: out.nTowers,
  inTower: out.inTower, worstInTower: out.worstIn, worstInTowerX: out.worstInX,
  worstOffWalk: out.worstOff, worstOffWalkX: out.worstOffX, offBins: out.offBins,
  towerGap: tg.length ? { n: tg.length, min: Math.min(...tg), med: q(tg), max: Math.max(...tg),
    overMax: tg.filter((v) => v > LINK_MAX_GAP).length } : null,
  otherGap: ng.length ? { n: ng.length, min: Math.min(...ng), med: q(ng), max: Math.max(...ng),
    overMax: ng.filter((v) => v > LINK_MAX_GAP).length } : null,
  towerSpanFromGeometry: spans.length ? { n: spans.length, min: +Math.min(...spans).toFixed(2),
    med: +q(spans).toFixed(2), max: +Math.max(...spans).toFixed(2) } : null,
  walkLinks: out.links.towerPass + out.links.step,
  linkBreakdown: out.links, unbridged: out.unbridged, refusedSteps: out.refusedSteps,
  reachable: `${out.reachable}/${out.nRuns}`, worstStep: out.worstStep, worstPitch: out.worstPitch,
  bayLengthDrift: out.worstLenDrift, faults: out.faults.length,
};

if (AS_JSON) {
  console.log(JSON.stringify({ summary, ...out, pageErrors }, null, 2));
} else {
  console.log(`map ${MAP}${LABEL ? ` [${LABEL}]` : ''}: stations ${out.nStations}, runs ${out.nRuns}, `
    + `towers ${out.nTowers}, stairs ${out.stairSource}`);
  console.log(`self-checks: ${out.faults.length === 0 ? 'clean' : `${out.faults.length} FAULTS`}`);
  for (const f of out.faults) console.log(`  ! ${f}`);
  console.log(`  bay.length vs measured chord to next origin: worst ${out.worstLenDrift} m`);
  console.log(`  station frame round-trip: worst ${out.worstT} m`);

  console.log(`\n1. stations inside a tower footprint: ${out.inTower} of ${out.nStations} `
    + `(${((100 * out.inTower) / out.nStations).toFixed(1)} %), deepest ${out.worstIn} m in, at x ${out.worstInX}`);
  console.log(`2. station height against CitySystem.walkableTopAt (${out.checkedOff} sampled):`);
  console.log(`     worst ${out.worstOff >= 0 ? '+' : ''}${out.worstOff} m at station ${out.worstOffAt}, x ${out.worstOffX}`);
  console.log(`     over 0.05 m ${out.offBins.p05}   over 0.5 m ${out.offBins.p50}   `
    + `over 1.0 m ${out.offBins.p100}   over 2.0 m ${out.offBins.p200}`);
  for (const o of out.offRows.slice(0, 6)) {
    console.log(`       station ${String(o.i).padStart(5)} bay ${String(o.bay).padStart(3)} x ${String(o.x).padStart(7)} `
      + `t ${String(o.t).padStart(6)}  sy ${o.sy}  walk ${o.top}  off ${o.off > 0 ? '+' : ''}${o.off}`
      + `${o.inTower ? '  (in tower)' : ''}`);
  }
  console.log(`3. gaps at run boundaries, against LINK_MAX_GAP ${LINK_MAX_GAP}:`);
  if (summary.towerGap) {
    console.log(`     over a tower: n ${summary.towerGap.n}  ${summary.towerGap.min}–${summary.towerGap.max} m `
      + `(median ${summary.towerGap.med}), ${summary.towerGap.overMax} over the max`);
  }
  if (summary.otherGap) {
    console.log(`     elsewhere:    n ${summary.otherGap.n}  ${summary.otherGap.min}–${summary.otherGap.max} m `
      + `(median ${summary.otherGap.med}), ${summary.otherGap.overMax} over the max`);
  }
  if (summary.towerSpanFromGeometry) {
    const s = summary.towerSpanFromGeometry;
    console.log(`     from bay geometry, clear span each side of a tower: n ${s.n}  ${s.min}–${s.max} m (median ${s.med})`);
  }
  console.log(`4. links: walk-to-walk ${summary.walkLinks} `
    + `(towerPass ${out.links.towerPass}, step ${out.links.step}), stairs ${out.links.stair}`);
  console.log(`     ${out.unbridged} unbridged boundaries, ${out.refusedSteps} refused by the rake test`);
  console.log(`     reachable from a stair: ${out.reachable}/${out.nRuns} runs`);
  console.log(`     worst bridged step ${out.worstStep} m at pitch ${out.worstPitch}`);
}
await b.close();
if (out.faults.length > 0) process.exitCode = 1;
