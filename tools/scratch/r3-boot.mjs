#!/usr/bin/env node
/**
 * `r3-boot` — every map, in both scenarios, with `pageerror` actually captured.
 *
 * The shot pass boots both maps fourteen times and records `consoleErrors` in its
 * `report.json`, which is most of this check. What it does not do is boot the *assault*
 * scenario of Campus Martius, and it reports draw calls only at the cameras its own table
 * names — two of which, `ab3-rome-wall` and `ab3-rome-parapet`, sit at 223 and 224 against a
 * 220 cap. Measured on the source at `3f4c203` those same two cameras read 223 and 224 as
 * well, so the ceiling is a property of where they stand and not of any render change; this
 * gives the *neutral* per-map figure beside them so the two can be told apart.
 *
 * Both listener kinds, because they catch different things: `pageerror` is an uncaught throw
 * and `console` of type error is a caught one that someone logged. A shader that fails to
 * compile arrives as the second.
 *
 * Usage:  node tools/scratch/r3-boot.mjs      (expects a dev server on 5231)
 */
import { chromium } from 'playwright';
const PORT = 5231;
const maps = [
  ['campus martius 271 AD', { timeOfDay: 10.5 }],
  ['campus martius, assault', { timeOfDay: 10.5, scenario: 'assault' }],
  ['carthage 146 BC', { map: 'carthage', opponent: 2, timeOfDay: 14.0 }],
  ['carthage, assault', { map: 'carthage', opponent: 2, scenario: 'assault', timeOfDay: 14.0 }],
];
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader'] });
let bad = 0;
for (const [name, cfg] of maps) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(`console: ${m.text()}`); });
  const tok = Buffer.from(JSON.stringify(cfg)).toString('base64url');
  await page.goto(`http://127.0.0.1:${PORT}/?harness=1&quality=ultra&w=1280&h=720&battle=${tok}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction(() => window.__game && window.__game.ready === true, null, { timeout: 420000 });
  await page.evaluate(() => window.__game.advance(45));
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const st = await page.evaluate(() => {
    const i = window.__game.engine.renderer.info.render;
    return { draws: i.calls, tris: i.triangles, men: window.__game.battle.pool.count };
  }).catch(() => ({}));
  console.log(`${errs.length ? 'FAIL' : 'ok  '}  ${name.padEnd(26)} ${String(st.men).padStart(5)} men  ${String(st.draws).padStart(4)} draws  ${(st.tris / 1e6).toFixed(2)}M tris  errors ${errs.length}`);
  for (const e of errs.slice(0, 5)) console.log(`        ${e}`);
  bad += errs.length;
  await page.close();
}
await browser.close();
console.log(bad ? `\n${bad} page errors` : '\nno page errors on any map');
process.exit(bad ? 1 : 0);
