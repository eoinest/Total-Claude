/** Scratch: photograph one unit in the model viewer. Same script on both trees. */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
const A = new Map(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? '1'] : [a, '1'];
}));
const PORT = Number(A.get('port'));
const OUT = A.get('out'); const TAG = A.get('tag');
const SHOTS = JSON.parse(A.get('shots'));
mkdirSync(OUT, { recursive: true });
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal'] });
const p = await b.newPage({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1 });
const errs = [];
p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
p.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
await p.goto(`http://127.0.0.1:${PORT}/viewer.html`, { waitUntil: 'load', timeout: 60000 });
await p.waitForFunction(() => window.__viewer && window.__viewer.ready === true, { timeout: 120000 });
// The panel is the interface, and this entry is not about the interface.
await p.addStyleTag({ content: '#viewer-panel, #viewer-readout, #viewer-boot { display: none !important; }' });
// `display: none` on the panel does not resize the canvas — the viewer only resizes on a
// window resize event, so without this the frame keeps a dead strip where the panel was.
await p.setViewportSize({ width: 1281, height: 861 });
await p.setViewportSize({ width: 1280, height: 860 });
await p.waitForTimeout(400);
const out = [];
for (const s of SHOTS) {
  const info = await p.evaluate((s) => {
    const v = window.__viewer;
    v.setUnit(s.unit);
    if (s.mode) v.setMode(s.mode);
    if (s.light) v.setLight(s.light);
    if (s.state && v.elephantState) v.elephantState(s.state);
    if (s.hash !== undefined) v.setHash(s.hash);
    if (s.phase !== undefined) v.setPhase(s.phase);
    return { report: v.report ? v.report() : null, stats: v.stats ? v.stats() : null,
      hasElephantState: typeof v.elephantState === 'function' };
  }, s);
  await p.evaluate(() => new Promise((res) => {
    let i = 0; const step = () => (++i >= 45 ? res() : requestAnimationFrame(step));
    requestAnimationFrame(step);
  }));
  // Shoot the canvas itself: hiding the panel does not give the canvas its pixels back,
  // and a dead strip down one side is not part of the render.
  const box = await p.locator('#viewer-canvas').boundingBox();
  await p.screenshot({ path: `${OUT}/${TAG}-${s.name}.png`, clip: box });
  console.log('  canvas box', JSON.stringify(box));
  console.log(`--- ${TAG}-${s.name} --- elephantState=${info.hasElephantState} draws=${info.stats?.draws} tris=${info.stats?.triangles ?? ''}`);
  if (info.report) console.log(String(info.report).split('\n').slice(0, 8).join('\n'));
  out.push({ name: s.name, ...info });
}
writeFileSync(`${OUT}/${TAG}-viewer-report.json`, JSON.stringify({ errs, out }, null, 1));
console.log('errors', errs.length); errs.slice(0, 6).forEach((e) => console.log('  ', e));
await b.close();
