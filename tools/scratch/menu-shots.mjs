/**
 * Photograph the menu and the loading screen, before and after.
 *
 *   node tools/scratch/menu-shots.mjs --port=5941 [--out=screenshots/cinematic-menu]
 *   node tools/scratch/menu-shots.mjs --reduced        # prefers-reduced-motion: reduce
 *
 * Deliberately not a probe: nothing here asserts. It exists so a human can look at the thing.
 */
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { ensureServer } from '../lib/menu-boot.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const args = new Map(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
}));
const PORT = Number(args.get('port') ?? 5941);
const REDUCED = args.has('reduced');
const OUT = path.resolve(ROOT, args.get('out') ?? (REDUCED ? 'screenshots/cinematic-menu/reduced' : 'screenshots/cinematic-menu'));
const W = Number(args.get('w') ?? 1600);
const H = Number(args.get('h') ?? 900);

await mkdir(OUT, { recursive: true });
await writeFile(path.join(ROOT, 'screenshots', '.metadata_never_index'), '').catch(() => {});

const { base, server } = await ensureServer({
  port: PORT, root: ROOT, cacheDir: path.join(ROOT, '.vite-cache'),
});

const browser = await chromium.launch({ args: ['--use-gl=angle', '--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({
  viewport: { width: W, height: H },
  reducedMotion: REDUCED ? 'reduce' : 'no-preference',
});
page.on('pageerror', (e) => console.error('pageerror:', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.error('console:', m.text().slice(0, 200)); });

const shot = async (name, ms = 0) => {
  if (ms) await page.waitForTimeout(ms);
  await page.screenshot({ path: path.join(OUT, `${name}.jpg`), type: 'jpeg', quality: 90 });
  console.log(`  ${name}.jpg`);
};

const requests = [];
page.on('response', (r) => {
  const u = r.url();
  if (u.includes('/menu/')) requests.push(`${path.basename(u)} ${r.status()}`);
});

console.log('front door');
await page.goto(`${base}/?quality=ultra`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.menu.at-home .dest-battle', { state: 'visible', timeout: 60000 });
await shot('01-home-arriving', 400);
await shot('02-home', 4200);

console.log('setup');
await page.click('.menu-home .dest-battle');
await page.waitForSelector('.menu.at-setup .begin');
await shot('03-setup-rome', 3200);

console.log('switching to Carthage');
await page.click('.menu [data-map="carthage"]');
await shot('04-switch-mid', 420);
await shot('05-setup-carthage', 4200);

console.log('switching to Pydna');
await page.click('.menu [data-map="pydna"]');
await shot('06-setup-pydna', 4200);

console.log('back to Carthage, then begin');
await page.click('.menu [data-map="carthage"]');
await page.waitForTimeout(2600);
await page.click('.menu .begin');
await shot('07-loading', 900);
await shot('08-loading-later', 2200);
await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 240000 });
await shot('09-handover', 500);
await shot('10-battle', 2000);

console.log('\nplate requests:');
for (const r of requests) console.log(`  ${r}`);

await browser.close();
server?.kill();
console.log(`\n→ ${OUT}`);
