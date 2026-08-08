/**
 * Which way does the elephant face? — the azimuth invariant, measured rather than assumed.
 *
 * `framePlate` has had this sign wrong three times on the man, each time because someone
 * reasoned about it instead of photographing it. The recorded invariant is: paint a
 * front-only surface, sweep the azimuth, and the peak is the front. On a man that surface is
 * `Mat.Face`; on an elephant it is `ElephantPiece.Barding` — the bronze chamfron over the
 * forehead and the scale bib across the chest, which `elephantMesh.ts` calls the brightest
 * thing on the animal and the thing that says "war elephant" rather than "elephant".
 *
 * Soloed and shot in the flat piece-ID view so the count is a clean projected area with no
 * lighting in it, crew hidden, ground and rule off.
 */
import { chromium } from 'playwright';
import sharp from 'sharp';
import { mkdirSync } from 'node:fs';

const PORT = Number(process.env.PORT ?? 5866);
const OUT = '/private/tmp/tc-eleview/shots/facing';
console.log(`[eleview-facing] port ${PORT}`);
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal'] });
const page = await browser.newPage({ viewport: { width: 900, height: 900 }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(`http://127.0.0.1:${PORT}/viewer.html`, { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction(() => window.__viewer, null, { timeout: 90000 });

const settle = () => page.evaluate(() => new Promise((r) => {
  let i = 0;
  const s = () => (++i >= 10 ? r() : requestAnimationFrame(s));
  requestAnimationFrame(s);
}));

// The geometry's own answer first: where the barding's centroid sits along Z in the mesh's
// bind frame. Exact, and it is the thing the pixel sweep has to agree with.
await page.evaluate(() => window.__viewer.setUnit('war-elephants'));
const centroid = await page.evaluate(() => window.__viewer.elephantGroupZ());
console.log('[geometry] mean Z per group (mesh bind frame):', centroid);

await page.evaluate(() => {
  const v = window.__viewer;
  v.setUnit('war-elephants');
  v.setMode('single');
  v.setLod(0);
  v.setHash(0.37);
  v.elephantState('alive');
  v.setPhase(0);
  v.setFlag('eleCrew', false);
  v.setFlag('ground', false);
  v.setFlag('gauge', false);
  v.setFlag('shadows', false);
  v.elephantSolo(1);
  v.setParts(1);
  v.frame();
});
await settle();

const rows = [];
for (const [name, az] of [['0', 0], ['pi_2', Math.PI / 2], ['pi', Math.PI], ['3pi_2', -Math.PI / 2]]) {
  await page.evaluate((a) => window.__viewer.plateAim(a, 0.05, 0.8, 2.0), az);
  await settle();
  const file = `${OUT}/az-${name}.png`;
  // Left 62 % only: the control panel is on the right and the readout overlay is top-left,
  // so crop to the band the subject is actually in rather than count HTML.
  await page.screenshot({ path: file, clip: { x: 0, y: 360, width: 1080 * 0.62 | 0, height: 540 } });
  const { data, info } = await sharp(file).raw().toBuffer({ resolveWithObject: true });
  let lit = 0;
  for (let i = 0; i < data.length; i += info.channels) {
    // The piece-ID view is flat saturated colour on a near-black background gradient.
    if (data[i] + data[i + 1] + data[i + 2] > 150) lit++;
  }
  rows.push({ azimuth: name, bardingPx: lit });
  console.log(`azimuth ${name.padEnd(6)}  barding pixels ${lit}`);
}
const peak = rows.reduce((a, b) => (b.bardingPx > a.bardingPx ? b : a));
console.log(`\nPEAK at azimuth ${peak.azimuth} -> that is the animal's front.`);
console.log(`pageerrors: ${errors.length}`);
for (const e of errors) console.log(`  ${e}`);
await browser.close();
