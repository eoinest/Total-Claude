#!/usr/bin/env node
/**
 * Where does the field army have to stand?
 *
 * Sweeps a rigid x-translation of the whole shipped deployment — every man, both armies,
 * nothing else touched — and counts, at each offset, the men in water, the men dry on the
 * far bank, the men on ground steeper than `ROUGH_SLOPE_IMPASSABLE`, and the men outside
 * their own deployment mask. The point is to find the offset rather than to assume it, and
 * to see the shape of the trade either side of it.
 *
 *   node tools/scratch/probe-deployshift.mjs --port=5341
 */
import { chromium } from 'playwright';
import path from 'node:path';
import process from 'node:process';
import { writeFile } from 'node:fs/promises';

const args = new Map(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
}));
const PORT = Number(args.get('port') ?? 5341);
const base = `http://127.0.0.1:${PORT}`;

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message.slice(0, 300)));
await page.goto(`${base}/?harness=1&quality=high&w=960&h=540`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 180000 });

const out = await page.evaluate(async () => {
  const g = window.__game;
  const t = g.engine.ctx.get('terrain');
  const topo = await import('/src/terrain/topography.ts');
  const WATER = topo.WATER_LEVEL;
  const IMPASSABLE = 0.62;
  const pool = g.battle.pool;
  const factions = [...new Set(g.battle.units.map((u) => u.faction))].sort((a, b) => a - b);
  const maskFor = (faction) => {
    const us = g.battle.units.filter((u) => u.faction === faction);
    const zc = us.reduce((s, u) => s + u.z, 0) / us.length;
    return zc < 0 ? topo.germanDeployMask : topo.romanDeployMask;
  };
  const rows = [];
  for (let dx = 0; dx <= 320; dx += 5) {
    const rec = { dx };
    for (const f of factions) {
      const mask = maskFor(f);
      let men = 0, wet = 0, far = 0, steep = 0, outside = 0;
      let minX = Infinity, maxX = -Infinity;
      for (let i = 0; i < pool.count; i++) {
        if (pool.faction[i] !== f || pool.hp[i] <= 0) continue;
        men++;
        const x = pool.x[i] + dx;
        const z = pool.z[i];
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        const h = t.heightAt(x, z);
        if (h < WATER) wet++;
        else if (x < topo.riverBankX(z, -1)) far++;
        const s = Math.hypot((t.heightAt(x + 4, z) - t.heightAt(x - 4, z)) / 8,
          (t.heightAt(x, z + 4) - t.heightAt(x, z - 4)) / 8);
        if (s > IMPASSABLE) steep++;
        if (mask(x, z) < 0.02) outside++;
      }
      rec[`f${f}`] = { men, wet, far, steep, outside, minX: +minX.toFixed(1), maxX: +maxX.toFixed(1) };
    }
    rows.push(rec);
  }
  return rows;
});

const keys = Object.keys(out[0]).filter((k) => k !== 'dx');
console.log('  dx | ' + keys.map((k) => `${k}: wet  far  steep out   xmin   xmax`).join('  |  '));
for (const r of out) {
  console.log(String(r.dx).padStart(4) + ' | ' + keys.map((k) => {
    const v = r[k];
    return `${String(v.wet).padStart(9)}${String(v.far).padStart(5)}${String(v.steep).padStart(6)}`
      + `${String(v.outside).padStart(5)}${String(v.minX).padStart(8)}${String(v.maxX).padStart(8)}`;
  }).join('  |  '));
}
if (args.get('json')) await writeFile(path.resolve(args.get('json')), JSON.stringify(out, null, 2));
await browser.close();
