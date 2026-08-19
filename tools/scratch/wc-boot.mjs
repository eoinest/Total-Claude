#!/usr/bin/env node
/**
 * Proof of life: boot each map through the real menu, read `window.__game.ready`, capture
 * every `pageerror` and `console.error`, and report the assault camera's draw calls.
 *
 * A typecheck cannot see an ESM binding error, a missing method behind `?.` or a temporal
 * dead zone, and a dead app is indistinguishable from a slow boot without the console.
 */
import { chromium } from 'playwright';
import process from 'node:process';

const args = new Map(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
}));
const PORT = Number(args.get('port') ?? 5477);
const base = `http://127.0.0.1:${PORT}`;
const up = await fetch(`${base}/src/main.ts`).catch(() => null);
if (!up || !up.ok) { console.error(`no dev server at ${base}`); process.exit(2); }

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist', '--hide-scrollbars'],
});
let bad = 0;
for (const map of ['campus-martius', 'carthage']) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
  const errs = [];
  page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(`console.error: ${m.text()}`); });
  const settle = (ms) => page.waitForTimeout(ms);
  await page.goto(`${base}/?quality=ultra&autoplay=0`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.menu .begin', { timeout: 90000 });
  await page.click(`.menu [data-map="${map}"]`); await settle(250);
  await page.click('.menu [data-scen="assault"]'); await settle(250);
  await page.click('.menu .begin');
  let ready = true;
  try { await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 300000 }); }
  catch { ready = false; }
  await settle(700);
  if (await page.evaluate(() => !!document.querySelector('.dep-begin'))) { await page.click('.dep-begin'); await settle(800); }
  const info = await page.evaluate(() => {
    const g = window.__game, ctx = g.engine.context;
    return { city: ctx.tryGet('city')?.cityPlan?.id ?? null, units: g.battle.units.length,
      tier: ctx.quality?.tier ?? null, dpr: window.devicePixelRatio };
  });
  // The assault camera the budget is quoted at: the scenario's own boot framing.
  await page.evaluate(() => window.__game.engine.advance(6, 166));
  await settle(500);
  const draws = await page.evaluate(() => {
    const r = window.__game.engine.context.renderer;
    const out = [];
    for (let i = 0; i < 6; i++) out.push(r.info.render.calls);
    return { calls: r.info.render.calls, tris: r.info.render.triangles, programs: r.info.programs?.length ?? -1, out };
  });
  const okDraws = draws.calls;
  console.log(`${map.padEnd(15)} ready ${ready}  city ${info.city}  units ${info.units}  tier ${info.tier}  `
    + `dpr ${info.dpr}  draws ${okDraws}  triangles ${draws.tris}  programs ${draws.programs}`);
  console.log(`${''.padEnd(15)} errors: ${errs.length ? errs.slice(0, 5).join(' | ') : 'none'}`);
  if (!ready || errs.length) bad++;
  await page.close();
}
await browser.close();
console.log(bad === 0 ? 'BOOT OK on both maps' : `${bad} map(s) failed to boot clean`);
process.exit(bad === 0 ? 0 : 1);
