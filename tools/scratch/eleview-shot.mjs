/**
 * Elephant model-viewer shooter — scratch, owned by the viewer/elephant workstream.
 *
 * Unique name on purpose: an agent's `/tmp` script was overwritten mid-run by another and it
 * reported a clean pass against the wrong dev server. Lives in this worktree, names its port
 * on the first line of output, and refuses to run against a server it did not find.
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const PORT = Number(process.env.PORT ?? 5866);
const OUT = process.env.OUT ?? '/private/tmp/tc-eleview/shots';
const W = Number(process.env.W ?? 1500);
const H = Number(process.env.H ?? 1000);

console.log(`[eleview-shot] port ${PORT} -> ${OUT} at ${W}x${H}`);
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });

const errors = [];
const console_ = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => console_.push(`${m.type()}: ${m.text()}`));

await page.goto(`http://127.0.0.1:${PORT}/viewer.html`, { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction(() => typeof window.__viewer === 'object' && window.__viewer !== null, null, { timeout: 90000 });
console.log('[eleview-shot] __viewer ready');

// The readout is regenerated on a 0.12 s timer and `report()` hands back the last one built,
// so a short settle returns the *previous* shot's text beside the new shot's picture. Two runs
// of this script were nearly filed with an idle readout under a dying animal for exactly that
// reason. Wait on the text changing, not on a frame count.
const settle = async (frames = 40) => {
  const before = await page.evaluate(() => window.__viewer.report());
  await page.evaluate((n) => new Promise((res) => {
    let i = 0;
    const step = () => (++i >= n ? res() : requestAnimationFrame(step));
    requestAnimationFrame(step);
  }), frames);
  await page.waitForFunction((b) => window.__viewer.report() !== b, before, { timeout: 15000 })
    .catch(() => { /* an idempotent shot legitimately produces the same text */ });
};

const shot = async (name, setup) => {
  await page.evaluate(setup);
  await settle(10);
  const report = await page.evaluate(() => window.__viewer.report());
  const stats = await page.evaluate(() => window.__viewer.stats());
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log(`--- ${name} --- draws=${stats.draws} instances=${stats.instances} rasterised=${stats.rasterised}`);
  console.log(report);
  return { name, stats, report };
};

const plan = JSON.parse(process.env.PLAN ?? '[]');
const out = [];
for (const p of plan) {
  // eslint-disable-next-line no-new-func
  out.push(await shot(p.name, new Function(`return (${p.fn})`)()));
}

writeFileSync(`${OUT}/report.json`, JSON.stringify({ port: PORT, errors, console: console_, out }, null, 2));
console.log(`[eleview-shot] pageerrors: ${errors.length}`);
for (const e of errors) console.log(`  PAGEERROR ${e}`);
const bad = console_.filter((c) => c.startsWith('error') || c.startsWith('warning'));
console.log(`[eleview-shot] console errors/warnings: ${bad.length}`);
for (const c of bad.slice(0, 20)) console.log(`  ${c}`);

await browser.close();
