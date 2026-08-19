#!/usr/bin/env node
/**
 * cf-live — proof of life for both pages, with the console captured.
 *
 * A typecheck cannot see an ESM binding error, a missing runtime method behind `?.` or a
 * temporal dead zone, and this project has stacked three commits on a tree that
 * white-screened. This loads `/` and `/viewer.html`, waits for each page's own readiness
 * flag, and prints every `pageerror` and console error — without which a dead app is
 * indistinguishable from a slow boot.
 *
 *   node tools/scratch/cf-live.mjs --port=5417
 */
import { chromium } from 'playwright';
import process from 'node:process';

const args = new Map(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v ?? 'true'];
}));
const PORT = Number(args.get('port') ?? 5417);
const BASE = `http://127.0.0.1:${PORT}`;

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader'],
});
let bad = 0;
for (const [path, flag] of [['/?harness=1&quality=ultra&w=1280&h=720', 'game'], ['/viewer.html', 'viewer']]) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errs = [];
  page.on('console', (m) => { if (m.type() === 'error') errs.push(`console: ${m.text()}`); });
  page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
  let ready = 'TIMEOUT';
  try {
    await page.goto(BASE + path, { waitUntil: 'domcontentloaded', timeout: 60000 });
    if (flag === 'game') {
      await page.waitForFunction(() => window.__game && window.__game.ready === true,
        null, { timeout: 180000 });
      ready = await page.evaluate(() => JSON.stringify({
        ready: window.__game.ready,
        men: window.__game.battle?.pool?.count ?? null,
        draws: window.__game.engine?.renderer?.info?.render?.calls ?? null,
      }));
    } else {
      await page.waitForFunction(() => window.__viewer && window.__viewer.ready === true,
        null, { timeout: 180000 });
      ready = await page.evaluate(() => JSON.stringify({ ready: window.__viewer.ready }));
    }
  } catch (e) {
    ready = `FAILED: ${e.message.split('\n')[0]}`;
    bad++;
  }
  console.log(`${path.padEnd(14)} ${ready}`);
  const uniq = [...new Set(errs)];
  if (uniq.length) { bad++; for (const e of uniq.slice(0, 15)) console.log(`   ${e}`); }
  else console.log('   no pageerror, no console error');
  await page.close();
}
await browser.close();
console.log(bad ? `\nFAIL (${bad})` : '\nBOTH PAGES LIVE');
process.exit(bad ? 1 : 0);
