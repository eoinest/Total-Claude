#!/usr/bin/env node
/**
 * The wall as a graph, and whether the code that routes on it agrees with the graph.
 *
 * Read-only. Three questions:
 *   1. runs, links, connected components — is the circuit one walk or several?
 *   2. `nearestStairLink(x, z, run)` — for every run, is the stair it names one the unit
 *      can actually walk to, and is it the nearest such stair *along the walk*?
 *   3. `wallTargetAt` — what fraction of the parapet does the order gate accept?
 */
import { chromium } from 'playwright';
const PORT = Number(process.argv.find((a) => a.startsWith('--port='))?.slice(7) ?? 5491);
const MAP = process.argv.find((a) => a.startsWith('--map='))?.slice(6) ?? '';
const base = `http://127.0.0.1:${PORT}`;
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 480, height: 270 } });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
await page.goto(`${base}/?harness=1&autoplay=0&quality=low&w=480&h=270&scenario=assault${MAP ? `&map=${MAP}` : ''}`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 180000 });
const r = await page.evaluate(() => {
  const g = window.__game, b = g.battle, s = b.siege;
  g.engine.stop();
  for (let k = 0; k < 30; k++) g.engine.advance(1 / 30, 1000 / 60, { render: false });

  const nRuns = s.runNext.length;
  const runStations = new Array(nRuns).fill(0);
  for (let i = 0; i < s.stationCount; i++) runStations[s.sRun[i]]++;
  const runLo = [], runHi = [];
  for (let r = 0; r < nRuns; r++) { runLo[r] = -1; runHi[r] = -1; }
  for (let i = 0; i < s.stationCount; i++) {
    const r = s.sRun[i];
    if (runLo[r] < 0) runLo[r] = i;
    runHi[r] = i;
  }

  // Connected components under the chain rule the sim actually uses.
  const comp = new Array(nRuns).fill(-1);
  let nc = 0;
  for (let r = 0; r < nRuns; r++) {
    if (comp[r] >= 0) continue;
    let e = r;
    while (e + 1 < nRuns && s.runNext[e] >= 0) e++;
    for (let k = r; k <= e; k++) comp[k] = nc;
    nc++;
  }
  const compSize = {};
  for (const c of comp) compSize[c] = (compSize[c] ?? 0) + 1;

  const stairs = s.links.filter((l) => l.kind === 2)
    .map((l) => ({ id: l.id, runB: l.runB, ax: l.ax, az: l.az }));
  const stairRuns = stairs.map((x) => x.runB);
  const runsWithTwoStairs = {};
  for (const r of stairRuns) runsWithTwoStairs[r] = (runsWithTwoStairs[r] ?? 0) + 1;

  /**
   * Walk distance between two stations, in metres along the wall, or Infinity if the walk
   * is severed. Station pitch is 0.86; a tower pass is charged its own plan length.
   */
  const linkGap = (r) => {
    const l = s.links[s.runNext[r]];
    return l ? Math.hypot(l.ax - l.bx, l.az - l.bz) + Math.abs(l.ay - l.by) : Infinity;
  };
  const walkDist = (fromStation, toRun) => {
    const fr = s.sRun[fromStation];
    if (fr === toRun) return Math.abs(fromStation - Math.floor((runLo[toRun] + runHi[toRun]) / 2)) * 0.86;
    if (comp[fr] !== comp[toRun]) return Infinity;
    let d = 0;
    if (fr < toRun) {
      d += (runHi[fr] - fromStation) * 0.86;
      for (let r = fr; r < toRun; r++) { d += linkGap(r); if (r + 1 < toRun) d += (runHi[r + 1] - runLo[r + 1]) * 0.86; }
    } else {
      d += (fromStation - runLo[fr]) * 0.86;
      for (let r = toRun - 1; r >= fr; r--) { /* symmetric */ }
      for (let r = toRun; r < fr; r++) { d += linkGap(r); if (r > toRun) d += (runHi[r] - runLo[r]) * 0.86; }
    }
    return d;
  };

  /**
   * For a man standing at the middle of each run: what stair does `nearestStairLink` pick,
   * is it reachable from where he is, and what is the nearest reachable stair along the walk?
   */
  const audit = [];
  for (let r = 0; r < nRuns; r++) {
    if (runStations[r] === 0) continue;
    const mid = Math.floor((runLo[r] + runHi[r]) / 2);
    const x = s.sx[mid], z = s.sz[mid];
    const picked = s.nearestStairLink(x, z, r);
    const pl = picked >= 0 ? s.links[picked] : null;
    const pickedRun = pl ? pl.runB : -1;
    const pickedReach = pickedRun >= 0 && comp[pickedRun] === comp[r];
    let bestId = -1, bestD = Infinity;
    for (const st of stairs) {
      if (comp[st.runB] !== comp[r]) continue;
      const d = walkDist(mid, st.runB);
      if (d < bestD) { bestD = d; bestId = st.id; }
    }
    audit.push({
      run: r, stations: runStations[r], comp: comp[r], mid,
      picked, pickedRun, pickedReach,
      pickedWalk: pickedReach ? +walkDist(mid, pickedRun).toFixed(0) : null,
      pickedPlan: pl ? +Math.hypot(pl.ax - x, pl.az - z).toFixed(0) : null,
      bestReachable: bestId, bestWalk: bestD === Infinity ? null : +bestD.toFixed(0),
      agrees: picked === bestId,
    });
  }

  /** How much of the parapet the order gate accepts, sampled along the spine itself. */
  let onSpine = 0, offSpine = 0;
  const holes = [];
  for (let i = 0; i < s.stationCount; i++) {
    if (s.wallTargetAt(s.sx[i], s.sz[i]) >= 0) onSpine++; else { offSpine++; holes.push(i); }
  }
  // And at the midpoint between consecutive stations of the same run, which is where a
  // click actually lands.
  let midOk = 0, midBad = 0;
  for (let i = 0; i + 1 < s.stationCount; i++) {
    if (s.sRun[i] !== s.sRun[i + 1]) continue;
    const x = (s.sx[i] + s.sx[i + 1]) / 2, z = (s.sz[i] + s.sz[i + 1]) / 2;
    if (s.wallTargetAt(x, z) >= 0) midOk++; else midBad++;
  }
  // And the published bay midpoints — what a UI or a probe naturally aims at.
  const city = g.engine.context.get('city');
  const bays = city.getGarrisonBays().filter((q) => q.garrisonable);
  let bayOk = 0; const bayBad = [];
  for (const q of bays) {
    const x = (q.x0 + q.x1) / 2, z = (q.z0 + q.z1) / 2;
    if (s.wallTargetAt(x, z) >= 0) bayOk++; else bayBad.push(q.index);
  }

  return {
    stationCount: s.stationCount, nRuns,
    runsWithStations: runStations.filter((n) => n > 0).length,
    components: nc, compSize,
    severedAt: Array.from(s.runNext).map((v, i) => (v < 0 && i + 1 < nRuns ? i : -1)).filter((v) => v >= 0),
    links: { total: s.links.length, stair: stairs.length,
      tower: s.links.filter((l) => l.kind === 0).length,
      step: s.links.filter((l) => l.kind === 1).length,
      other: s.links.filter((l) => l.kind > 2).length },
    stairRuns, runsWithTwoStairs: Object.entries(runsWithTwoStairs).filter(([, n]) => n > 1),
    stairAudit: audit,
    stairAuditBad: audit.filter((a) => !a.pickedReach || !a.agrees),
    gate: { spineOk: onSpine, spineBad: offSpine, midOk, midBad,
      bayMidOk: bayOk, bayMidBad: bayBad.length, bayBad },
    runStations,
  };
});
console.log(JSON.stringify(r, null, 1));
if (errs.length) console.log('errs', errs);
await browser.close();
