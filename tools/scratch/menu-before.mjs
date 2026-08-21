/**
 * The "before" stills, honestly obtained from the "after" tree.
 *
 * Two things the pass replaced, and both can be reproduced exactly on this tree without
 * checking out the parent commit:
 *
 *  - **The old menu background** was `.menu-bg`'s two-stop gradient and nothing else. That
 *    gradient is still in the file — it is now the *floor* under the plate, on `.backdrop`,
 *    byte for byte, so that a browser with no AVIF gets what shipped last week. Blocking
 *    `/menu/**` therefore renders the previous menu exactly, not an approximation of it.
 *  - **The old loading screen** is the panel that still appears before `main.ts` has run: same
 *    markup, same CSS, no plate, because the plate is only added once the map is known.
 *    Throttling to slow 3G holds it on screen long enough to photograph.
 *
 *   node tools/scratch/menu-before.mjs --port=5941
 */
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { ensureServer } from '../lib/menu-boot.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const args = new Map(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
}));
const PORT = Number(args.get('port') ?? 5941);
const OUT = path.resolve(ROOT, args.get('out') ?? 'screenshots/cinematic-menu/before');
const W = Number(args.get('w') ?? 1600);
const H = Number(args.get('h') ?? 900);

await mkdir(OUT, { recursive: true });
const { base, server } = await ensureServer({
  port: PORT, root: ROOT, cacheDir: path.join(ROOT, '.vite-cache'),
});
const browser = await chromium.launch({ args: ['--use-gl=angle'] });

// --- the old menu: the gradient, with the plates unavailable -------------------------
{
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  await page.route('**/menu/**', (r) => r.abort());
  await page.goto(`${base}/?quality=ultra`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.menu.at-home .dest-battle', { state: 'visible', timeout: 60000 });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(OUT, '01-home-before.jpg'), type: 'jpeg', quality: 90 });
  await page.click('.menu-home .dest-battle');
  await page.waitForSelector('.menu.at-setup .begin');
  await page.waitForTimeout(1200);
  await page.screenshot({ path: path.join(OUT, '02-setup-before.jpg'), type: 'jpeg', quality: 90 });
  await page.close();
  console.log('  01-home-before.jpg  02-setup-before.jpg');
}

// --- the old loading screen: the pre-boot splash, held up by a slow link -------------
{
  const ctx = await browser.newContext({ viewport: { width: W, height: H } });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    downloadThroughput: (400 * 1024) / 8,
    uploadThroughput: (400 * 1024) / 8,
    latency: 300,
  });
  await page.goto(`${base}/?quality=ultra`, { waitUntil: 'commit' });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(OUT, '03-loading-before.jpg'), type: 'jpeg', quality: 90 });
  await ctx.close();
  console.log('  03-loading-before.jpg');
}

await browser.close();
server?.kill();
console.log(`\n→ ${OUT}`);
