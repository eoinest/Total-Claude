/**
 * How much does it cost to put a live 3D map behind the menu?
 *
 * The question this pass has to answer with a number rather than an argument: a live camera
 * over the real terrain is authentic, but it means booting the map's world before the player
 * has committed to anything. This measures the two halves of that:
 *
 *   1. `menu`  — page open to the front door being on screen and interactive. The number the
 *      "must not make the page slow to open" constraint is about.
 *   2. `boot`  — BEGIN BATTLE to `__game.ready`, split per subsystem out of the loading
 *      label, so the cost of the *world only* (sky, lighting, terrain, city, shaders) can be
 *      read off separately from the cost of the armies.
 *
 * Run:  node tools/scratch/menu-boot-cost.mjs [--port=5921] [--quality=ultra]
 */
import { chromium } from 'playwright';
import path from 'node:path';
import process from 'node:process';
import { ensureServer } from '../lib/menu-boot.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const args = new Map(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
}));
const PORT = Number(args.get('port') ?? 5921);
const QUALITY = args.get('quality') ?? 'ultra';
const MAPS = (args.get('maps') ?? 'campus-martius,carthage,pydna').split(',');

const { base, server } = await ensureServer({
  port: PORT, root: ROOT, cacheDir: path.join(ROOT, '.vite-cache'),
});

const browser = await chromium.launch({ args: ['--use-gl=angle', '--enable-webgl'] });
const rows = [];
try {
  for (const map of MAPS) {
    const scenario = map === 'pydna' ? 'field' : 'assault';
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
    const t0 = Date.now();
    await page.goto(`${base}/?quality=${QUALITY}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.menu.at-home .dest-battle', { state: 'visible', timeout: 60000 });
    const menuMs = Date.now() - t0;
    await page.click('.menu-home .dest-battle');
    await page.waitForSelector('.menu.at-setup .begin', { timeout: 60000 });
    await page.click(`.menu [data-map="${map}"]`);
    await page.click(`.menu [data-scen="${scenario}"]`);
    const firstPaint = await page.evaluate(() => {
      const e = performance.getEntriesByName('first-contentful-paint')[0];
      return e ? Math.round(e.startTime) : null;
    });
    const transfer = await page.evaluate(() => {
      let js = 0; let css = 0; let other = 0; let n = 0;
      for (const r of performance.getEntriesByType('resource')) {
        n++;
        const s = r.transferSize || r.encodedBodySize || 0;
        if (r.name.endsWith('.css')) css += s;
        else if (r.name.endsWith('.js') || r.name.includes('/src/')) js += s;
        else other += s;
      }
      return { js, css, other, n };
    });

    await page.evaluate(() => {
      const el = document.getElementById('load-text');
      window.__steps = [];
      const t = performance.now();
      const mo = new MutationObserver(() => {
        window.__steps.push({ label: el.textContent, at: performance.now() - t });
      });
      mo.observe(el, { childList: true, characterData: true, subtree: true });
      window.__done = new Promise((res) => {
        const iv = setInterval(() => {
          if (window.__game?.ready) { clearInterval(iv); res(performance.now() - t); }
        }, 20);
      });
    });
    const tBegin = Date.now();
    await page.click('.menu .begin');
    const bootMs = await page.evaluate(() => window.__done);
    const steps = await page.evaluate(() => window.__steps);
    rows.push({
      map, menuMs, firstPaint, transfer, bootMs: Math.round(bootMs), steps,
      wallBoot: Date.now() - tBegin,
    });
    await page.close();
  }
} finally {
  await browser.close();
  server?.kill();
}

const kb = (n) => `${(n / 1024).toFixed(0)} kB`;
for (const r of rows) {
  console.log(`\n=== ${r.map} @ ${QUALITY} ===`);
  console.log(`  page open -> menu interactive : ${r.menuMs} ms   (FCP ${r.firstPaint} ms)`);
  console.log(`  transfer at the menu          : js ${kb(r.transfer.js)}  css ${kb(r.transfer.css)}  other ${kb(r.transfer.other)}  (${r.transfer.n} requests)`);
  console.log(`  BEGIN -> ready                : ${r.bootMs} ms`);
  let prev = 0;
  for (const s of r.steps) {
    console.log(`      ${String(Math.round(s.at - prev)).padStart(6)} ms  ${s.label}`);
    prev = s.at;
  }
}
console.log('\nJSON', JSON.stringify(rows.map((r) => ({
  map: r.map, menuMs: r.menuMs, fcp: r.firstPaint, bootMs: r.bootMs,
}))));
