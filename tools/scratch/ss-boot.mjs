#!/usr/bin/env node
/** Both maps, both scenarios, booted and stepped, with every pageerror and console error kept. */
import { chromium } from 'playwright';
const PORT = Number((process.argv.find((a) => a.startsWith('--port=')) ?? '--port=5788').split('=')[1]);
const CASES = [
  ['campus-martius', 'field'], ['campus-martius', 'assault'],
  ['carthage', 'field'], ['carthage', 'assault'],
];
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
let bad = 0;
for (const [map, scen] of CASES) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 200)); });
  const url = `http://127.0.0.1:${PORT}/?harness=1&autoplay=1&w=1280&h=720&map=${map}&scenario=${scen}&quality=high`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 300000 });
  // Both fast-forward paths, then a real frame, so a stale-canvas bug would show as a blank shot.
  await page.evaluate(() => window.__game.fastForward(20));
  await page.evaluate(() => window.__game.advance(5));
  await page.waitForTimeout(600);
  const s = await page.evaluate(() => {
    const g = window.__game, e = g.engine;
    return { t: +g.simTime().toFixed(1), men: g.battle.units.reduce((a, u) => a + u.alive, 0),
      calls: e.renderer.info.render.calls, tris: e.renderer.info.render.triangles,
      scale: e.quality.renderScale, press: e.adaptiveQuality.state().pressure };
  });
  const shot = await page.screenshot();
  // A frame that drew nothing is a few hundred bytes of one flat colour.
  const blank = shot.length < 20000;
  const ok = errors.length === 0 && s.men > 0 && s.calls > 20 && !blank;
  if (!ok) bad++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${map}/${scen}  t+${s.t}  men ${s.men}  calls ${s.calls}  tris ${s.tris}  scale ${s.scale} press ${s.press}  png ${(shot.length / 1024).toFixed(0)}kB`);
  if (errors.length) console.log('      errors: ' + errors.slice(0, 4).join(' | '));
  await page.close();
}
console.log(bad ? `FAIL: ${bad} of ${CASES.length}` : `✓ ${CASES.length}/${CASES.length} booted clean`);
await browser.close();
process.exit(bad ? 1 : 0);
