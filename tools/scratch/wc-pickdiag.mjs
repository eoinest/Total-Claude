#!/usr/bin/env node
/**
 * Why does the cursor not find a unit standing on the wall?
 *
 * Projects (a) the point `SelectionController.pickUnit` tests, (b) the unit's declared
 * formation footprint, and (c) the men the renderer actually drew, then sweeps a real
 * cursor over a grid and reports where `hoveredId` comes back as that unit.
 */
import { chromium } from 'playwright';
import process from 'node:process';

const args = new Map(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
}));
const PORT = Number(args.get('port') ?? 5477);
const MAP = args.get('map') ?? 'campus-martius';
const base = `http://127.0.0.1:${PORT}`;
const W = 1600, H = 900;

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--hide-scrollbars'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const errs = [];
page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
const settle = (ms = 250) => page.waitForTimeout(ms);

await page.goto(`${base}/?quality=high&autoplay=0`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.menu .begin', { timeout: 60000 });
await page.click(`.menu [data-map="${MAP}"]`); await settle(220);
await page.click('.menu [data-scen="assault"]'); await settle(220);
await page.click('.menu .begin');
await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 300000 });
await settle(500);
if (await page.evaluate(() => !!document.querySelector('.dep-begin'))) { await page.click('.dep-begin'); await settle(700); }
await page.evaluate(() => window.__game.engine.advance(20, 166));
await settle(300);

await page.evaluate(() => {
  const g = window.__game, ctx = g.engine.context;
  window.__ctl = () => ctx.tryGet('hud')?.controller ?? null;
  const V = new (ctx.camera.position.constructor)();
  window.__project = (x, y, z) => { V.set(x, y, z).project(ctx.camera);
    if (V.z > 1) return null;
    return { x: +((V.x * 0.5 + 0.5) * ctx.viewW).toFixed(1), y: +((-V.y * 0.5 + 0.5) * ctx.viewH).toFixed(1) }; };
  window.__facts = (id) => {
    const c = window.__ctl(), v = c.model.view(id), u = v.unit, p = g.battle.pool;
    const ranks = Math.max(1, Math.ceil(Math.max(1, u.alive) / Math.max(1, u.width)));
    const frontage = Math.max(2, u.width * u.spacingX);
    const depth = Math.max(1.4, (ranks - 1) * u.spacingZ + 1.3);
    // Where the men really are.
    let n = 0, sx = 0, sz = 0, sy = 0, lox = 1e9, hix = -1e9, loz = 1e9, hiz = -1e9;
    for (const i of u.members) { if (!p.aliveAt(i)) continue;
      n++; sx += p.x[i]; sz += p.z[i]; sy += p.y[i];
      lox = Math.min(lox, p.x[i]); hix = Math.max(hix, p.x[i]);
      loz = Math.min(loz, p.z[i]); hiz = Math.max(hiz, p.z[i]); }
    const mx = n ? sx / n : 0, mz = n ? sz / n : 0, my = n ? sy / n : 0;
    const elevated = v.standY - v.cy > 2.5;
    return {
      id, typeId: u.typeId, alive: u.alive, order: u.order, facing: +u.facing.toFixed(3),
      width: u.width, spacingX: +u.spacingX.toFixed(2), spacingZ: +u.spacingZ.toFixed(2),
      anchor: [+u.x.toFixed(1), +u.z.toFixed(1)],
      blockCentre: [+v.cx.toFixed(1), +v.cz.toFixed(1)],
      frontage: +frontage.toFixed(1), depth: +depth.toFixed(1), ranks,
      cy: +v.cy.toFixed(2), standY: +v.standY.toFixed(2), elevated,
      menCentre: [+mx.toFixed(1), +mz.toFixed(1)], menMeanY: +my.toFixed(2),
      menSpan: [+(hix - lox).toFixed(1), +(hiz - loz).toFixed(1)],
      centreToMen: +Math.hypot(v.cx - mx, v.cz - mz).toFixed(2),
      // Distance from the men's own centroid to the declared footprint rectangle.
      pxTested: window.__project(v.cx, elevated ? v.standY + 0.9 : v.cy, v.cz),
      pxMen: window.__project(mx, my + 0.9, mz),
      garrisoned: g.battle.siege.isGarrisoned(id),
    };
  };
  window.__hovered = () => window.__ctl()?.model.hoveredId ?? -2;
  window.__overUi = () => { const c = window.__ctl(); return c && c.ptr ? c.ptr.overUi : null; };
  window.__units = () => g.battle.units.filter((u) => !u.destroyed && u.faction === 0)
    .map((u) => ({ id: u.id, typeId: u.typeId, garr: g.battle.siege.isGarrisoned(u.id) }));
});

const list = await page.evaluate(() => window.__units());
console.log('player units:', JSON.stringify(list));

for (const u of list.filter((x) => x.garr).slice(0, 2).concat(list.filter((x) => !x.garr).slice(0, 1))) {
  // Frame the unit.
  const f0 = await page.evaluate((id) => window.__facts(id), u.id);
  await page.evaluate(([x, z]) => window.__game.setCamera(x, z, 0.45, Math.PI), [f0.menCentre[0], f0.menCentre[1]]);
  await settle(400);
  const f = await page.evaluate((id) => window.__facts(id), u.id);
  console.log(`\n=== unit ${u.id} ${u.typeId} garrisoned ${u.garr}`);
  console.log('  ', JSON.stringify(f));
  // Sweep a grid around the men's own pixel.
  const hits = [];
  const c = f.pxMen ?? f.pxTested;
  if (!c) { console.log('   never projected'); continue; }
  for (let dy = -60; dy <= 60; dy += 15) {
    let row = '';
    for (let dx = -180; dx <= 180; dx += 20) {
      await page.mouse.move(c.x + dx, c.y + dy);
      await settle(60);
      const h = await page.evaluate(() => ({ h: window.__hovered(), ui: window.__overUi() }));
      row += h.ui ? 'U' : (h.h === u.id ? '#' : (h.h >= 0 ? String(h.h % 10) : '.'));
      const hh = h.h;
      if (hh === u.id) hits.push([dx, dy]);
    }
    console.log(`   dy${String(dy).padStart(4)} ${row}`);
  }
  console.log(`   hits ${hits.length}/${9 * 19}  nearest ${hits.length ? JSON.stringify(hits.sort((a, b) => Math.hypot(...a) - Math.hypot(...b))[0]) : 'none'}`);
}
console.log('ERRS', errs.slice(0, 3));
await browser.close();
