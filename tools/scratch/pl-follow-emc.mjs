/** Follow-ups: the tower party's click target, the silent refusal, the cursor/hint split,
 *  the wall marker, and whether the card bar rescues an unpickable unit. */
import { argsOf, boot, shot, fast, hover, rightClick, leftClick, cam, proj, aim,
  selectHard, wallPixel, installDiag, ROOT } from './pl-lib-emc.mjs';
import path from 'node:path';
const A = argsOf();
const MAP = A.get('map') ?? 'carthage';
const OUT = path.join(ROOT, 'screenshots/playability');
const { browser, page, errs } = await boot({ port: Number(A.get('port') ?? 5431), map: MAP, out: OUT, label: 'fu' });
await installDiag(page);
await page.mouse.move(800, 700); await page.waitForTimeout(300);
await page.click('.dep-begin'); await page.waitForTimeout(500);
await fast(page, 4);
const bays = await page.evaluate(() => window.__bays());

// --- F2: the tower party's click target, across zooms, against a cohort control.
console.log('\n-- how many of a unit\'s own crowd pixels select it');
for (const [label, pick] of [['tower party', u => u.type === 'legio-tower-party'], ['ladder party', u => u.type === 'legio-escalade'],
  ['ram crew', u => u.type === 'legio-ram-crew'], ['line cohort', u => u.type === 'legio-cohort'], ['artillery', u => u.type === 'legio-ballista']]) {
  const u = (await page.evaluate(() => window.__units(0))).find(pick);
  if (!u) { console.log(`  ${label}: none`); continue; }
  const geo = await page.evaluate((i) => { const v = window.__ctl().model.view(i); const g = window.__game.battle.unitById(i);
    return { frontage: +v.frontage.toFixed(1), depth: +v.depth.toFixed(1), width: g.width, form: g.formationId, sx: g.spacingX, sz: g.spacingZ, alive: g.alive }; }, u.id);
  const out = [];
  for (const zoom of [0.42, 0.55, 0.68]) {
    await cam(page, u.x, u.z - 10, zoom, 0); await page.waitForTimeout(500);
    const box = await page.evaluate((i) => window.__box(i), u.id);
    let hit = 0, tot = 0;
    for (let j = 0; j <= 6; j++) for (let i = 0; i <= 10; i++) {
      const x = Math.round(box.x0 + (box.x1 - box.x0) * i / 10), y = Math.round(box.y0 + (box.y1 - box.y0) * j / 6);
      if (x < 4 || x > 1596 || y < 110 || y > 760) continue;
      await page.mouse.move(x, y); await page.waitForTimeout(30);
      tot++; if ((await page.evaluate(() => window.__cur())).hovered === u.id) hit++;
    }
    out.push(`zoom ${zoom}: ${hit}/${tot}`);
  }
  console.log(`  ${label} ${u.id} (${geo.alive} men, ${geo.form}, ${geo.width} wide, frontage ${geo.frontage} m x depth ${geo.depth} m): ${out.join('  ')}`);
}

// --- can the card bar rescue it?
console.log('\n-- the unit card bar as a way in');
const tp = (await page.evaluate(() => window.__units(0))).find(u => u.type === 'legio-tower-party');
const cards = await page.evaluate(() => Array.from(document.querySelectorAll('.card, .uc, .unitcard, [data-unit-id]')).length);
console.log('  card elements found:', cards, await page.evaluate(() => Array.from(document.querySelectorAll('.cards, .cardbar, .uc-bar')).map(e => e.className)));
const cardInfo = await page.evaluate((id) => {
  const bar = document.querySelector('.cards, .cardbar, .uc-bar, .unitcards');
  if (!bar) return { bar: null, all: Array.from(document.querySelectorAll('div')).map(d => d.className).filter(c => /card/i.test(c)).slice(0, 12) };
  const kids = Array.from(bar.querySelectorAll('*')).filter(e => e.dataset && e.dataset.unit !== undefined);
  return { bar: bar.className, n: kids.length, ids: kids.map(k => k.dataset.unit).slice(0, 40) };
}, tp.id);
console.log(' ', JSON.stringify(cardInfo));

// --- F3: order a cohort at a bay with no ladders, and see what it is told and what it does.
console.log('\n-- a storm order at a bay with nothing to climb');
const coh = (await page.evaluate(() => window.__units(0))).find(u => u.type === 'legio-cohort' && Math.abs(u.x - 30) < 40);
let s = await selectHard(page, coh.id, { zoom: 0.55 });
console.log('  select cohort', coh.id, s.ok ? 'OK' : 'FAILED');
if (s.ok) {
  const b = bays.find(x => x.i === 33);
  const wp = await wallPixel(page, b, { side: 1, zoom: 0.62 });
  console.log(`  bay 33 (no ladder bank within 50 m): ${wp.hit}/${wp.tried} pixels answer`);
  if (wp.p) {
    const d = await rightClick(page, wp.p, { hold: 450 });
    console.log('  hint:', JSON.stringify(d.hint), 'cursor', d.cursor);
    await page.waitForTimeout(400);
    const o1 = await page.evaluate((i) => { const u = window.__game.battle.unitById(i); return { order: u.order, tx: +u.targetX.toFixed(1), tz: +u.targetZ.toFixed(1), owned: window.__siege().ownsUnit(i) }; }, coh.id);
    console.log('  right after the order:', JSON.stringify(o1), await page.evaluate((i) => window.__wallState(i), coh.id));
    await fast(page, 45);
    const o2 = await page.evaluate((i) => { const u = window.__game.battle.unitById(i); return { order: u.order, x: +u.x.toFixed(1), z: +u.z.toFixed(1), owned: window.__siege().ownsUnit(i) }; }, coh.id);
    console.log('  45 s later:', JSON.stringify(o2), await page.evaluate((i) => window.__u(i), coh.id));
    console.log('  what the command panel says:', await page.evaluate(() => document.querySelector('.cmd-state')?.textContent?.replace(/\s+/g, ' ')));
    console.log('  event feed:', await page.evaluate(() => Array.from(document.querySelectorAll('.feed *')).slice(-6).map(e => e.textContent.replace(/\s+/g, ' ')).filter(Boolean).slice(-4)));
    await shot(page, OUT, 'fu-refused');
  }
}

// --- F4/F5: cursor vs hint over an enemy standing on the parapet, and the wall marker.
console.log('\n-- cursor and hint over an enemy on the parapet');
const foe = (await page.evaluate(() => window.__units(2))).filter(u => u.elevated > 20)[0];
const fp = await aim(page, foe.x, foe.meanY + 0.9, foe.z, { zoom: 0.6 });
if (fp) {
  const h = await hover(page, fp);
  const d = await rightClick(page, fp, { hold: 500 });
  console.log(`  hovering ${foe.type} ${foe.id}: cursor=${h.cursor} hovered=${h.hovered} wallValid=${h.wallValid}`);
  console.log(`  while held: cursor=${d.cursor} hint=${JSON.stringify(d.hint)}`);
  await shot(page, OUT, 'fu-cursorsplit');
}
console.log('\n-- the wall marker overlay');
const ov = await page.evaluate(() => {
  const c = window.__ctl();
  const o = c.overlay;
  return { keys: Object.keys(o).slice(0, 30), hasWallTarget: typeof o.wallTarget === 'function' };
});
console.log(' ', JSON.stringify(ov));
console.log('errs', errs.length);
await browser.close();
