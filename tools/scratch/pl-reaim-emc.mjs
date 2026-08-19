/** Select the tower party from the card bar and send its tower to a bay of my choosing. */
import { argsOf, boot, shot, fast, hover, rightClick, cam, aim, wallPixel, installDiag, ROOT } from './pl-lib-emc.mjs';
import path from 'node:path';
const A = argsOf();
const OUT = path.join(ROOT, 'screenshots/playability');
const { browser, page, errs } = await boot({ port: Number(A.get('port') ?? 5431), map: 'carthage', out: OUT, label: 'ra' });
await installDiag(page);
await page.mouse.move(800, 700); await page.waitForTimeout(300);
await page.click('.dep-begin'); await page.waitForTimeout(500);
await fast(page, 4);
const bays = await page.evaluate(() => window.__bays());

// The card bar: what does it offer, and where is each card?
const cards = await page.evaluate(() => Array.from(document.querySelectorAll('.cardbar .card:not(.mini)')).map((c, i) => {
  const r = c.getBoundingClientRect();
  return { i, name: c.querySelector('.card-name')?.textContent, n: c.querySelector('.card-count')?.textContent,
    x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
}));
console.log('own cards:', JSON.stringify(cards.slice(0, 8)));
const towerCard = cards.find(c => /Tower Party/i.test(c.name ?? ''));
console.log('clicking card', JSON.stringify(towerCard));
await page.mouse.click(towerCard.x, towerCard.y);
await page.waitForTimeout(300);
const sel = await page.evaluate(() => window.__cur().sel);
console.log('selection after the card click:', sel);
const before = await page.evaluate(() => window.__reports());
const mine = before.towers.map(t => ({ id: t.id, x: +t.x.toFixed(1), z: +t.z.toFixed(1), walkY: t.walkY }));
console.log('towers before:', JSON.stringify(mine));
console.log('which tower belongs to the selected party?', await page.evaluate((id) => {
  const s = window.__siege(); return s.towerReport().map((t, i) => i); }, sel[0]));

// Aim it at a bay 120 m along the wall.
const b = bays.find(x => x.i === 39);   // x ~ 218, far from every tower's own default
console.log('target bay', JSON.stringify(b));
const wp = await wallPixel(page, b, { side: 1, zoom: 0.62 });
console.log(`${wp.hit}/${wp.tried} pixels answer`);
if (wp.p) {
  const h = await hover(page, wp.p);
  console.log('cursor before I commit:', h.cursor);
  const d = await rightClick(page, wp.p, { hold: 500 });
  console.log('hint while held:', JSON.stringify(d.hint), 'cursor', d.cursor);
  await shot(page, OUT, 'ra-order');
  await page.waitForTimeout(400);
  for (const s of [15, 30, 45, 60, 60, 60, 60]) {
    await fast(page, s);
    const r = await page.evaluate(() => window.__reports());
    console.log(`  t+${r.t}  ` + r.towers.map(t => `T${t.id}[${t.state} x${t.x.toFixed(1)} z${t.z.toFixed(1)} gap${t.faceGap.toFixed(1)} walkY${t.walkY} crossed${t.crossed}]`).join(' '));
  }
  const r = await page.evaluate(() => window.__reports());
  const t0 = r.towers[0];
  await aim(page, t0.x, t0.deckY - 3, t0.z, { zoom: 0.5 });
  await shot(page, OUT, 'ra-after');
  console.log('did tower 0 go to bay 39 (x 217.6)?  x =', t0.x.toFixed(1));
}
console.log('errs', errs.length);
await browser.close();
