#!/usr/bin/env node
/**
 * Dump one map's `[city…]` boot lines and its `CityChecks` bag.
 *
 * A one-purpose reader, not an instrument: it prints what the build says about itself so the
 * numbers can be read without parsing a screenshot. The instruments are
 * `probe-rometransect.mjs`, `probe-romecircuit.mjs` and `tools/probe-fabric.mjs`.
 *
 *   node tools/scratch/rome-bootlog.mjs --port=5917 [--map=campus-martius]
 */
import { chromium } from 'playwright';

const arg = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split('=')[1];
const PORT = Number(arg('port', 5917));
const MAP = arg('map', 'campus-martius');
const SCENARIO = arg('scenario', 'assault');

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const lines = [];
page.on('console', (m) => {
  const t = m.text();
  if (t.startsWith('[city')) lines.push(`${m.type() === 'warning' ? 'WARN ' : '     '}${t}`);
});
page.on('pageerror', (e) => lines.push(`ERROR ${e.message}`));
const token = Buffer.from(JSON.stringify({ map: MAP, scenario: SCENARIO }))
  .toString('base64')
  .replace(/\+/g, '-')
  .replace(/\//g, '_')
  .replace(/=+$/, '');
await page.goto(
  `http://127.0.0.1:${PORT}/?harness=1&w=1280&h=720&quality=ultra&scenario=${SCENARIO}&battle=${token}`,
  { waitUntil: 'domcontentloaded', timeout: 120000 }
);
await page.waitForFunction(() => window.__game && window.__game.ready, null, { timeout: 240000 });
await page.waitForTimeout(1500);
for (const l of lines) console.log(l);

const frame = await page.evaluate(() => window.__game.engine.ctx.tryGet('city')?.stats?.()?.romeFrame ?? null);
const section = await page.evaluate(() => {
  const s = window.__game.engine.ctx.tryGet('city')?.stats?.()?.romeSection;
  if (!s) return null;
  return {
    bays: s.bays, pitch: s.pitch, westEnd: s.westEnd, eastEnd: s.eastEnd,
    pitchDeviation: s.pitchDeviation, worstWalkStep: s.worstWalkStep, worstWalkStepX: s.worstWalkStepX,
    worstWalkRake: s.worstWalkRake, baysBelowWater: s.baysBelowWater, worstLane: s.worstLane,
    tortoBays: s.tortoBays, tortoWorstApron: s.tortoWorstApron, stages: s.stages, faults: s.faults,
  };
});
console.log('\n--- romeSection ---');
console.log(JSON.stringify(section, null, 2));
const counts = await page.evaluate(() => {
  const st = window.__game.engine.ctx.tryGet('city')?.stats?.();
  if (!st) return null;
  const city = window.__game.engine.ctx.tryGet('city');
  const obst = city.getObstacles ? city.getObstacles() : null;
  return {
    obstacles: obst ? obst.length : null,
    chunks: st.chunks, meshes: st.meshes, triangles: st.triangles,
    footprintOverlaps: st.footprintOverlaps, footprintOverlapWorst: st.footprintOverlapWorst,
    topologyPass: st.topologyPass, topologyChecks: st.topologyChecks,
    fabricOverlaps: st.fabricOverlaps, fabricOverlapWorst: st.fabricOverlapWorst,
    wayInsideMonument: st.wayInsideMonument, waySamples: st.waySamples,
    strayGeometry: st.strayGeometry, amphitheatres: st.amphitheatres, ways: st.ways,
  };
});
const drift = await page.evaluate(async () => {
  const L = await import('/src/city/rome/layout.ts');
  const rows = L.LANDMARKS.filter((l) => !l.soft).map((l) => {
    const dx = l.x - l.idealX;
    const dz = l.z - l.idealZ;
    return { id: l.id, d: Math.sqrt(dx * dx + dz * dz) };
  }).sort((a, b) => b.d - a.d);
  const n = rows.length;
  return {
    n,
    mean: +(rows.reduce((s, r) => s + r.d, 0) / n).toFixed(2),
    worst: +rows[0].d.toFixed(2),
    worstId: rows[0].id,
    over50: rows.filter((r) => r.d > 50).length,
    top: rows.slice(0, 8).map((r) => `${r.id} ${r.d.toFixed(1)}`),
  };
});
console.log('\n--- resolveOverlaps displacement (from each monument own idealX/idealZ) ---');
console.log(JSON.stringify(drift, null, 2));
console.log('\n--- counts ---');
console.log(JSON.stringify(counts, null, 2));
console.log('\n--- romeFrame ---');
console.log(JSON.stringify(frame, null, 2));
await browser.close();
