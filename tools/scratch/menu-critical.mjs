/**
 * Throwaway: is any plate on the path to interactive?
 *
 * `tools/qa-hostload.mjs` reports bytes accumulated through interactive **plus a 600 ms
 * settle**, so its byte total already contains the backdrop's first plate and cannot answer
 * the question this pass is actually under orders to keep answering — *nothing the menu shows
 * may be on the critical path.* A total that goes up is not evidence of a regression and a
 * total that stays flat is not evidence there isn't one.
 *
 * So this records, off CDP, the wall-clock at which every response finishes against the
 * wall-clock at which the menu becomes interactive, and prints the two sides of that line. The
 * property to preserve is: **every request that finishes before interactive is HTML, CSS or
 * JavaScript, and every image finishes after it.**
 *
 *   node tools/scratch/menu-critical.mjs --base=http://192.168.1.77:5952
 *   node tools/scratch/menu-critical.mjs --port=5625            # starts its own dev server
 */
import path from 'node:path';
import process from 'node:process';
import { launchBrowser, startVite } from '../lib/browser-budget.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const args = new Map(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
}));
const PORT = Number(args.get('port') ?? 5625);
const BASE = args.get('base') ?? null;
const REPS = Number(args.get('reps') ?? 3);

const vite = BASE ? null : await startVite({ port: PORT, root: ROOT, label: 'menu-critical' });
const base = BASE ?? vite.base;
const browser = await launchBrowser({ label: 'menu-critical', port: PORT, root: ROOT });
const runs = [];
try {
  for (let i = 0; i < REPS; i += 1) {
    // A fresh context per rep, because Playwright partitions the HTTP cache per context and a
    // warm second load measures the cache rather than the page.
    const ctx = await browser.newContext({ viewport: { width: 1512, height: 982 }, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.clearBrowserCache');
    const urls = new Map();
    const done = [];
    cdp.on('Network.requestWillBeSent', (e) => urls.set(e.requestId, e.request.url));
    cdp.on('Network.loadingFinished', (e) => {
      done.push({
        url: urls.get(e.requestId) ?? '?',
        bytes: e.encodedDataLength,
        at: Date.now(),
      });
    });
    const t0 = Date.now();
    await page.goto(`${base}/`, { waitUntil: 'commit' });
    await page.waitForSelector('.menu.at-home .menu-home');
    const interactive = Date.now();
    // Long enough for the backdrop to arm, choose, fetch and decode.
    await page.waitForTimeout(4000);
    await ctx.close();

    const isImage = (u) => /\.(avif|webp|png|jpe?g|svg|ico)(\?|$)/.test(u);
    const before = done.filter((d) => d.at <= interactive);
    const after = done.filter((d) => d.at > interactive);
    runs.push({
      interactiveMs: interactive - t0,
      beforeBytes: before.reduce((a, b) => a + b.bytes, 0),
      beforeCount: before.length,
      beforeImages: before.filter((d) => isImage(d.url)).map((d) => d.url.split('/').pop()),
      afterBytes: after.reduce((a, b) => a + b.bytes, 0),
      afterCount: after.length,
      afterImages: after.filter((d) => isImage(d.url))
        .map((d) => `${d.url.split('/').pop()} ${(d.bytes / 1024).toFixed(0)}kB`),
      before: before.map((d) => `${d.url.split('/').pop()} ${(d.bytes / 1024).toFixed(0)}kB`),
    });
  }
} finally {
  await browser.close();
  if (vite) await vite.close();
}

const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
console.log(`\n  ${base}, ${REPS} rep(s), cache cleared each time, 1512x982 @2\n`);
for (const [i, r] of runs.entries()) {
  console.log(`  rep ${i + 1}: interactive at ${r.interactiveMs} ms`);
  console.log(`    to interactive : ${r.beforeCount} request(s), `
    + `${(r.beforeBytes / 1024).toFixed(0)} kB — ${r.before.join(', ')}`);
  console.log(`    images before  : ${r.beforeImages.length ? r.beforeImages.join(', ') : 'NONE'}`);
  console.log(`    after          : ${r.afterCount} request(s), `
    + `${(r.afterBytes / 1024).toFixed(0)} kB — ${r.afterImages.join(', ') || 'no images'}`);
}
const bad = runs.filter((r) => r.beforeImages.length > 1);
console.log(`\n  median bytes to interactive: `
  + `${(med(runs.map((r) => r.beforeBytes)) / 1024).toFixed(0)} kB over `
  + `${med(runs.map((r) => r.beforeCount))} requests`);
console.log(`  median interactive: ${med(runs.map((r) => r.interactiveMs))} ms`);
console.log(bad.length === 0
  ? '  PASS  at most one image finished before interactive on every rep\n'
  : `  FAIL  ${bad.length} rep(s) had more than one image on the path to interactive\n`);
process.exit(bad.length === 0 ? 0 : 1);
