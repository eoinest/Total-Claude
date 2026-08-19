/**
 * Why the siege hint is blank when the cursor is on Rome's gate.
 *
 * Four assertions in the `ram` arm failed on the Campus Martius with `hint ""` while the same
 * code path on Carthage reads "Break the Porta Byrsae — 73 m, 2 min 18 s". The suspects are
 * the harness (cursor clamped off-frame or onto a panel) and the product (the ray never
 * resolving a point near the gate), and they are told apart by printing the pointer, the
 * three cursor validities and the preview together.
 */
import { chromium } from 'playwright';
const base = 'http://127.0.0.1:5473';
const b = await chromium.launch({ args: ['--use-gl=angle','--use-angle=metal','--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--hide-scrollbars'] });
const p = await b.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
const errs = []; p.on('pageerror', e => errs.push(e.message));
await p.goto(`${base}/?quality=high&autoplay=0`, { waitUntil: 'domcontentloaded' });
await p.waitForSelector('.menu .begin', { timeout: 60000 });
await p.click('.menu [data-map="campus-martius"]'); await p.waitForTimeout(200);
await p.click('.menu [data-scen="assault"]'); await p.waitForTimeout(200);
await p.click('.menu .begin');
await p.waitForFunction(() => window.__game?.ready === true, null, { timeout: 240000 });
await p.waitForTimeout(500);
if (await p.evaluate(() => !!document.querySelector('.dep-begin'))) { await p.click('.dep-begin'); await p.waitForTimeout(700); }
await p.evaluate(() => window.__game.engine.advance(20, 166));
const info = await p.evaluate(() => {
  const g = window.__game, s = g.battle.siege;
  const gate = s.gateReport();
  const st = s.stationNear(gate.x, gate.z);
  const r = s.ramReport()[0];
  return { gate: { id: gate.id, x: gate.x, z: gate.z }, crew: r.unitId,
    yaw: Math.atan2(s.snx[st], s.snz[st]), y: g.battle.groundAt(gate.x, gate.z) };
});
await p.evaluate((c) => {
  const h = window.__game.engine.context.tryGet('hud');
  h.controller.selectOnly(c, window.__game.engine.context);
}, info.crew);
for (const zoom of [0.24, 0.32, 0.42, 0.55]) {
  await p.evaluate((k) => window.__game.setCamera(k.x, k.z - 60, k.zoom, k.yaw),
    { x: info.gate.x, z: info.gate.z, zoom, yaw: info.yaw });
  await p.waitForTimeout(400);
  const px = await p.evaluate((k) => {
    const ctx = window.__game.engine.context;
    const v = new (ctx.camera.position.constructor)();
    v.set(k.x, k.y + 3, k.z).project(ctx.camera);
    return v.z > 1 ? null : { x: (v.x*0.5+0.5)*ctx.viewW, y: (-v.y*0.5+0.5)*ctx.viewH };
  }, { x: info.gate.x, y: info.y, z: info.gate.z });
  if (!px) { console.log(`zoom ${zoom}: gate behind the camera`); continue; }
  await p.mouse.move(px.x - 4, px.y - 4); await p.waitForTimeout(120);
  await p.mouse.move(px.x, px.y); await p.waitForTimeout(360);
  const d = await p.evaluate(() => {
    const h = window.__game.engine.context.tryGet('hud');
    const c = h.controller, so = h.siege;
    return { hint: document.querySelector('.siege-hint')?.textContent ?? '',
      shown: document.querySelector('.siege-hint')?.style.display === 'block',
      overUi: h.ptr.overUi, ptr: { x: Math.round(h.ptr.x), y: Math.round(h.ptr.y) },
      wallValid: c.wallValid, solidValid: c.solidValid, orderValid: c.orderValid,
      order: { x: +c.orderX.toFixed(1), z: +c.orderZ.toFixed(1) },
      solid: { x: +c.solidX.toFixed(1), z: +c.solidZ.toFixed(1) },
      preview: so.preview, sel: h.model.selection.slice() };
  });
  console.log(`zoom ${zoom} px (${Math.round(px.x)},${Math.round(px.y)}): ${JSON.stringify(d)}`);
}
console.log('gate at', JSON.stringify(info.gate), 'crew', info.crew);
console.log('errors:', errs.slice(0,2));
await b.close();
