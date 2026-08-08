#!/usr/bin/env node
/**
 * Proof of life on the rebased tree: the page loads, `window.__game.ready` goes true, no
 * `pageerror` and no console error, on both opponents. A typecheck cannot see an ESM binding
 * error, a temporal dead zone or a missing method behind `?.`.
 */
import { chromium } from 'playwright';
import process from 'node:process';

const PORT = Number(process.argv[2] ?? 5691);
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
let bad = 0;
for (const q of ['enemy=carthage', 'enemy=juthungi']) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(`console: ${m.text()}`); });
  await page.goto(`http://127.0.0.1:${PORT}/?harness=1&quality=ultra&${q}`, { waitUntil: 'domcontentloaded' });
  let ready = false;
  try {
    await page.waitForFunction(() => window.__game && window.__game.ready === true, null, { timeout: 180000 });
    ready = true;
  } catch { ready = false; }
  const state = await page.evaluate(() => {
    const g = window.__game;
    if (!g) return null;
    g.engine.advance(20, 166);
    const b = g.battle;
    const eles = b.units.filter((u) => u.typeId === 'war-elephants');
    return {
      ready: g.ready, simTime: +g.simTime().toFixed(1), pool: b.pool.count,
      elephantUnits: eles.length, animals: eles.reduce((a, u) => a + u.members.length, 0),
      draws: g.engine.renderer.info.render.calls,
    };
  });
  console.log(`${q}: ready=${ready} ${JSON.stringify(state)} errors=${errs.length}`);
  for (const e of errs) console.log(`   ${e}`);
  if (!ready || errs.length) bad++;
  await page.close();
}
await browser.close();
process.exit(bad ? 1 : 0);
