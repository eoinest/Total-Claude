#!/usr/bin/env node
/**
 * Is the fighting corridor round the fight, and does the widened box leave a scarp?
 *
 * Two questions §15 task 14 has to answer with numbers rather than with a screenshot.
 *
 *  1. `battleCoreMask` is the corridor whose high-frequency relief is damped. Before the
 *     widening it was centred on x 0 with a 540 m half-width while the battle stood 271 m
 *     east of the axis, so the host's right wing fought outside it. This counts the men by
 *     corridor strength under the old rectangle and the new one, at the positions each rule
 *     actually produces.
 *  2. Flattening a box onto the regional plane and stopping is how you make a terrace. This
 *     sweeps the slope across each box's own east edge, inside and out, and prints the worst.
 *
 *   node tools/scratch/probe-corridor.mjs --port=5932
 */
import { chromium } from 'playwright';
import process from 'node:process';

const args = new Map(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
}));
const PORT = Number(args.get('port') ?? 5932);
const SHIFT_BACK = Number(args.get('shiftback') ?? 80); // the feather inset this pass added

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message.slice(0, 300)));
await page.goto(`http://127.0.0.1:${PORT}/?harness=1&quality=high&w=960&h=540`,
  { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 180000 });
await page.evaluate(() => window.__game.engine.stop());

const out = await page.evaluate(async (shiftBack) => {
  const g = window.__game;
  const t = g.engine.ctx.get('terrain');
  const topo = await import('/src/terrain/topography.ts');
  const maps = await import('/src/maps/index.ts');
  const ground = maps.activeMap().terrain.deploy;
  const rect = (x, z, cx, cz, hx, hz, f) => {
    const dx = 1 - Math.min(1, Math.max(0, (Math.abs(x - cx) - (hx - f)) / f));
    const dz = 1 - Math.min(1, Math.max(0, (Math.abs(z - cz) - (hz - f)) / f));
    return dx * dx * (3 - 2 * dx) * (dz * dz * (3 - 2 * dz));
  };
  // The rectangle that shipped at 5338249, and the one in the tree now.
  const before = (x, z) => rect(x, z, 0, -30, 540, 360, 170);
  const after = (x, z) => topo.battleCoreMask(x, z);

  const pool = g.battle.pool;
  const rows = [];
  for (const faction of [...new Set(g.battle.units.map((u) => u.faction))].sort()) {
    let n = 0, outB = 0, outA = 0, partB = 0, partA = 0;
    let minB = 1, minA = 1, eastB = -Infinity, eastA = -Infinity;
    for (let i = 0; i < pool.count; i++) {
      if (pool.faction[i] !== faction || pool.hp[i] <= 0) continue;
      n++;
      const xa = pool.x[i];
      const xb = xa - shiftBack; // where the same man stood before the inset
      const z = pool.z[i];
      const b = before(xb, z);
      const a = after(xa, z);
      if (b <= 0) outB++; else if (b < 1) partB++;
      if (a <= 0) outA++; else if (a < 1) partA++;
      if (b < minB) minB = b;
      if (a < minA) minA = a;
      if (xb > eastB) eastB = xb;
      if (xa > eastA) eastA = xa;
    }
    rows.push({
      faction, n,
      before: { outside: outB, partial: partB, weakest: +minB.toFixed(4), eastmost: +eastB.toFixed(1) },
      after: { outside: outA, partial: partA, weakest: +minA.toFixed(4), eastmost: +eastA.toFixed(1) },
    });
  }

  // Slope across each box's east edge, inside and out.
  const edges = [];
  for (const side of ['north', 'south']) {
    const box = ground[side];
    const x1 = box.cx + box.hx;
    let worst = 0, at = null;
    const prof = [];
    for (let x = x1 - 200; x <= x1 + 200; x += 5) {
      let w = 0;
      for (let z = box.cz - box.hz; z <= box.cz + box.hz; z += 8) {
        const s = Math.hypot((t.heightAt(x + 4, z) - t.heightAt(x - 4, z)) / 8,
          (t.heightAt(x, z + 4) - t.heightAt(x, z - 4)) / 8);
        if (s > w) w = s;
        if (s > worst) { worst = s; at = { x, z }; }
      }
      prof.push({ x, worst: +w.toFixed(3) });
    }
    edges.push({ side, edgeX: x1, worst: +worst.toFixed(3), at, prof });
  }
  return { rows, edges, ground };
}, SHIFT_BACK);

for (const r of out.rows) {
  console.log(`faction ${r.faction} (${r.n} men) — corridor`);
  console.log(`   before: ${r.before.outside} outside, ${r.before.partial} in the feather, `
    + `weakest ${r.before.weakest}, eastmost man x ${r.before.eastmost}`);
  console.log(`   after : ${r.after.outside} outside, ${r.after.partial} in the feather, `
    + `weakest ${r.after.weakest}, eastmost man x ${r.after.eastmost}`);
}
for (const e of out.edges) {
  console.log(`${e.side} box east edge x ${e.edgeX}: worst slope ±200 m across it ${e.worst}`
    + ` at (${e.at.x}, ${e.at.z})`);
  console.log('   ' + e.prof.filter((p) => p.x % 20 === 0).map((p) => `${p.x}:${p.worst}`).join(' '));
}
await browser.close();
