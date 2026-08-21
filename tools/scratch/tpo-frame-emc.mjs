/** One frame: the right button held over a bay the walk does not reach, hint and cursor visible. */
import { argsOf, boot, shot, fast, hover, selectHard, wallPixel, installDiag, ROOT } from './pl-lib-emc.mjs';
import path from 'node:path';
const A = argsOf();
const LABEL = A.get('label') ?? 'after';
const OUT = path.join(ROOT, 'screenshots/tower-party', LABEL);
const CREW = 14;
const { browser, page, errs } = await boot({
  port: Number(A.get('port') ?? 5613), map: 'carthage', out: OUT, label: `${LABEL}-frame` });
await installDiag(page);
await page.evaluate(() => {
  const txt = (s) => { const e = document.querySelector(s); return e && e.style.display !== 'none' ? (e.textContent ?? '') : ''; };
  window.__cur2 = () => ({ cur: document.body.dataset.cur ?? '', siegecur: document.body.dataset.siegecur ?? '',
    dragHint: txt('.drag-hint'), siegeHint: txt('.siege-hint') });
});
await page.mouse.move(800, 720); await page.waitForTimeout(200);
const bays = await page.evaluate(() => window.__bays());
await page.click('.dep-begin'); await page.waitForTimeout(700);
await fast(page, 290);
const me = await page.evaluate((i) => window.__u(i), CREW);
const near = bays.filter((b) => b.garr).reduce((a, b) =>
  (Math.hypot(b.cx - me.x, b.cz - me.z) < Math.hypot(a.cx - me.x, a.cz - me.z) ? b : a));
const scan = await page.evaluate(([i, list]) => list.map((b) =>
  ({ i: b.i, o: window.__siege().traverseOfferAt(i, b.cx, b.cz) })),
  [CREW, bays.filter((b) => b.garr && Math.abs(b.i - near.i) <= 6 && b.i !== near.i)]);
for (const want of ['ok', 'noRoute']) {
  const pick = scan.find((r) => (want === 'ok' ? r.o.ok : r.o.refusal === 'noRoute'));
  if (!pick) { console.log('no bay for', want); continue; }
  const b = bays.find((x) => x.i === pick.i);
  const s = await selectHard(page, CREW, { zoom: 0.5 });
  const wp = await wallPixel(page, b, { side: 1, zoom: 0.62 });
  if (!s.ok || !wp.p) { console.log('could not aim at bay', b.i); continue; }
  await hover(page, wp.p);
  await page.mouse.down({ button: 'right' }); await page.waitForTimeout(500);
  console.log(want, 'bay', b.i, JSON.stringify(await page.evaluate(() => window.__cur2())));
  await shot(page, OUT, `${LABEL}-held-${want}-bay${b.i}`);
  await page.mouse.up({ button: 'right' }); await page.waitForTimeout(300);
}
console.log('pageerrors', errs.length);
await browser.close();
