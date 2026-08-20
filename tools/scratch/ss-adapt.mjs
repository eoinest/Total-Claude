#!/usr/bin/env node
/** Why the adaptive controller sits at its floor: dump both arms, once a second. */
import { chromium } from 'playwright';
const args = new Map(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? 'true'] : [a, 'true']; }));
const PORT = Number(args.get('port') ?? 5788);
const SECS = Number(args.get('secs') ?? 45);
const Q = args.get('quality') ?? 'high';
const MAP = args.get('map') ?? 'carthage';
const SCEN = args.get('scenario') ?? 'assault';
const base = `http://127.0.0.1:${PORT}`;
const url = `${base}/?menu=0&map=${MAP}&scenario=${SCEN}&autoplay=1&quality=${Q}`;
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.log('pageerror:', e.message));
console.log('url:', url);
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 300000 });
// Record the raw rAF interval distribution the controller is judging, from frame()'s own arg.
await page.evaluate(() => {
  const e = window.__game.engine; const orig = e.frame.bind(e); let last = 0;
  window.__iv = [];
  e.frame = (n) => { if (last) window.__iv.push(n - last); last = n; orig(n); };
});
console.log(' t  press  scale  refreshMs ivP90 | rendP50 rendP90  raise-drop  simP90 warm latch rev chg realloc | ivP50 ivIQR ivP90raw n');
for (let i = 0; i < SECS; i++) {
  await page.waitForTimeout(1000);
  const s = await page.evaluate(() => {
    const st = window.__game.engine.adaptiveQuality.state();
    const iv = window.__iv.splice(0).sort((a, b) => a - b);
    const q = (f) => (iv.length ? +iv[Math.min(iv.length - 1, Math.floor(iv.length * f))].toFixed(2) : 0);
    return { st, ivP50: q(0.5), ivIQR: +(q(0.75) - q(0.25)).toFixed(2), ivP90: q(0.9), n: iv.length };
  });
  const a = s.st;
  console.log(`${String(i).padStart(2)}  ${a.pressure.toFixed(2)}  ${a.appliedScale.toFixed(2)}  ${a.refreshMs.toFixed(2).padStart(6)} ${a.ivP90.toFixed(1).padStart(6)} q${(a.ivQuant ?? -1).toFixed(3)}`
    + ` | ${a.p50.toFixed(1).padStart(6)} ${a.p90.toFixed(1).padStart(6)}  ${a.raiseMs.toFixed(1)}-${a.dropMs.toFixed(1)}`
    + `  ${a.simP90.toFixed(1).padStart(5)} ${String(a.warm).padStart(5)} ${String(a.latched).padStart(5)} ${String(a.reversals).padStart(3)} ${String(a.changes).padStart(3)} ${String(a.reallocs).padStart(3)}`
    + ` | ${String(s.ivP50).padStart(5)} ${String(s.ivIQR).padStart(5)} ${String(s.ivP90).padStart(5)} ${String(s.n).padStart(4)}`);
}
await browser.close();
