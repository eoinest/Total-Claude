/**
 * Does `/index.html` still boot, on all three maps?
 *
 * The viewer shares a build with the game — `vite.config` declares both entries — so a change
 * inside `src/viewer/` cannot regress the game but a change inside `src/render/PostFX.ts` very
 * much can, and `grade.ts` now imports from it. A typecheck cannot see an ESM binding error, a
 * missing runtime method behind `?.`, or a temporal dead zone; only loading the page can, and
 * only with `pageerror` and `console` captured, because without them a dead app is
 * indistinguishable from a slow boot.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const PORT = Number(process.env.PORT ?? 5866);
const OUT = '/private/tmp/tc-eleview/shots/gameboot';
console.log(`[eleview-gameboot] port ${PORT}`);
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal'] });
let failed = 0;

for (const map of ['campus-martius', 'carthage', 'pydna']) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  const errors = [];
  const warns = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') warns.push(m.text()); });
  const url = `http://127.0.0.1:${PORT}/index.html?harness=1&map=${map}&quality=high`;
  let ready = false;
  try {
    await page.goto(url, { waitUntil: 'load', timeout: 90000 });
    await page.waitForFunction(() => window.__game && window.__game.ready === true, null, { timeout: 180000 });
    ready = true;
    await page.evaluate(() => window.__game.advance(2));
    await page.evaluate(() => new Promise((r) => {
      let i = 0;
      const s = () => (++i >= 20 ? r() : requestAnimationFrame(s));
      requestAnimationFrame(s);
    }));
    await page.screenshot({ path: `${OUT}/${map}.png` });
  } catch (e) {
    errors.push(`TIMEOUT/THROW: ${e.message}`);
  }
  const stats = ready ? await page.evaluate(() => {
    const info = window.__game.engine.renderer.info.render;
    return { draws: info.calls, tris: info.triangles, t: window.__game.simTime() };
  }).catch(() => null) : null;
  console.log(`${map.padEnd(15)} ready=${ready} pageerrors=${errors.length} consoleErrors=${warns.length} ${stats ? `draws=${stats.draws} tris=${stats.tris} t=${stats.t.toFixed(1)}` : ''}`);
  for (const e of errors) { console.log(`  PAGEERROR ${e}`); failed = 1; }
  for (const w of warns.slice(0, 6)) { console.log(`  CONSOLE-ERROR ${w}`); failed = 1; }
  if (!ready) failed = 1;
  await page.close();
}

await browser.close();
console.log(failed ? '[eleview-gameboot] FAIL' : '[eleview-gameboot] all three maps boot clean');
process.exit(failed);
