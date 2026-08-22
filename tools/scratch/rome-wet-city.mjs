#!/usr/bin/env node
/**
 * **Is any of the city standing in the Tiber?**
 *
 * Written because a review render looked as though it might be, and squinting at a screenshot
 * is not a measurement. It reads every solid the collision layer publishes — monuments and
 * insulae together, which is the population `assertNoFootprintOverlaps` has never had — and
 * asks the terrain for the ground under each one. Two independent tests, because either alone
 * can be fooled:
 *
 *   **wet**    the sampled ground under the footprint is at or below `WATER_LEVEL`. This is
 *              what the player sees: a building with water lapping its walls.
 *   **inside** the footprint crosses the channel between `riverBankX(z, -1)` and
 *              `riverBankX(z, +1)`. This is what the *plan* did wrong, and it is the one that
 *              survives a terrain change.
 *
 *   node tools/scratch/rome-wet-city.mjs --port=5917
 */
import { chromium } from 'playwright';

const arg = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split('=')[1];
const PORT = Number(arg('port', 5917));
const MAP = arg('map', 'campus-martius');
const SCENARIO = arg('scenario', 'assault');

const token = Buffer.from(JSON.stringify({ map: MAP, scenario: SCENARIO }))
  .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto(
  `http://127.0.0.1:${PORT}/?harness=1&w=1280&h=720&quality=ultra&scenario=${SCENARIO}&battle=${token}`,
  { waitUntil: 'domcontentloaded', timeout: 120000 }
);
await page.waitForFunction(() => window.__game && window.__game.ready, null, { timeout: 240000 });

const out = await page.evaluate(async () => {
  const g = window.__game;
  const terrain = g.engine.ctx.get('terrain');
  const topo = await import('/src/terrain/topography.ts');
  const layout = await import('/src/city/rome/layout.ts');
  const WATER = topo.WATER_LEVEL;
  const city = g.engine.ctx.tryGet('city');
  const obst = city.getObstacles();

  const rows = [];
  for (const o of obst) {
    const hw = o.hw ?? o.halfWidth ?? 0;
    const hd = o.hd ?? o.halfDepth ?? 0;
    if (!Number.isFinite(hw) || !Number.isFinite(hd) || (hw === 0 && hd === 0)) continue;
    const rot = o.rot ?? 0;
    let wet = 0;
    let inChannel = 0;
    let n = 0;
    let lowest = Infinity;
    for (const su of [-1, 0, 1]) {
      for (const sv of [-1, 0, 1]) {
        const x = o.x + Math.cos(rot) * hw * su + Math.sin(rot) * hd * sv;
        const z = o.z + -Math.sin(rot) * hw * su + Math.cos(rot) * hd * sv;
        const y = terrain.heightAt(x, z);
        n++;
        if (y <= WATER) wet++;
        lowest = Math.min(lowest, y);
        const w = topo.riverBankX(z, -1);
        const e = topo.riverBankX(z, 1);
        if (x > Math.min(w, e) && x < Math.max(w, e)) inChannel++;
      }
    }
    if (wet > 0 || inChannel > 0) {
      rows.push({ id: o.id ?? '(insula)', x: +o.x.toFixed(1), z: +o.z.toFixed(1), wet, inChannel, n, lowest: +lowest.toFixed(2) });
    }
  }
  const landmarkIds = new Set(layout.LANDMARKS.map((l) => l.id));
  return {
    water: WATER,
    total: obst.length,
    hits: rows.length,
    fullyWet: rows.filter((r) => r.wet === r.n).length,
    monuments: rows.filter((r) => landmarkIds.has(r.id)).map((r) => r.id),
    worst: rows.sort((a, b) => b.wet - a.wet || b.inChannel - a.inChannel).slice(0, 12),
  };
});
await browser.close();
console.log(JSON.stringify(out, null, 2));
