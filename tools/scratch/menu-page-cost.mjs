/**
 * What does opening the page cost, and did the cinematic backdrop make it worse?
 *
 * The two arms are two *built* directories — `--dist=dist` against
 * `--dist=/tmp/tc-dist-baseline` — served by the same twenty-line static server in this file
 * rather than by `vite preview`, so nothing about the server differs between them. Text is
 * gzipped the way Vercel gzips it; AVIF and WebM are served raw, because they already are
 * compressed and Vercel does not double-compress them either.
 *
 * Three marks, and the middle one is the one the brief is about:
 *
 *   1. **first contentful paint** — the static splash in `index.html`
 *   2. **menu interactive** — `.menu.at-home .dest-battle` visible and hit-testable
 *   3. **six seconds in** — the plate and its clip have had time to arrive
 *
 * `--net=` throttles through CDP, because on localhost a 833 kB WebM arrives in 200 ms and
 * the measurement cannot tell a blocking fetch from a background one. `4g` and `fast3g` are
 * DevTools' own presets.
 *
 *   node tools/scratch/menu-page-cost.mjs --dist=dist --net=4g --runs=3
 *   node tools/scratch/menu-page-cost.mjs --dist=/tmp/tc-dist-baseline --net=4g --runs=3
 *   node tools/scratch/menu-page-cost.mjs --dist=dist --reduced
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const args = new Map(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
}));
/*
 * Two directories, interleaved, alternating run by run.
 *
 * This machine has five other agents on it and one arm measured after the other came back
 * 1080-2262 ms on the *same* build — the drift is bigger than the effect. Alternating A, B,
 * A, B in one process against one server is the house pattern for exactly this (`HANDOFF.md`:
 * *interleave the A/B in one session*), and it is the only way the medians mean anything.
 */
const DISTS = (args.get('dists') ?? args.get('dist') ?? 'dist')
  .split(',').map((d) => path.resolve(ROOT, d));
let DIST = DISTS[0];
const PORT = Number(args.get('port') ?? 5948);
const RUNS = Number(args.get('runs') ?? 3);
const REDUCED = args.has('reduced');
const NET = args.get('net') ?? 'none';

/** DevTools' own presets, in bytes/s and ms. */
const NETS = {
  none: null,
  '4g': { downloadThroughput: (9 * 1024 * 1024) / 8, uploadThroughput: (9 * 1024 * 1024) / 8, latency: 40 },
  fast3g: { downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8, latency: 150 },
  slow3g: { downloadThroughput: (400 * 1024) / 8, uploadThroughput: (400 * 1024) / 8, latency: 300 },
};
if (!(NET in NETS)) { console.error(`--net must be one of ${Object.keys(NETS).join(', ')}`); process.exit(1); }

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.avif': 'image/avif', '.webm': 'video/webm', '.webp': 'image/webp', '.jpg': 'image/jpeg',
  '.png': 'image/png', '.hdr': 'image/vnd.radiance',
};
const COMPRESS = new Set(['.html', '.js', '.css', '.json']);

const server = createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const rel = u.pathname === '/' ? '/index.html' : decodeURIComponent(u.pathname);
  const file = path.join(DIST, rel);
  if (!file.startsWith(DIST)) { res.writeHead(403); return res.end(); }
  try {
    await stat(file);
    const ext = path.extname(file);
    let body = await readFile(file);
    const h = { 'content-type': TYPES[ext] ?? 'application/octet-stream' };
    if (COMPRESS.has(ext)) { body = gzipSync(body); h['content-encoding'] = 'gzip'; }
    h['content-length'] = String(body.length);
    res.writeHead(200, h);
    res.end(body);
  } catch { res.writeHead(404); res.end('no'); }
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
const base = `http://127.0.0.1:${PORT}`;

const browser = await chromium.launch();
const rows = [];
try {
  for (let run = 0; run < RUNS * DISTS.length; run++) {
    DIST = DISTS[run % DISTS.length];
    const ctx = await browser.newContext({
      viewport: { width: 1600, height: 900 },
      reducedMotion: REDUCED ? 'reduce' : 'no-preference',
    });
    const page = await ctx.newPage();
    if (NETS[NET]) {
      const cdp = await ctx.newCDPSession(page);
      await cdp.send('Network.enable');
      await cdp.send('Network.emulateNetworkConditions', { offline: false, ...NETS[NET] });
    }

    /*
     * Resource Timing, not Playwright's `response` event: `content-length` is absent on a
     * gzipped response from some servers and the event's own timing is asynchronous, so a
     * first pass of this script attributed 833 kB of WebM to the critical path when the
     * request had barely started. `transferSize` is what went over the wire.
     */
    const tally = () => page.evaluate(() => {
      const out = [];
      let total = 0;
      for (const r of performance.getEntriesByType('resource')) {
        const n = r.transferSize || r.encodedBodySize || 0;
        total += n;
        out.push({ url: new URL(r.name).pathname, n, done: r.responseEnd > 0 });
      }
      const nav = performance.getEntriesByType('navigation')[0];
      const doc = nav ? (nav.transferSize || nav.encodedBodySize || 0) : 0;
      return { total: total + doc, doc, list: out };
    });

    /*
     * Long tasks, which is the signal "the page must not be slow to open" is actually about.
     * Wall-clock time to interactive on this machine has a 900-2,900 ms spread on the
     * *unmodified* build — five other agents are running headless Chromium on it — so the
     * medians cannot resolve a 200 ms effect. A main-thread block over 50 ms is a thing a
     * user feels, it is counted rather than timed, and it does not care what else the machine
     * is doing.
     */
    await page.addInitScript(() => {
      window.__long = [];
      new PerformanceObserver((l) => {
        for (const e of l.getEntries()) window.__long.push(Math.round(e.duration));
      }).observe({ entryTypes: ['longtask'] });
    });

    const t0 = Date.now();
    await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.menu.at-home .dest-battle', { state: 'visible', timeout: 120000 });
    const menuMs = Date.now() - t0;
    const fcp = await page.evaluate(() => {
      const e = performance.getEntriesByName('first-contentful-paint')[0];
      return e ? Math.round(e.startTime) : null;
    });
    const atMenu = await tally();
    await page.waitForTimeout(8000);
    const after = await tally();
    const long = await page.evaluate(() => window.__long ?? []);

    rows.push({
      dist: DIST,
      menuMs, fcp, long,
      critical: atMenu.total,
      total: after.total,
      atMenuList: atMenu.list.map((x) => `${x.url} ${x.n}`),
      list: [`/ ${after.doc}`, ...after.list.map((x) => `${x.url} ${x.n}`)],
    });
    await ctx.close();
  }
} finally {
  await browser.close();
  server.close();
}

const kb = (n) => `${(n / 1024).toFixed(0)} kB`;
const med = (a) => a.slice().sort((x, y) => x - y)[a.length >> 1];
console.log(`\nnet ${NET}  —  ${REDUCED ? 'reduced motion' : 'default'}  —  ${RUNS} interleaved cold loads per arm`);
for (const d of DISTS) {
  const arm = rows.filter((r) => r.dist === d);
  console.log(`\n  ${path.relative(ROOT, d) || d}`);
  console.log(`    first contentful paint     median ${med(arm.map((r) => r.fcp))} ms   (${arm.map((r) => r.fcp).join(', ')})`);
  console.log(`    menu interactive           median ${med(arm.map((r) => r.menuMs))} ms   (${arm.map((r) => r.menuMs).join(', ')})`);
  console.log(`    bytes by menu interactive  median ${kb(med(arm.map((r) => r.critical)))}`);
  console.log(`    bytes after eight seconds  median ${kb(med(arm.map((r) => r.total)))}`);
  const longs = arm.flatMap((r) => r.long);
  console.log(`    long tasks (>50 ms)        ${(longs.length / arm.length).toFixed(1)} per load, `
    + `worst ${longs.length ? Math.max(...longs) : 0} ms, total ${longs.reduce((s, x) => s + x, 0)} ms over ${arm.length} loads`);
  console.log('    on the critical path:');
  for (const l of arm[arm.length - 1].atMenuList) console.log(`      ${l}`);
  console.log('    everything, eight seconds in:');
  for (const l of arm[arm.length - 1].list) console.log(`      ${l}`);
}
