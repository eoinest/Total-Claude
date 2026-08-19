/** Where on the screen does a unit's crowd actually answer to the mouse? */
import { argsOf, boot, cam, shot, ROOT } from './pl-lib-emc.mjs';
import path from 'node:path';
const A = argsOf();
const OUT = path.join(ROOT, 'screenshots/playability');
const { browser, page } = await boot({ port: Number(A.get('port') ?? 5431), map: A.get('map') ?? 'carthage', out: OUT, label: 'grid' });
await page.mouse.move(800, 620); await page.waitForTimeout(400);

await page.evaluate(() => {
  const g = window.__game;
  /** Screen bounding box of a unit's living men, at their own drawn height. */
  window.__box = (id) => {
    const u = g.battle.unitById(id); const p = g.battle.pool;
    let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9, n = 0;
    for (const i of u.members) {
      if (p.hp[i] <= 0) continue;
      const a = window.__P(p.x[i], p.y[i], p.z[i]);        // feet
      const b = window.__P(p.x[i], p.y[i] + 1.75, p.z[i]); // head
      for (const q of [a, b]) { if (!q) continue; n++; x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x); y0 = Math.min(y0, q.y); y1 = Math.max(y1, q.y); }
    }
    const v = window.__ctl().model.view(id);
    return { n, x0: Math.round(x0), x1: Math.round(x1), y0: Math.round(y0), y1: Math.round(y1),
      view: v ? { cx: +v.cx.toFixed(1), cz: +v.cz.toFixed(1), cy: +v.cy.toFixed(1), standY: +v.standY.toFixed(1), w: v.unit.width, sx: v.unit.spacingX, sz: v.unit.spacingZ, alive: v.alive } : null };
  };
});

async function scan(id, label) {
  const box = await page.evaluate((i) => window.__box(i), id);
  console.log(`\n${label} unit ${id}  crowd box x ${box.x0}..${box.x1} y ${box.y0}..${box.y1}  view`, JSON.stringify(box.view));
  const xs = [], ys = [];
  const nx = 9, ny = 9;
  for (let i = 0; i < nx; i++) xs.push(Math.round(box.x0 + (box.x1 - box.x0) * i / (nx - 1)));
  for (let j = 0; j < ny; j++) ys.push(Math.round(box.y0 + (box.y1 - box.y0) * j / (ny - 1)));
  let hits = 0, tot = 0;
  for (const y of ys) {
    let row = '';
    for (const x of xs) {
      if (x < 2 || x > 1598 || y < 2 || y > 898) { row += ' '; continue; }
      await page.mouse.move(x, y); await page.waitForTimeout(45);
      const h = await page.evaluate(() => window.__cur());
      tot++;
      if (h.hovered === id) { row += '#'; hits++; } else if (h.hovered >= 0) row += 'o'; else row += '.';
    }
    console.log(`  y=${String(y).padStart(4)} ${row}`);
  }
  console.log(`  ${label}: ${hits}/${tot} sampled pixels answer to this unit`);
}

if (A.get('begin')) { await page.click('.dep-begin'); await page.waitForTimeout(500); await page.evaluate(() => window.__game.engine.advance(3, 166)); await page.waitForTimeout(300); console.log('battle begun, t=', await page.evaluate(() => window.__game.simTime())); }
const own = await page.evaluate(() => window.__units(0));
const coh = own.filter(u => u.type === 'legio-cohort')[2];
for (const z of [0.42, 0.55]) { await cam(page, coh.x, coh.z - 12, z, 0); await page.waitForTimeout(700); await scan(coh.id, `own cohort zoom ${z}`); }
await shot(page, OUT, 'grid-cohort');

const bays = await page.evaluate(() => window.__bays());
const b = bays.find(x => x.i === 29);
const enemy = (await page.evaluate(() => window.__units(2))).filter(u => u.elevated > 0);
const e = enemy.reduce((a, u) => Math.abs(u.x - b.cx) < Math.abs(a.x - b.cx) ? u : a);
for (const z of [0.55, 0.68]) { await cam(page, e.x, e.z + 6, z, 0); await page.waitForTimeout(700); await scan(e.id, `wall garrison zoom ${z}`); }
await shot(page, OUT, 'grid-garrison');
await browser.close();
