#!/usr/bin/env node
/**
 * The bow on the isolated-model deck, under the Battle rig.
 *
 * `framePlate`'s azimuth convention has been wrong twice in this project's history and cost
 * three rounds of plates of the back of a man's head, so the sweep is shot and kept as well
 * as the chosen angle. Azimuth 0 is in front of the man's face; the bow's own plane is yawed
 * 26 degrees out of his facing because the archery clip is a side-on stance, so the camera
 * that sees the *stave's profile* is not the camera that sees the man's profile.
 *
 *   node tools/scratch/bowplate-ab.mjs --port=5241 --tag=after
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const args = new Map(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
}));
const PORT = Number(args.get('port') ?? 5241);
const TAG = String(args.get('tag') ?? 'x');
const OUT = String(args.get('out') ?? 'screenshots/archer-bow');
const base = `http://127.0.0.1:${PORT}`;
const W = 1100, H = 1100;

const alive = await fetch(`${base}/viewer.html`).then((r) => r.ok).catch(() => false);
if (!alive) { console.error(`No dev server on ${PORT}.`); process.exit(2); }

fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal'] });
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 200)}`); });
await page.goto(`${base}/viewer.html`, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => window.__viewer && window.__viewer.ready === true, null, { timeout: 180000 });
await page.addStyleTag({ content: '#viewer-panel, #viewer-readout, #viewer-boot { display: none !important; }' });

const settle = async () => { await page.waitForTimeout(240); };
const plate = async (o) => { await page.evaluate((x) => window.__viewer.plate(x), o); await settle(); };
const aim = async (az, el, fill, aimY) =>
  { await page.evaluate((a) => window.__viewer.plateAim(...a), [az, el, fill, aimY]); await settle(); };
const solo = async (id) => { await page.evaluate((i) => window.__viewer.solo(i), id); await settle(); };
const shot = async (n) => page.screenshot({ path: path.join(OUT, `${n}-${TAG}.png`) });

/** Target a point and orbit it — `plateAim` can only ever centre on the man. */
const at = async (t, az, el, dist) => {
  await page.evaluate(({ t, az, el, dist }) => {
    window.__viewer.camera(0, 0, 0, t[0], t[1], t[2]);
    window.__viewer.orbit(az, el, dist);
  }, { t, az, el, dist });
  await settle();
};

const BASE = {
  unit: 'sagittarii', hash: 0.42, lod: 0, clip: 'drawBow', phase: 0.6,
  elevation: 0.05, fill: 0.86, light: 'battle', chrome: false,
};

// The bow+string assembly's centre, from the drawBow pose: grip at the left hand
// (0.104, 1.360, 0.500), nock at the right hand (-0.184, 1.453, -0.082).
const BOWC = [-0.04, 1.36, 0.21];
// The normal of the bow's own plane, so the stave is seen edge-on-to-flat rather than end-on.
const PROFILE = -1.110;

await plate(BASE);
for (const [name, az] of [['front', 0], ['left', Math.PI / 2], ['back', Math.PI], ['right', -Math.PI / 2]]) {
  await aim(az, 0.05, 0.86);
  await shot(`sweep-${name}`);
}

await aim(-0.85, 0.06, 0.86);
await shot('figure-3q');
await aim(PROFILE, 0.06, 0.86);
await shot('figure-bowplane');

// The bow alone, large, under the same light.
await solo(30);
await at(BOWC, PROFILE, 0.03, 2.3);            await shot('bow-profile');
await at(BOWC, PROFILE + Math.PI, 0.03, 2.3);  await shot('bow-profile-far');
await at(BOWC, PROFILE + 0.9, 0.16, 2.3);      await shot('bow-3q');
await at([0.05, 1.87, 0.16], PROFILE, 0.0, 0.42); await shot('bow-tip');
await solo(30);

// LOD1, the tier a man is drawn in past 45 m.
await plate({ ...BASE, lod: 1 });
await solo(30);
await at(BOWC, PROFILE, 0.03, 2.3); await shot('bow-lod1-profile');
await solo(30);

// The poses that are *not* the reference pose, which is where a baked full-draw string is
// at its worst and where the cost of it, if there is one, has to show up.
for (const clip of ['march', 'idleAlertReady']) {
  await plate({ ...BASE, lod: 0, clip, phase: 0.3 });
  await aim(-0.85, 0.06, 0.86);
  await shot(`figure-${clip}`);
}

const stats = await page.evaluate(() => window.__viewer.stats());
await browser.close();
console.log(JSON.stringify({ tag: TAG, errors, stats }, null, 1));
