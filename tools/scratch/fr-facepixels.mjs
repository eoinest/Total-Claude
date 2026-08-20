#!/usr/bin/env node
/**
 * `fr-facepixels` — how much of the `Mat.Face` tile a plate can actually see.
 *
 * The instrument the previous rounds used was "paint the face tile magenta and count magenta
 * pixels", and it is the right idea, but a colour threshold has to survive the tint multiply,
 * the BRDF and the grade. So this counts a **differential** instead: shoot the plate once as
 * shipped, repaint only the `Mat.Face` tile of the albedo atlas, shoot it again, and count the
 * pixels that changed. A pixel changes if and only if the face tile is visible in it. No
 * threshold on hue, no assumption about the grade, and grain is switched off so the only
 * thing that can move a pixel is the repaint.
 *
 * The magenta count is reported beside it as a cross-check; where the two disagree the
 * differential is the one to believe.
 *
 * Usage: node tools/scratch/fr-facepixels.mjs --port=5911 [--json=/tmp/x.json]
 */

import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';
import process from 'node:process';

const args = new Map(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v ?? 'true'];
}));
const PORT = Number(args.get('port') ?? 5911);
const JSON_OUT = args.get('json') ?? null;
/**
 * A constant added to every azimuth.
 *
 * The tree this is being compared against had a `framePlate` that added PI itself, so the
 * *same* azimuth argument stood the camera on opposite sides of the man on the two trees.
 * Running the old tree at `--az-offset=3.14159` puts its camera where today's puts it, which
 * separates "the lathe was inside-out" from "the deck was pointed at his back".
 */
const AZ_OFFSET = Number(args.get('az-offset') ?? 0);
const BASE = `http://127.0.0.1:${PORT}`;
const W = 900, H = 1200, DPR = 2;

/** The shipped framings, copied from `tools/shoot-model.mjs`'s `PLATES`. */
const PLATES = [
  { name: 'juth-head', unit: 'juthungi-warband', hash: 0.51, az: 0.45, el: 0.05, fill: 4.0, aimY: 1.62 },
  { name: 'legio-head', unit: 'legio-cohort', hash: 0.62, az: -0.6, el: 0.06, fill: 3.3, aimY: 1.585 },
  // Hash 0.19 is the one `shoot-model` calls out as drawing a fur cap.
  { name: 'juth-head-furcap', unit: 'juthungi-warband', hash: 0.19, az: 0.45, el: 0.05, fill: 4.0, aimY: 1.62 },
  // Controls: the same bare head from dead ahead and from dead behind. Front must dominate.
  { name: 'ctl-front', unit: 'legio-cohort', hash: 0.62, az: 0.0, el: 0.05, fill: 4.0, aimY: 1.62 },
  { name: 'ctl-back', unit: 'legio-cohort', hash: 0.62, az: Math.PI, el: 0.05, fill: 4.0, aimY: 1.62 },
];

const alive = await fetch(`${BASE}/viewer.html`).then((r) => r.ok).catch(() => false);
if (!alive) { console.error(`No dev server on ${PORT}.`); process.exit(2); }

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal'] });
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: DPR });
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(`${BASE}/viewer.html`, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => window.__viewer && window.__viewer.ready === true, null, { timeout: 300000 });
await page.evaluate(() => {
  for (const el of ['viewer-panel', 'viewer-readout', 'viewer-boot']) {
    const n = document.getElementById(el); if (n) n.remove();
  }
  document.body.style.margin = '0';
  const c = document.getElementById('viewer-canvas');
  if (c) { c.style.width = '100vw'; c.style.height = '100vh'; }
  window.dispatchEvent(new Event('resize'));
});

const out = await page.evaluate(async ({ plates }) => {
  const atlas = await import('/src/units/atlas.ts');
  const v = window.__viewer;
  const cv = document.getElementById('viewer-canvas');
  const scratch = document.createElement('canvas');
  const raf = () => new Promise((r) => requestAnimationFrame(r));
  const settle = async (n) => { for (let i = 0; i < n; i++) await raf(); };

  if (v.setGrain) v.setGrain(0);

  // The soldier's material is not exported, so take it from the renderer as it draws.
  //
  // Not by patching `WebGLRenderer.prototype.render`: in three r185 `render` is an *instance*
  // property assigned in the constructor, so the prototype has no such method and a patch
  // there silently never fires (measured: 0 calls over 40 frames). `Object3D.onBeforeRender`
  // *is* on the prototype and the renderer calls it once per draw with the material it is
  // about to use, which is both the hook that exists on every tree and the one that hands
  // over exactly the object wanted.
  const THREE = await import('/node_modules/.vite/deps/three.js');
  const maps = new Set();
  const proto = THREE.Object3D.prototype;
  const origOBR = proto.onBeforeRender;
  proto.onBeforeRender = function capture(renderer, scene, camera, geometry, material) {
    const t = material && material.map;
    if (t && t.image && t.image.width === atlas.ATLAS_W && t.image.height === atlas.ATLAS_H) maps.add(t);
    return origOBR.call(this, renderer, scene, camera, geometry, material);
  };
  await settle(8);
  proto.onBeforeRender = origOBR;
  if (!maps.size) return { error: 'no soldier atlas texture found on any drawn material' };
  const canvas = [...maps][0].image;
  const ctx = canvas.getContext('2d');

  // `Mat.Face`'s tile, in canvas pixels. Same arithmetic as `matUv`, without the inset —
  // the inset exists to stop mip bleed, and here we want the whole tile repainted.
  const TILE = 256, PER_ROW = 8;
  const col = atlas.Mat.Face % PER_ROW;
  const row = Math.floor(atlas.Mat.Face / PER_ROW);
  const tx = col * TILE, ty = row * TILE;
  const saved = ctx.getImageData(tx, ty, TILE, TILE);

  const grab = () => {
    scratch.width = cv.width; scratch.height = cv.height;
    scratch.getContext('2d').drawImage(cv, 0, 0);
    return scratch.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
  };

  const results = [];
  for (const p of plates) {
    v.plate({
      unit: p.unit, hash: p.hash, lod: 0, clip: 'idleAlertReady', phase: 0.32,
      azimuth: p.az, elevation: p.el, fill: p.fill, aimY: p.aimY, light: 'field', graded: true,
    });
    if (v.setGrain) v.setGrain(0);
    await settle(30);
    // Baseline.
    ctx.putImageData(saved, tx, ty);
    for (const t of maps) t.needsUpdate = true;
    await settle(6);
    const before = grab();
    // Repainted.
    ctx.fillStyle = '#ff00ff';
    ctx.fillRect(tx, ty, TILE, TILE);
    for (const t of maps) t.needsUpdate = true;
    await settle(6);
    const after = grab();

    let changed = 0, magenta = 0, both = 0;
    for (let i = 0; i < before.length; i += 4) {
      const d = Math.abs(after[i] - before[i]) + Math.abs(after[i + 1] - before[i + 1])
        + Math.abs(after[i + 2] - before[i + 2]);
      const ch = d > 40;
      if (ch) changed++;
      const r = after[i], g = after[i + 1], b = after[i + 2];
      const mg = r > 45 && b > 30 && g < 0.55 * Math.min(r, b);
      if (mg) magenta++;
      // The statistic. A pixel that both moved when the tile was repainted *and* came out
      // the tile's colour is a face-tile pixel and nothing else can be: a graded exposure
      // shift moves pixels without colouring them, and a magenta reflection colours them
      // without moving them.
      if (ch && mg) both++;
    }
    results.push({ name: p.name, changed, magenta, both, px: before.length / 4 });
    // Restore before moving on, so the next plate's baseline is a real baseline.
    ctx.putImageData(saved, tx, ty);
    for (const t of maps) t.needsUpdate = true;
  }
  return { results, frame: [cv.width, cv.height] };
}, { plates: PLATES.map((p) => ({ ...p, az: p.az + AZ_OFFSET })) });

await browser.close();

if (out.error) { console.error(out.error); process.exit(1); }
console.log(`\nfr-facepixels — visible \`Mat.Face\` pixels, ${out.frame[0]}x${out.frame[1]}, az-offset ${AZ_OFFSET}\n`);
console.log('plate                  FACE PX   (changed / magenta)   % of frame');
console.log('-'.repeat(72));
for (const r of out.results) {
  console.log(
    `${r.name.padEnd(20)} ${String(r.both).padStart(9)}   ${String(r.changed).padStart(8)} / ${String(r.magenta).padEnd(8)}   ` +
    `${((100 * r.both) / r.px).toFixed(2).padStart(6)} %`
  );
}
if (JSON_OUT) await writeFile(JSON_OUT, JSON.stringify(out, null, 2));
if (errors.length) console.log(`\npage errors:\n  ${[...new Set(errors)].slice(0, 6).join('\n  ')}`);
