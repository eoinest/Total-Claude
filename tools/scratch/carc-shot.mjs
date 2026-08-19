/**
 * Carcass shooter — scratch, owned by the elephant-death (carcass) workstream.
 *
 * A sibling of `eleview-shot.mjs` that hides the viewer's own chrome, because the defects
 * this pass is aimed at are geometry an overlaid readout sits on top of. Unique name and
 * unique port on purpose: twelve agents' scratch files have collided in /tmp on this box.
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const PORT = Number(process.env.PORT ?? 5714);
const OUT = process.env.OUT ?? '/tmp/tc-carc/shots';
const W = Number(process.env.W ?? 1400);
const H = Number(process.env.H ?? 950);

console.log(`[carc-shot] port ${PORT} -> ${OUT} at ${W}x${H}`);
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });

const errors = [];
const logs = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => logs.push(`${m.type()}: ${m.text()}`));

await page.goto(`http://127.0.0.1:${PORT}/viewer.html`, { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction(() => typeof window.__viewer === 'object' && window.__viewer !== null, null, { timeout: 120000 });
console.log('[carc-shot] __viewer ready');
await page.evaluate(() => {
  for (const id of ['viewer-panel', 'viewer-readout', 'viewer-boot']) {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  }
});

const frames = (n) => page.evaluate((k) => new Promise((res) => {
  let i = 0;
  const step = () => (++i >= k ? res() : requestAnimationFrame(step));
  requestAnimationFrame(step);
}), n);

const shot = async (name, setup) => {
  await page.evaluate(setup);
  await frames(14);
  const stats = await page.evaluate(() => window.__viewer.stats());
  const report = await page.evaluate(() => window.__viewer.report());
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log(`--- ${name} --- draws=${stats.draws} tris=${stats.triangles} rasterised=${stats.rasterised} instances=${stats.instances}`);
  return { name, stats, report };
};

const plan = JSON.parse(process.env.PLAN ?? '[]');
const out = [];
for (const p of plan) out.push(await shot(p.name, new Function(`return (${p.fn})`)()));

writeFileSync(`${OUT}/report.json`, JSON.stringify({ port: PORT, errors, console: logs, out }, null, 2));
console.log(`[carc-shot] pageerrors: ${errors.length}`);
for (const e of errors) console.log(`  PAGEERROR ${e}`);
const bad = logs.filter((c) => c.startsWith('error'));
console.log(`[carc-shot] console errors: ${bad.length}`);
for (const c of bad.slice(0, 20)) console.log(`  ${c}`);
await browser.close();
