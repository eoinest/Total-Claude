/** What the player is actually shown when the battle opens. */
import { argsOf, boot, shot, proj, installDiag, ROOT } from './pl-lib-emc.mjs';
import path from 'node:path';
const A = argsOf();
const OUT = path.join(ROOT, 'screenshots/playability');
for (const map of ['carthage', 'campus-martius']) {
  const { browser, page } = await boot({ port: Number(A.get('port') ?? 5431), map, out: OUT, label: `op-${map}` });
  await installDiag(page);
  await page.mouse.move(760, 300); await page.waitForTimeout(1200);
  const bays = await page.evaluate(() => window.__bays());
  const g = bays.filter(b => b.garr);
  const mid = g[Math.floor(g.length / 2)];
  const near = g.sort((p, q) => Math.hypot(p.cx, p.cz - 470) - Math.hypot(q.cx, q.cz - 470))[0];
  const rig = await page.evaluate(() => { const r = window.__game.engine.rig; return { x: +r.focus.x.toFixed(0), z: +r.focus.z.toFixed(0), zoom: +r.zoom.toFixed(2), yaw: +r.yaw.toFixed(2) }; });
  const pts = {};
  for (const [n, b] of [['nearest bay walk', near], ['nearest bay crest', near]]) {
    const y = n.includes('crest') ? b.crestY : b.walkY;
    pts[`${n} x${b.cx}`] = await proj(page, b.cx, y, b.cz);
  }
  console.log(map, 'opening camera', JSON.stringify(rig));
  for (const [k, v] of Object.entries(pts)) console.log('   ', k, '->', v ? `${Math.round(v.x)},${Math.round(v.y)}${v.y < 100 ? '  [BEHIND THE TOP BAR]' : v.y < 0 ? '  [OFF SCREEN]' : ''}` : 'not projectable');
  await shot(page, OUT, `open-${map}`);
  await browser.close();
}
