#!/usr/bin/env node
/**
 * `r3-look` — one arbitrary viewer plate, from the command line, for looking at.
 *
 * `shoot-model.mjs` owns the archived plate table and should keep owning it: a round-to-round
 * comparison is only valid at a fixed camera, and a harness that lets anyone invent one is how
 * that table stops meaning anything. But a *working* pass needs the opposite — twenty angles
 * in an afternoon, none of them archived — and going through the table for that either
 * pollutes it or gets the angle wrong.
 *
 * So: same viewer, same `plate()` contract, no table, nothing written to `screenshots/`.
 *
 *   node tools/scratch/r3-look.mjs --port=5231 --unit=legio-cohort --hash=0.37 \
 *     --az=-0.6 --el=0.55 --fill=3.0 --aimY=1.66 --hour=9.4 --out=/tmp/r3/top.png
 */

import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const args = new Map(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v ?? 'true'];
}));
const n = (k, d) => Number(args.get(k) ?? d);
const PORT = n('port', 5231);
const OUT = args.get('out') ?? '/tmp/r3-look/plate.png';
const BASE = `http://127.0.0.1:${PORT}`;
const W = n('w', 900), H = n('h', 1100), DPR = n('dpr', 2);

const alive = await fetch(`${BASE}/viewer.html`).then((r) => r.ok).catch(() => false);
if (!alive) { console.error(`No dev server on ${PORT}.`); process.exit(2); }

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal'] });
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: DPR });
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
await page.goto(`${BASE}/viewer.html`, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => window.__viewer && window.__viewer.ready === true, null, { timeout: 300000 });
await page.evaluate(() => {
  for (const el of ['viewer-panel', 'viewer-readout', 'viewer-boot']) {
    const q = document.getElementById(el); if (q) q.remove();
  }
  document.body.style.margin = '0';
  const c = document.getElementById('viewer-canvas');
  if (c) { c.style.width = '100vw'; c.style.height = '100vh'; }
  window.dispatchEvent(new Event('resize'));
});

const spec = {
  unit: args.get('unit') ?? 'legio-cohort',
  hash: n('hash', 0.37),
  lod: n('lod', 0),
  clip: args.get('clip') ?? 'idleAlertReady',
  phase: n('phase', 0.32),
  azimuth: n('az', -0.6),
  elevation: n('el', 0.06),
  fill: n('fill', 3.2),
  aimY: args.has('aimY') ? n('aimY', 1.62) : undefined,
  hour: n('hour', 9.4),
  hide: (args.get('hide') ?? '').split(',').filter(Boolean),
};
const stats = await page.evaluate(async (s) => {
  const v = window.__viewer;
  v.plate({
    unit: s.unit, hash: s.hash, lod: s.lod, clip: s.clip, phase: s.phase,
    azimuth: s.azimuth, elevation: s.elevation, fill: s.fill, aimY: s.aimY,
    light: 'battle', graded: true,
  });
  v.setHour(s.hour);
  // Sixteen-frame material re-patch plus a lazy mesh build; twenty-eight is the settle
  // `shoot-model.mjs` uses under the battle rig and this is the same rig.
  for (let i = 0; i < 30; i++) await new Promise((r) => requestAnimationFrame(r));
  return v.stats();
}, spec);

await mkdir(path.dirname(path.resolve(OUT)), { recursive: true });
await writeFile(path.resolve(OUT), await page.screenshot({ type: 'png' }));
console.log(`${spec.unit} hash ${spec.hash} lod ${spec.lod} az ${spec.azimuth} el ${spec.elevation} fill ${spec.fill} hour ${spec.hour}`);
console.log(`  tris/man ${stats.trisPerMan}  draws ${stats.draws}  -> ${OUT}`);
if (errors.length) console.log(`  page errors: ${errors.slice(0, 3).join(' | ')}`);
await browser.close();
