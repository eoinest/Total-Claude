// The siege on the screen: the top plaque during a storm, full frame and cropped.
//
// `tools/probe-siegehud.mjs` samples this plaque all the way through a storm and is the
// instrument that grades it, but it writes only a 1000x100 strip clipped at x=300, which
// clips a unit card into the right-hand edge. This takes the same page at a chosen moment and
// writes the whole frame as well, so a crop can be cut where the plaque actually ends.
//
//   node tools/scratch/r6-topbar.mjs --port=5409 --out=DIR --map=carthage --at=45
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnVite } from '../lib/devtree.mjs';

const ROOT = process.env.TC_ROOT ?? process.cwd();
const arg = (k, d) => { const a = process.argv.find((s) => s.startsWith(`--${k}=`)); return a === undefined ? d : a.slice(k.length + 3); };
const PORT = Number(arg('port', 5409));
const OUT = path.resolve(arg('out', '/tmp/r6shots/topbar'));
const MAP = arg('map', 'carthage');
const AT = Number(arg('at', 45));
const W = 1600, H = 900;
const wait = async (u, ms) => { const d = Date.now() + ms; while (Date.now() < d) { try { const r = await fetch(u, { signal: AbortSignal.timeout(2000) }); if (r.ok) return true; } catch { /* */ } await new Promise((r) => setTimeout(r, 300)); } return false; };
const base = `http://127.0.0.1:${PORT}`;
let srv = null;
if (!(await wait(base, 1000))) {
  srv = spawnVite(['--port', String(PORT), '--host', '127.0.0.1', '--strictPort'], { cwd: ROOT, stdio: 'ignore', env: { ...process.env, TC_NO_HMR: '1' } });
  if (!(await wait(base, 120000))) throw new Error('no vite');
}
await mkdir(OUT, { recursive: true });
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--hide-scrollbars'] });
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const errs = [];
page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
await page.goto(`${base}/?menu=0&map=${MAP}&scenario=assault&autoplay=1&quality=high`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 420000 });
await page.addStyleTag({ content: '.hud-perf, .title-card { display: none !important; }' });
await page.waitForTimeout(1200);
await page.evaluate((at) => { const g = window.__game; while (g.simTime() < at) g.advance(1); }, AT);
await page.waitForTimeout(400);
const read = await page.evaluate(() => {
  const t = (s) => (document.querySelector(s)?.textContent ?? '').replace(/\s+/g, ' ').trim();
  const b = document.querySelector('.topbar')?.getBoundingClientRect();
  return { phase: t('.tb-phase'), note: t('.tb-note'), adv: t('.tb-adv'),
    siege: document.querySelector('.topbar')?.dataset.siege ?? '',
    box: b ? { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) } : null };
});
console.log(JSON.stringify(read));
await page.screenshot({ path: path.join(OUT, `${MAP}-t${AT}-full.png`) });
if (read.box) {
  const pad = 12;
  await page.screenshot({
    path: path.join(OUT, `${MAP}-t${AT}-plaque.png`),
    clip: { x: Math.max(0, read.box.x - pad), y: Math.max(0, read.box.y - pad),
      width: Math.min(W, read.box.w + pad * 2), height: Math.min(H, read.box.h + pad * 2) },
  });
}
await writeFile(path.join(OUT, `${MAP}.json`), JSON.stringify({ read, errors: errs.slice(0, 4) }, null, 2));
console.log('errors', errs.length);
await browser.close();
if (srv) srv.kill('SIGTERM');
