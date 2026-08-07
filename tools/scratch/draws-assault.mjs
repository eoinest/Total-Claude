#!/usr/bin/env node
/** Whole-frame draw calls at the assault camera, both maps, ultra. One number per arm. */
import { chromium } from 'playwright';
const PORT = Number(process.argv.find((a) => a.startsWith('--port='))?.slice(7) ?? 5412);
const base = `http://127.0.0.1:${PORT}`;
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader'],
});
for (const map of ['campus-martius', 'carthage']) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(`${base}/?harness=1&map=${map}&scenario=assault&quality=ultra&w=1600&h=900`,
    { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 240000 });
  await page.waitForTimeout(1500);
  const out = await page.evaluate(() => {
    const g = window.__game;
    const r = g.engine.context.renderer;
    // The assault camera, as the shot table frames it.
    const f = g.engine.rig;
    void f;
    g.engine.advance(2, 166);
    r.info.reset();
    g.engine.frame(performance.now() + 16);
    return { calls: r.info.render.calls, tris: r.info.render.triangles };
  });
  console.log(`${map.padEnd(16)} draws ${out.calls}   tris ${(out.tris / 1e6).toFixed(2)}M`
    + (errs.length ? `   ERRORS ${errs.slice(0, 2).join(' | ')}` : ''));
  await page.close();
}
await browser.close();
