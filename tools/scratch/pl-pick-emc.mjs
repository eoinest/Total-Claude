/** How close to a man must you click before his unit is selected? */
import { argsOf, boot, hover, cam, proj, shot, ROOT } from './pl-lib-emc.mjs';
import path from 'node:path';
const A = argsOf();
const OUT = path.join(ROOT, 'screenshots/playability');
const { browser, page } = await boot({ port: Number(A.get('port') ?? 5431), map: A.get('map') ?? 'carthage', out: OUT, label: 'pick' });
await page.mouse.move(800, 620); await page.waitForTimeout(400);
const own = await page.evaluate(() => window.__units(0));
const coh = own.filter(u => u.type === 'legio-cohort')[2];
for (const zoom of [0.30, 0.42, 0.52, 0.62, 0.75]) {
  await cam(page, coh.x, coh.z, zoom, 0);
  await page.waitForTimeout(600);
  const rig = await page.evaluate(() => { const r = window.__game.engine.rig; return { pitch: +(r.pitch * 57.3).toFixed(1), dist: +Math.hypot(r.camera.position.x - r.focus.x, r.camera.position.y - r.focus.y, r.camera.position.z - r.focus.z).toFixed(1), mpp: +r.metresPerPixel(900).toFixed(3) }; });
  const row = [];
  for (const dy of [0, 0.45, 0.9, 1.4, 1.75]) {
    const p = await proj(page, coh.x, coh.meanY + dy, coh.z);
    if (!p) { row.push(`${dy}:off`); continue; }
    const h = await hover(page, p);
    row.push(`${dy}m:${h.hovered === coh.id ? 'HIT' : 'miss(' + h.hovered + ')'}@${Math.round(p.y)}`);
  }
  console.log(`zoom ${zoom}  pitch ${rig.pitch}deg dist ${rig.dist}m mpp ${rig.mpp}  ${row.join('  ')}`);
}
// And the same for a unit standing on the wall (elevated), from the field.
const bays = await page.evaluate(() => window.__bays());
const b = bays.find(x => x.i === 29);
const enemy = (await page.evaluate(() => window.__units(2))).filter(u => u.elevated > 0);
const e = enemy.reduce((a, u) => Math.abs(u.x - b.cx) < Math.abs(a.x - b.cx) ? u : a);
console.log('garrison unit', e.id, e.type, e.x, e.z, 'meanY', e.meanY);
for (const zoom of [0.35, 0.52, 0.7]) {
  await cam(page, e.x, e.z - 70, zoom, 0);
  await page.waitForTimeout(600);
  const row = [];
  for (const dy of [0, 0.9, 1.75]) {
    const p = await proj(page, e.x, e.meanY + dy, e.z);
    if (!p) { row.push(`${dy}:off`); continue; }
    const h = await hover(page, p);
    row.push(`${dy}m:${h.hovered === e.id ? 'HIT' : 'miss(' + h.hovered + ')'}@${Math.round(p.x)},${Math.round(p.y)} cur=${h.cursor} wallValid=${h.wallValid}`);
  }
  console.log(`garrison zoom ${zoom}  ${row.join('  ')}`);
}
await shot(page, OUT, 'pick-wall');
await browser.close();
