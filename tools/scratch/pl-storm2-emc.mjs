import { argsOf, boot, cam, shot, hover, leftClick, proj, aim, fast, ROOT } from './pl-lib-emc.mjs';
import path from 'node:path';
const A = argsOf();
const OUT = path.join(ROOT, 'screenshots/playability');
const { browser, page } = await boot({ port: Number(A.get('port') ?? 5431), map: 'carthage', out: OUT, label: 's2' });
await page.mouse.move(800, 620); await page.waitForTimeout(300);
await page.click('.dep-begin'); await page.waitForTimeout(400);
await fast(page, 5);
await page.evaluate(() => {
  window.__diag = () => {
    const c = window.__ctl(), s = window.__siege();
    const sol = c.pickSolids;
    let near = -1, nd = 1e9;
    for (let i = 0; i < sol.length; i++) { const d = Math.hypot(sol[i].x - c.solidX, sol[i].z - c.solidZ); if (d < nd) { nd = d; near = i; } }
    return { storming: c.storming, wallValid: c.wallValid, solidValid: c.solidValid,
      solidX: +c.solidX.toFixed(2), solidZ: +c.solidZ.toFixed(2), solidY: +c.solidY.toFixed(2),
      targetAt: s.wallTargetAt(c.solidX, c.solidZ),
      nearSolid: near >= 0 ? { x: +sol[near].x.toFixed(1), z: +sol[near].z.toFixed(1), hw: sol[near].hw, hd: sol[near].hd, topY: +sol[near].topY.toFixed(2), d: +nd.toFixed(2) } : null,
      cursor: document.body.dataset.cur, sel: c.model.selection.slice(),
      intent: (() => { try { return c.wallIntent ? c.wallIntent() : 'n/a'; } catch (e) { return 'err'; } })() };
  };
});
const bays = await page.evaluate(() => window.__bays());
for (const [label, pick] of [['cohort', u => u.type === 'legio-cohort' && u.x < -140], ['tower party', u => u.type === 'legio-tower-party' && u.x < -50]]) {
  const u = (await page.evaluate(() => window.__units(0))).find(pick);
  await cam(page, u.x, u.z - 25, 0.55, 0); await page.waitForTimeout(600);
  const p = await proj(page, u.x, u.meanY + 0.4, u.z);
  if (p) await leftClick(page, p);
  console.log(`\n${label} ${u.id} selected =`, await page.evaluate(() => window.__cur().sel));
  const b = bays.find(x => x.i === 27);
  for (const camz of [-70, -110]) {
    await cam(page, b.cx, b.cz + camz, 0.5, 0); await page.waitForTimeout(600);
    for (const y of [29.5, 28.5, 27.5, 26.5, 25, 22, 18, 14]) {
      const q = await proj(page, b.cx, y, b.cz - 2.5);
      if (!q || q.y < 8 || q.y > 892) { console.log(`   camz${camz} y=${y}: offscreen ${q ? Math.round(q.y) : 'null'}`); continue; }
      await page.mouse.move(q.x, q.y); await page.waitForTimeout(70);
      const d = await page.evaluate(() => window.__diag());
      console.log(`   camz${camz} y=${y} px${Math.round(q.y)} -> ${JSON.stringify(d)}`);
    }
  }
}
await shot(page, OUT, 's2-sweep');
await browser.close();
