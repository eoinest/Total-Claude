#!/usr/bin/env node
/**
 * Scratch instrument for docs/ROME.md, written at 3595b48.
 *
 * Three questions the redesign turns on, asked of the running simulation rather than of the
 * plan:
 *   1. Where is the circuit open? Drive a 32 m segment through the wall line at 2 m
 *      intervals **and past both ends, out to the map edge**, and ask
 *      `CitySystem.blocksMovement`. Commit 7340d02 did the first half; the second half is
 *      the whole point.
 *   2. What does the spine actually come to? `Siege.wallReport()`.
 *   3. What does the city measure itself as? `CitySystem.stats()`.
 *
 * Usage: node tools/scratch/probe-romeflank.mjs --port=5926 [--map=campus-martius]
 */
import { chromium } from 'playwright';

const args = new Map(process.argv.slice(2).map((a) => { const [k,v]=a.replace(/^--/,'').split('='); return [k, v ?? '1']; }));
const PORT = Number(args.get('port') ?? 5926);
const MAP = args.get('map') ?? 'campus-martius';
const token = Buffer.from(JSON.stringify({ map: MAP, scenario: 'assault' })).toString('base64')
  .replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const url = `http://127.0.0.1:${PORT}/?harness=1&w=1280&h=720&quality=ultra&scenario=assault&battle=${token}`;
console.log('[flank]', url);

// refuse a stale dist
const r = await fetch(`http://127.0.0.1:${PORT}/src/main.ts`).catch(() => null);
if (!r || !r.ok) { console.error('no dev server answering /src/main.ts on', PORT); process.exit(2); }

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.log('  pageerror:', e.message));
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForFunction(() => window.__game && window.__game.ready, null, { timeout: 180000 });

const out = await page.evaluate(() => {
  const g = window.__game;
  const city = g.engine.ctx.tryGet('city');
  const HALF = 1400;
  const bays = city.getGarrisonBays();
  const xs = bays.map((b) => b.x0);
  const wallXMin = Math.min(...xs);
  const wallXMax = Math.max(...bays.map((b) => b.x1 ?? b.x0));
  // z of the wall line, interpolated from the bays; outside their span, hold the end value.
  const zAt = (x) => {
    let best = bays[0], bd = 1e9;
    for (const b of bays) { const d = Math.abs((b.x0 + (b.x1 ?? b.x0)) * 0.5 - x); if (d < bd) { bd = d; best = b; } }
    return (best.z0 + (best.z1 ?? best.z0)) * 0.5;
  };
  const open = [];
  let run = null;
  for (let x = -HALF; x <= HALF; x += 2) {
    const z = zAt(x);
    const blocked = city.blocksMovement(x, z - 16, x, z + 16);
    if (!blocked) { if (!run) run = { x0: x, x1: x }; else run.x1 = x; }
    else if (run) { open.push(run); run = null; }
  }
  if (run) open.push(run);
  const seg = city.getWallSegments();
  const gates = city.getGates().map((q) => ({ id: q.id, x: +q.x.toFixed(1), z: +q.z.toFixed(1), open: q.open }));
  const stairs = (city.getWallStairs?.() ?? []).map((s) => ({ x: +s.footX.toFixed(1), rise: +s.rise.toFixed(2), w: s.width }));
  const wr = g.battle?.elevation?.wallReport ? g.battle.elevation.wallReport() : (g.siege?.wallReport?.() ?? null);
  const st = city.stats();
  return {
    bays: bays.length,
    wallXMin: +wallXMin.toFixed(1), wallXMax: +wallXMax.toFixed(1),
    segments: seg.length,
    segXMin: +Math.min(...seg.map(s=>Math.min(s.x1,s.x2))).toFixed(1),
    segXMax: +Math.max(...seg.map(s=>Math.max(s.x1,s.x2))).toFixed(1),
    open: open.map((o) => ({ x0: o.x0, x1: o.x1, w: o.x1 - o.x0 + 2 })),
    gates, stairCount: stairs.length, stairs,
    wallReport: wr,
    stats: { draws: st.visibleMeshes, tris: st.visibleTriangles, chunks: st.chunks,
             checks: st.checks ?? null, drawsByFamily: st.drawsByFamily },
  };
});
console.log(JSON.stringify(out, null, 2).slice(0, 9000));
await browser.close();
