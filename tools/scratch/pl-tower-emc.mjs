import { argsOf, boot, cam, shot, hover, leftClick, rightClick, proj, aim, fast, ROOT } from './pl-lib-emc.mjs';
import path from 'node:path';
const A = argsOf();
const OUT = path.join(ROOT, 'screenshots/playability');
const { browser, page } = await boot({ port: Number(A.get('port') ?? 5431), map: 'carthage', out: OUT, label: 'tw' });
await page.mouse.move(800, 620); await page.waitForTimeout(300);
await page.click('.dep-begin'); await page.waitForTimeout(400);
await fast(page, 5);
await page.evaluate(() => {
  const g = window.__game;
  window.__box = (id) => {
    const u = g.battle.unitById(id); const p = g.battle.pool;
    let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9, n = 0;
    for (const i of u.members) { if (p.hp[i] <= 0) continue;
      for (const q of [window.__P(p.x[i], p.y[i], p.z[i]), window.__P(p.x[i], p.y[i] + 1.7, p.z[i])]) {
        if (!q) continue; n++; x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x); y0 = Math.min(y0, q.y); y1 = Math.max(y1, q.y); } }
    const v = window.__ctl().model.view(id);
    return { n, x0: Math.round(x0), x1: Math.round(x1), y0: Math.round(y0), y1: Math.round(y1),
      view: { cx: +v.cx.toFixed(1), cz: +v.cz.toFixed(1), cy: +v.cy.toFixed(1), standY: +v.standY.toFixed(1), frontage: +v.frontage.toFixed(1), depth: +v.depth.toFixed(1), w: v.unit.width, facing: +v.unit.facing.toFixed(2) },
      anchor: { x: +u.x.toFixed(1), z: +u.z.toFixed(1) } };
  };
});
const tp = (await page.evaluate(() => window.__units(0))).filter(u => u.type === 'legio-tower-party')[0];
console.log('tower party', tp);
await cam(page, tp.x, tp.z - 20, 0.55, 0); await page.waitForTimeout(700);
const box = await page.evaluate((i) => window.__box(i), tp.id);
console.log('box', JSON.stringify(box));
let hit = null;
for (let j = 0; j < 11; j++) {
  let row = '';
  const y = Math.round(box.y0 + (box.y1 - box.y0) * j / 10);
  for (let i = 0; i < 15; i++) {
    const x = Math.round(box.x0 + (box.x1 - box.x0) * i / 14);
    if (x < 2 || x > 1598 || y < 2 || y > 898) { row += ' '; continue; }
    await page.mouse.move(x, y); await page.waitForTimeout(40);
    const h = await page.evaluate(() => window.__cur());
    if (h.hovered === tp.id) { row += '#'; hit = hit ?? { x, y }; } else if (h.hovered >= 0) row += String(h.hovered % 10); else row += '.';
  }
  console.log(`  y=${String(y).padStart(4)} ${row}`);
}
console.log('first hit', hit);
await shot(page, OUT, 'tw-box');
if (hit) {
  await leftClick(page, hit);
  console.log('selected', await page.evaluate(() => window.__cur().sel));
  const bays = await page.evaluate(() => window.__bays());
  const tgt = bays.find(b => b.i === 27);
  const pt = await aim(page, tgt.cx, tgt.walkY - 6, tgt.cz + 2, { zoom: 0.55 });
  console.log('bay 27 at', pt);
  console.log('HOVER ->', await hover(page, pt));
  await shot(page, OUT, 'tw-hover-bay27');
  const d = await rightClick(page, pt, { hold: 500 });
  console.log('HELD ->', JSON.stringify(d));
  await shot(page, OUT, 'tw-held-bay27');
  await page.waitForTimeout(400);
  let rep = await page.evaluate(() => window.__reports());
  console.log('towers', rep.towers.map(t => ({ id: t.id, x: +t.x.toFixed(1), z: +t.z.toFixed(1), st: t.state, gap: +t.faceGap.toFixed(1), walkY: t.walkY })));
  for (let k = 0; k < 12; k++) {
    await fast(page, 20);
    rep = await page.evaluate(() => window.__reports());
    const t = rep.towers[0];
    console.log(`  t+${rep.t} tower0 x=${t.x.toFixed(1)} z=${t.z.toFixed(1)} ${t.state} gap=${t.faceGap.toFixed(2)} rampY=${t.rampY.toFixed(2)} walk=${t.walkY} crossed=${t.crossed} docked=${t.docked} rampReach=${t.rampReach.toFixed(3)} headOff=${t.rampHeadOff.toFixed(2)} want=${t.wantHeadOff.toFixed(2)}`);
    if (t.docked && t.crossed > 30) break;
  }
  await aim(page, rep.towers[0].x, rep.towers[0].deckY - 4, rep.towers[0].z, { zoom: 0.5 });
  await shot(page, OUT, 'tw-docked');
}
await browser.close();
